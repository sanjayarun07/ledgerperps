// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

interface IPerpVaultTarget {
    function deposit(address owner, uint8 sub, uint256 amount) external;
    function withdraw(uint8 sub, uint256 amount) external;
    function withdrawable(bytes32 acct) external view returns (uint256);
    function accountState(bytes32 acct) external view returns (int256 equity, uint256 im, uint256 mm, uint256 resv, uint256 avail);
    function acctKey(address owner, uint8 sub) external pure returns (bytes32);
    function approveAgentScoped(uint8 sub, address agent, uint64 expiry, uint64 marketMask, uint128 maxOrderNotional) external;
    function revokeAgent(uint8 sub, address agent) external;
}

/// @title MarketMakerVault (SIMULATED-LIQUIDITY TESTNET PRODUCT, UNAUDITED)
/// @notice A pooled market-making account. Depositors hold ERC-20 shares; the vault's USDC sits as collateral in ONE exchange
///         sub-account that the vault contract owns, and a protocol-run operator bot quotes from it using a scoped session key
///         (an "agent"): it can place and cancel orders but can never withdraw or transfer, and it is limited to a set of
///         markets and a maximum order notional. Share price = vault equity on the exchange / shares.
///
/// TRUST MODEL (read before depositing): this is NOT trustless market making. The operator can trade the account badly inside its
/// scope, or trade against an accomplice at bad prices, and depositors bear that loss. The scope, the lock period and the admin's
/// ability to revoke the operator limit the damage; they do not remove it. Share price uses the exchange's mark-based equity, so a
/// mark that is pushed inside its oracle band moves NAV; the lock period and deposit cap exist to make exploiting that expensive.
contract MarketMakerVault is ERC20, AccessControl, ReentrancyGuard {
    using SafeERC20 for IERC20;

    bytes32 public constant GUARDIAN_ROLE = keccak256("VAULT.GUARDIAN");
    uint256 public constant MAX_LOCK = 7 days;
    uint256 private constant VIRTUAL_SHARES = 1e6; // inflation-attack guard (virtual 1 share / 1 asset unit scaled), as in OZ ERC-4626
    uint256 private constant VIRTUAL_ASSETS = 1;

    IERC20 public immutable asset;
    IPerpVaultTarget public immutable exchange;
    uint8 public immutable sub;
    bytes32 public immutable acct;

    uint256 public depositCap;     // max totalAssets after a deposit (USDC, 6 decimals)
    uint256 public lockSeconds;    // shares cannot be redeemed until this long after the holder last received shares by deposit
    bool public depositsPaused;
    address public operator;       // current operator agent key (informational; scope is enforced by the exchange)

    mapping(address => uint256) public lastDeposit;

    event Deposited(address indexed caller, address indexed receiver, uint256 assets, uint256 shares);
    event Redeemed(address indexed caller, address indexed receiver, address indexed owner, uint256 assets, uint256 shares);
    event OperatorSet(address indexed operator, uint64 expiry, uint64 marketMask, uint128 maxOrderNotional);
    event OperatorRevoked(address indexed operator);
    event ParamsSet(uint256 depositCap, uint256 lockSeconds);
    event DepositsPaused(bool paused);

    error Locked(uint256 unlocksAt);
    error CapExceeded();
    error Paused();
    error Impaired();
    error InsufficientLiquidity(uint256 wanted, uint256 available);
    error Slippage();
    error ZeroAmount();

    constructor(IERC20 usdc, IPerpVaultTarget ex, uint8 sub_, address admin, uint256 cap, uint256 lockSecs)
        ERC20("Ledgerline Market-Making Vault (testnet)", "LLMM")
    {
        require(lockSecs <= MAX_LOCK, "lock");
        asset = usdc; exchange = ex; sub = sub_;
        acct = ex.acctKey(address(this), sub_);
        depositCap = cap; lockSeconds = lockSecs;
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(GUARDIAN_ROLE, admin);
        usdc.forceApprove(address(ex), type(uint256).max);
        emit ParamsSet(cap, lockSecs);
    }

    function decimals() public pure override returns (uint8) { return 12; } // USDC 6 + 6 offset bits of share precision

    // ------------------------------------------------------------------ accounting
    /// @notice Vault NAV in USDC: idle USDC plus exchange equity (collateral + unrealised PnL - funding), floored at zero.
    function totalAssets() public view returns (uint256) {
        (int256 eq,,,,) = exchange.accountState(acct);
        return asset.balanceOf(address(this)) + (eq > 0 ? uint256(eq) : 0);
    }

    function convertToShares(uint256 assets) public view returns (uint256) {
        return assets * (totalSupply() + VIRTUAL_SHARES) / (totalAssets() + VIRTUAL_ASSETS);
    }

    function convertToAssets(uint256 shares) public view returns (uint256) {
        return shares * (totalAssets() + VIRTUAL_ASSETS) / (totalSupply() + VIRTUAL_SHARES);
    }

    /// @notice USDC that can leave the vault right now: idle plus what the exchange lets this sub-account withdraw (free margin).
    function liquidAssets() public view returns (uint256) {
        return asset.balanceOf(address(this)) + exchange.withdrawable(acct);
    }

    function maxDeposit(address) public view returns (uint256) {
        if (depositsPaused) return 0;
        uint256 ta = totalAssets();
        return ta >= depositCap ? 0 : depositCap - ta;
    }

    /// @notice Shares `owner` could redeem now: their balance, capped by free liquidity, and zero while locked.
    function maxRedeem(address owner) public view returns (uint256) {
        if (block.timestamp < lastDeposit[owner] + lockSeconds) return 0;
        uint256 bal = balanceOf(owner);
        uint256 liq = liquidAssets();
        uint256 byLiq = convertToSharesRoundUp(liq);
        return bal < byLiq ? bal : byLiq;
    }

    function convertToSharesRoundUp(uint256 assets) internal view returns (uint256) {
        // largest share amount whose assets value is <= `assets` (round down)
        return assets * (totalSupply() + VIRTUAL_SHARES) / (totalAssets() + VIRTUAL_ASSETS);
    }

    // ------------------------------------------------------------------ deposit / redeem
    function deposit(uint256 assets, address receiver, uint256 minShares) external nonReentrant returns (uint256 shares) {
        if (assets == 0) revert ZeroAmount();
        if (depositsPaused) revert Paused();
        uint256 ta = totalAssets();
        if (totalSupply() > 0 && ta == 0) revert Impaired(); // equity wiped out: new money would be minted against nothing
        if (ta + assets > depositCap) revert CapExceeded();
        shares = assets * (totalSupply() + VIRTUAL_SHARES) / (ta + VIRTUAL_ASSETS);
        if (shares == 0 || shares < minShares) revert Slippage();
        asset.safeTransferFrom(msg.sender, address(this), assets);
        _mint(receiver, shares);
        lastDeposit[receiver] = block.timestamp;
        exchange.deposit(address(this), sub, assets); // all new money goes to work as exchange collateral
        emit Deposited(msg.sender, receiver, assets, shares);
    }

    function redeem(uint256 shares, address receiver, address owner_, uint256 minAssets) external nonReentrant returns (uint256 assets) {
        if (shares == 0) revert ZeroAmount();
        uint256 unlock = lastDeposit[owner_] + lockSeconds;
        if (block.timestamp < unlock) revert Locked(unlock);
        if (msg.sender != owner_) _spendAllowance(owner_, msg.sender, shares);
        assets = convertToAssets(shares); // round down: the vault never over-pays
        if (assets < minAssets) revert Slippage();
        _burn(owner_, shares);
        uint256 idle = asset.balanceOf(address(this));
        if (assets > idle) {
            uint256 need = assets - idle; uint256 free = exchange.withdrawable(acct);
            if (need > free) revert InsufficientLiquidity(assets, idle + free);
            exchange.withdraw(sub, need);
        }
        asset.safeTransfer(receiver, assets);
        emit Redeemed(msg.sender, receiver, owner_, assets, shares);
    }

    /// @notice Anyone can push USDC that sits idle in the vault (direct transfers) onto the exchange as collateral.
    function pushIdle() external nonReentrant {
        uint256 idle = asset.balanceOf(address(this));
        if (idle > 0) exchange.deposit(address(this), sub, idle);
    }

    // ------------------------------------------------------------------ operator (scoped agent key)
    /// @notice Authorise the operator bot's key to place/cancel on the vault account. It can never withdraw or transfer.
    function setOperator(address agent, uint64 expiry, uint64 marketMask, uint128 maxOrderNotional) external onlyRole(DEFAULT_ADMIN_ROLE) {
        require(agent != address(0) && expiry > block.timestamp && marketMask != 0 && maxOrderNotional != 0, "bad operator");
        if (operator != address(0) && operator != agent) { exchange.revokeAgent(sub, operator); emit OperatorRevoked(operator); }
        operator = agent;
        exchange.approveAgentScoped(sub, agent, expiry, marketMask, maxOrderNotional);
        emit OperatorSet(agent, expiry, marketMask, maxOrderNotional);
    }

    /// @notice Guardian or admin can cut off the operator immediately (it can still be re-enabled by the admin).
    function revokeOperator() external {
        if (!hasRole(GUARDIAN_ROLE, msg.sender) && !hasRole(DEFAULT_ADMIN_ROLE, msg.sender)) revert AccessControlUnauthorizedAccount(msg.sender, GUARDIAN_ROLE);
        address op = operator; require(op != address(0), "no operator");
        operator = address(0);
        exchange.revokeAgent(sub, op);
        emit OperatorRevoked(op);
    }

    // ------------------------------------------------------------------ admin
    function setParams(uint256 cap, uint256 lockSecs) external onlyRole(DEFAULT_ADMIN_ROLE) {
        require(lockSecs <= MAX_LOCK, "lock");
        depositCap = cap; lockSeconds = lockSecs;
        emit ParamsSet(cap, lockSecs);
    }

    /// @notice Pausing blocks new deposits only. Redemptions are never blocked by the vault.
    function setDepositsPaused(bool p) external onlyRole(GUARDIAN_ROLE) { depositsPaused = p; emit DepositsPaused(p); }

    // ------------------------------------------------------------------ share transfers
    /// @dev A receiver inherits the later of the two lock start times, so transferring shares cannot be used to skip the lock.
    function _update(address from, address to, uint256 value) internal override {
        if (from != address(0) && to != address(0) && lastDeposit[from] > lastDeposit[to]) lastDeposit[to] = lastDeposit[from];
        super._update(from, to, value);
    }
}
