// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
// ecdsa unused in core
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {SignatureChecker} from "@openzeppelin/contracts/utils/cryptography/SignatureChecker.sol";
import {EnumerableSet} from "@openzeppelin/contracts/utils/structs/EnumerableSet.sol";
import {IOracle} from "./IOracle.sol";
import {PerpBase} from "./PerpBase.sol";

/// @title PerpExchange (core)
/// @notice Vault, accounts, admin, funding and a selector router that delegatecalls the trading and liquidation
///         modules (split only to fit the 24 KB code-size limit). Module registry is admin-controlled until
///         `lockModules()`; after locking, logic is immutable. UNAUDITED.
contract PerpExchange is PerpBase {
    using SafeERC20 for IERC20;
    using EnumerableSet for EnumerableSet.UintSet;

    mapping(bytes4 => address) public moduleOf;
    bool public modulesLocked;

    constructor(IERC20 _usdc, IOracle _oracle, address admin) {
        require(IERC20Metadata6(address(_usdc)).decimals() == 6, "USDC must be 6 decimals");
        usdc = _usdc;
        oracle = _oracle;
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        acctOwner[BACKSTOP] = address(this);
    }

    function registerModule(address module, bytes4[] calldata selectors) external onlyRole(DEFAULT_ADMIN_ROLE) {
        require(!modulesLocked, "locked");
        require(module.code.length > 0, "not a contract");
        for (uint256 i; i < selectors.length; i++) moduleOf[selectors[i]] = module;
    }

    /// @notice Irreversibly freezes the selector->module table.
    function lockModules() external onlyRole(DEFAULT_ADMIN_ROLE) { modulesLocked = true; }

    fallback() external {
        address m = moduleOf[msg.sig];
        require(m != address(0), "unknown selector");
        assembly {
            calldatacopy(0, 0, calldatasize())
            let ok := delegatecall(gas(), m, 0, calldatasize(), 0, 0)
            returndatacopy(0, 0, returndatasize())
            switch ok case 0 { revert(0, returndatasize()) } default { return(0, returndatasize()) }
        }
    }

    /// @notice Trading-only session key. Agents can trade/cancel but can never withdraw or transfer.
    function approveAgent(uint8 sub, address agent, uint64 expiry) external {
        bytes32 a = _register(msg.sender, sub);
        agentExpiry[a][agent] = expiry;
        delete agentScope[a][agent]; // unscoped (any market/size, still never withdraw)
        emit AgentApproved(a, agent, expiry);
    }

    /// @notice Session key limited to a set of markets (bit i = market i) and a max notional per order/conditional/TWAP.
    function approveAgentScoped(uint8 sub, address agent, uint64 expiry, uint64 marketMask, uint128 maxOrderNotional) external {
        bytes32 a = _register(msg.sender, sub);
        agentExpiry[a][agent] = expiry;
        agentScope[a][agent] = AgentScope(true, marketMask, maxOrderNotional);
        emit AgentApproved(a, agent, expiry);
    }

    function revokeAgent(uint8 sub, address agent) external {
        bytes32 a = acctKey(msg.sender, sub);
        agentExpiry[a][agent] = 0;
        delete agentScope[a][agent];
        emit AgentApproved(a, agent, 0);
    }

    // ================================================================== collateral
    function deposit(address owner, uint8 sub, uint256 amount) external nonReentrant {
        if (amount == 0) revert BadParam("amount");
        bytes32 a = _register(owner, sub);
        uint256 before_ = usdc.balanceOf(address(this));
        usdc.safeTransferFrom(msg.sender, address(this), amount);
        if (usdc.balanceOf(address(this)) - before_ != amount) revert BadParam("fee-on-transfer unsupported");
        collateral[a] += int256(amount);
        principal[a] += amount;
        totalDeposited += amount;
        emit Deposit(a, msg.sender, amount);
    }

    /// @dev withdrawable = min(collateral, equity) - initialMargin - reservedOrderMargin
    function withdrawable(bytes32 a) public view returns (uint256) {
        (int256 eq, uint256 im,) = _risk(a);
        int256 base = collateral[a] < eq ? collateral[a] : eq;
        int256 av = base - int256(im) - int256(reserved[a]);
        return av > 0 ? uint256(av) : 0;
    }

    function withdraw(uint8 sub, uint256 amount) external nonReentrant {
        bytes32 a = acctKey(msg.sender, sub); // owner only: agents cannot withdraw
        _settleAll(a);
        _requireMarketsOpenForWithdraw(a);
        _syncBackstop(); // record backstop deficits BEFORE any USDC leaves the vault
        if (amount > withdrawable(a)) revert Unhealthy();
        // withdrawal limiter: while recorded bad debt exceeds the threshold only deposited principal may leave (never earned profit)
        uint256 pr = principal[a];
        if (unresolvedBadDebt > wdGateThreshold && amount > pr) revert WithdrawGated();
        principal[a] = pr > amount ? pr - amount : 0;
        collateral[a] -= int256(amount);
        totalWithdrawn += amount;
        usdc.safeTransfer(msg.sender, amount);
        emit Withdraw(a, amount);
    }

    function transferInternal(uint8 fromSub, uint8 toSub, uint256 amount) external nonReentrant {
        bytes32 f = acctKey(msg.sender, fromSub);
        bytes32 t = _register(msg.sender, toSub);
        _settleAll(f);
        _requireMarketsOpenForWithdraw(f);
        if (amount > withdrawable(f)) revert Unhealthy();
        collateral[f] -= int256(amount);
        collateral[t] += int256(amount);
        { uint256 pr = principal[f]; uint256 mv = pr < amount ? pr : amount; principal[f] = pr - mv; principal[t] += mv; } // principal follows the funds
        emit InternalTransfer(f, t, amount);
    }

    function _requireMarketsOpenForWithdraw(bytes32 a) internal view {
        for (uint8 m = 0; m < marketCount; m++) {
            if (positions[a][m].size != 0) {
                State s = markets[m].state;
                if (s == State.Paused || s == State.OracleDegraded) revert MarketRestricted();
            }
        }
    }

    /// @notice Anyone may donate to the insurance fund.
    function fundInsurance(uint256 amount) external nonReentrant {
        uint256 b = usdc.balanceOf(address(this));
        usdc.safeTransferFrom(msg.sender, address(this), amount);
        if (usdc.balanceOf(address(this)) - b != amount) revert BadParam("fee-on-transfer unsupported");
        insurance += amount;
        totalDeposited += amount;
    }

    // ================================================================== admin
    struct MarketConfig {
        bytes32 feed; uint64 tick; uint64 lot; uint64 minNotional; uint128 maxOrderSize; uint128 maxOI;
        uint32 maxAge; uint32 bandBps; uint32 maxSpreadBps; uint32 fundingInterval; uint32 premiumDivisor; uint64 fundingCap;
    }

    function createMarket(MarketConfig calldata c, Tier[] calldata tiers) external onlyRole(DEFAULT_ADMIN_ROLE) returns (uint8 id) {
        require(marketCount < MAX_MARKETS, "max markets");
        require(c.tick > 0 && c.lot > 0 && c.fundingInterval > 0 && c.premiumDivisor > 0, "bad cfg");
        require(tiers.length > 0 && tiers.length <= 4, "tiers");
        id = marketCount++;
        Market storage M = markets[id];
        M.exists = true;
        M.feed = c.feed; M.tick = c.tick; M.lot = c.lot; M.minNotional = c.minNotional;
        M.maxOrderSize = c.maxOrderSize; M.maxOI = c.maxOI; M.maxAge = c.maxAge; M.bandBps = c.bandBps;
        M.maxSpreadBps = c.maxSpreadBps; M.fundingInterval = c.fundingInterval; M.premiumDivisor = c.premiumDivisor;
        M.fundingCap = c.fundingCap;
        M.lastFunding = uint64(block.timestamp);
        M.lastSample = uint64(block.timestamp);
        uint128 prev;
        for (uint256 i; i < tiers.length; i++) {
            require(tiers[i].upToNotional > prev && tiers[i].mmrBps <= tiers[i].imrBps && tiers[i].imrBps <= BPS, "tier order");
            prev = tiers[i].upToNotional;
            M.tiers.push(tiers[i]);
        }
        require(tiers[tiers.length - 1].upToNotional == type(uint128).max, "last tier unbounded");
    }

    /// @dev Admin (timelock) may set any state. Guardian may only restrict (never return to Normal).
    function setMarketState(uint8 m, State s) external {
        if (hasRole(DEFAULT_ADMIN_ROLE, msg.sender)) {} else {
            if (!hasRole(GUARDIAN_ROLE, msg.sender)) revert NotAuthorized();
            if (s == State.Normal || s == State.Recovery) revert NotAuthorized();
        }
        markets[m].state = s;
        emit MarketState(m, s);
    }

    function setGlobalPause(bool p) external {
        if (p) { if (!hasRole(GUARDIAN_ROLE, msg.sender) && !hasRole(DEFAULT_ADMIN_ROLE, msg.sender)) revert NotAuthorized(); }
        else _checkRole(DEFAULT_ADMIN_ROLE);
        globalPaused = p;
    }

    function setFees(uint32 taker, int32 maker, uint32 liq, uint32 keeperShare, uint32 closeFactor, uint64 fullClose) external onlyRole(DEFAULT_ADMIN_ROLE) {
        require(taker <= 100 && liq <= 500 && keeperShare <= BPS && closeFactor > 0 && closeFactor <= BPS, "bounds");
        require(maker >= -int32(taker) && maker <= int32(taker), "maker bounds");
        takerFeeBps = taker; makerFeeBps = maker; liqFeeBps = liq; keeperShareBps = keeperShare;
        closeFactorBps = closeFactor; fullCloseNotional = fullClose;
    }

    function setAdlMaxPremBps(uint32 bps) external onlyRole(DEFAULT_ADMIN_ROLE) { require(bps <= BPS && bps <= adlHardPremBps, "bounds"); adlMaxPremBps = bps; }

    event AdlHardPremSet(uint32 bps);
    event WithdrawGateSet(uint256 threshold);

    /// @notice ADL premium ceiling (bps of mark) used while backstop-originated debt is outstanding. Must be >= adlMaxPremBps and <= 10000.
    ///         Admin (timelock) may set any value in bounds; the guardian may only LOWER it (down to adlMaxPremBps).
    function setAdlHardPremBps(uint32 bps) external {
        if (!hasRole(DEFAULT_ADMIN_ROLE, msg.sender)) {
            if (!hasRole(GUARDIAN_ROLE, msg.sender) || bps >= adlHardPremBps) revert NotAuthorized();
        }
        require(bps <= BPS && bps >= adlMaxPremBps, "bounds");
        adlHardPremBps = bps;
        emit AdlHardPremSet(bps);
    }

    /// @notice Withdrawal limiter threshold (1e6 USDC): while unresolvedBadDebt > threshold, withdrawals are limited to each account's
    ///         deposited principal. Admin may set any value (type(uint256).max disables it); the guardian may only LOWER it (tighten).
    function setWithdrawGate(uint256 threshold) external {
        if (!hasRole(DEFAULT_ADMIN_ROLE, msg.sender)) {
            if (!hasRole(GUARDIAN_ROLE, msg.sender) || threshold >= wdGateThreshold) revert NotAuthorized();
        }
        wdGateThreshold = threshold;
        emit WithdrawGateSet(threshold);
    }

    event MarketDelisted(uint8 indexed market, uint64 settlePrice);
    event MarketParams(uint8 indexed market);

    /// @notice Final step of the delisting workflow (docs/MARKET_LAUNCH.md): market MUST already be ReduceOnly.
    ///         Freezes the mark at `settlePrice`; accounts then call settleDelisted. Intended to sit behind the timelock.
    function delistMarket(uint8 m, uint64 settlePrice) external onlyRole(DEFAULT_ADMIN_ROLE) {
        Market storage M = markets[m];
        require(M.exists && M.state == State.ReduceOnly && settlePrice > 0, "must be reduce-only");
        M.state = State.Delisted;
        M.settlePrice = settlePrice;
        emit MarketDelisted(m, settlePrice);
        emit MarketState(m, State.Delisted);
    }

    /// @notice Per-market risk/limit update with bounds (does not touch tick/lot/feed). Intended to sit behind the timelock.
    function setMarketParams(uint8 m, uint128 maxOrderSize, uint128 maxOI, uint64 minNotional, uint32 maxAge, uint32 bandBps, uint32 maxSpreadBps, uint64 fundingCap)
        external onlyRole(DEFAULT_ADMIN_ROLE)
    {
        Market storage M = markets[m];
        require(M.exists && maxAge >= 5 && bandBps <= 2000 && maxSpreadBps <= 1000 && fundingCap <= 5e9, "bounds");
        M.maxOrderSize = maxOrderSize; M.maxOI = maxOI; M.minNotional = minNotional; M.maxAge = maxAge;
        M.bandBps = bandBps; M.maxSpreadBps = maxSpreadBps; M.fundingCap = fundingCap;
        emit MarketParams(m);
    }

    /// @notice Replace risk tiers. Tightening can make accounts instantly liquidatable: use the timelock + announce first.
    function setTiers(uint8 m, Tier[] calldata tiers) external onlyRole(DEFAULT_ADMIN_ROLE) {
        Market storage M = markets[m];
        require(M.exists && tiers.length > 0 && tiers.length <= 4, "tiers");
        delete M.tiers;
        uint128 prev;
        for (uint256 i; i < tiers.length; i++) {
            require(tiers[i].upToNotional > prev && tiers[i].mmrBps <= tiers[i].imrBps && tiers[i].imrBps <= BPS, "tier order");
            prev = tiers[i].upToNotional;
            M.tiers.push(tiers[i]);
        }
        require(prev == type(uint128).max, "last tier unbounded");
        emit MarketParams(m);
    }

    function setOracle(IOracle o) external onlyRole(DEFAULT_ADMIN_ROLE) { oracle = o; }

    /// @notice Move USDC accounting between insurance and the backstop account (governed).
    function rebalanceBackstop(int256 amount) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (amount >= 0) { require(uint256(amount) <= insurance, "insurance"); insurance -= uint256(amount); collateral[BACKSTOP] += amount; }
        else { require(collateral[BACKSTOP] >= -amount, "backstop"); collateral[BACKSTOP] += amount; insurance += uint256(-amount); }
    }

    function accountState(bytes32 a) external view returns (int256 equity, uint256 im, uint256 mm, uint256 resv, uint256 avail) {
        (equity, im, mm) = _risk(a);
        resv = reserved[a];
        avail = withdrawable(a);
    }

    /// @notice Permissionless keeper hook: time-weighted premium sampling + funding index advance.
    ///         Missed intervals are applied in one step at the sampled average (documented). Paused markets are not sampled.
    function pokeFunding(uint8 m) external {
        Market storage M = markets[m];
        require(M.exists, "market");
        uint256 nowT = block.timestamp;
        uint256 dt = nowT - M.lastSample;
        if (M.state == State.Paused || M.state == State.Delisted) { M.lastSample = uint64(nowT); M.lastPremiumValid = false; }
        else {
            if (M.lastPremiumValid && dt > 0) { M.premiumIntegral += M.lastPremium * int256(dt); M.sampledTime += dt; }
            (uint256 idx, bool ok) = _index(m);
            if (ok) {
                uint256 mk = _markFrom(m, idx);
                M.lastPremium = (int256(mk) - int256(idx)) * int256(RATE_SCALE) / int256(idx);
                M.lastPremiumValid = true;
                M.lastIndexPrice = idx;
            } else { M.lastPremiumValid = false; }
            M.lastSample = uint64(nowT);
        }
        uint256 n = (nowT - M.lastFunding) / M.fundingInterval;
        if (n > 0) {
            int256 rate;
            if (M.sampledTime > 0 && M.lastIndexPrice > 0) {
                rate = M.premiumIntegral / int256(M.sampledTime) / int256(uint256(M.premiumDivisor));
                int256 cap = int256(uint256(M.fundingCap));
                rate = rate > cap ? cap : (rate < -cap ? -cap : rate);
                M.fundingIndex += int256(n) * (rate * int256(M.lastIndexPrice) / 1e6);
            }
            M.lastFunding += uint64(n * M.fundingInterval);
            M.premiumIntegral = 0;
            M.sampledTime = 0;
            emit FundingUpdated(m, n, rate, M.fundingIndex);
        }
    }

    function estimatedFundingRate(uint8 m) external view returns (int256) {
        Market storage M = markets[m];
        if (M.sampledTime == 0) return 0;
        return M.premiumIntegral / int256(M.sampledTime) / int256(uint256(M.premiumDivisor));
    }

    // ================================================================== isolated margin
    event IsolatedMode(bytes32 indexed acct, uint8 indexed market, bool on);
    event IsoMargin(bytes32 indexed acct, uint8 indexed market, int256 delta);

    /// @notice Switch a market between cross and isolated for this subaccount. Only when the position is flat, no orders
    ///         rest in that market, and (when returning to cross) no isolated margin remains.
    function setIsolated(uint8 sub, uint8 market, bool on) external {
        bytes32 a = _register(msg.sender, sub);
        Position storage p = positions[a][market];
        if (!markets[market].exists) revert BadParam("market");
        if (p.size != 0 || p.isoReserved != 0) revert BadParam("position/orders open");
        if (!on && p.isoMargin != 0) revert BadParam("remove isolated margin first");
        uint256[] memory ids = openOrders[a].values();
        for (uint256 i; i < ids.length; i++) if (orders[uint64(ids[i])].market == market) revert BadParam("cancel orders first");
        p.isolated = on;
        emit IsolatedMode(a, market, on);
    }

    /// @notice Move free cross collateral into an isolated position's margin (owner only; agents cannot move collateral).
    function addIsoMargin(uint8 sub, uint8 market, uint256 amount) external nonReentrant {
        bytes32 a = acctKey(msg.sender, sub);
        if (!positions[a][market].isolated) revert BadParam("not isolated");
        _settleAll(a);
        if (amount == 0 || amount > withdrawable(a)) revert Unhealthy();
        collateral[a] -= int256(amount);
        positions[a][market].isoMargin += int256(amount);
        emit IsoMargin(a, market, int256(amount));
    }

    /// @notice Return isolated margin to cross collateral, only down to IM + order reserve (unrealized profit not counted).
    function removeIsoMargin(uint8 sub, uint8 market, uint256 amount) external nonReentrant {
        bytes32 a = acctKey(msg.sender, sub);
        Position storage p = positions[a][market];
        if (!p.isolated) revert BadParam("not isolated");
        _settleMarket(a, market);
        (int256 eq, uint256 im,) = _isoRisk(a, market);
        int256 base = p.isoMargin < eq ? p.isoMargin : eq;
        if (amount == 0 || int256(amount) > base - int256(im) - int256(p.isoReserved)) revert Unhealthy();
        p.isoMargin -= int256(amount);
        collateral[a] += int256(amount);
        emit IsoMargin(a, market, -int256(amount));
    }

    function isoState(bytes32 a, uint8 market) external view returns (bool isolated, int256 margin, int256 equity, uint256 im, uint256 mm, uint256 resv) {
        Position storage p = positions[a][market];
        isolated = p.isolated; margin = p.isoMargin; resv = p.isoReserved;
        (equity, im, mm) = _isoRisk(a, market);
    }

    /// @notice Reconciliation: (sum of tracked buckets, net deposits). Equal up to dust when all accounts are settled.
    function ledgerTotals(bytes32[] calldata accts) external view returns (int256 tracked, int256 netDeposits) {
        int256 c;
        for (uint256 i; i < accts.length; i++) {
            c += collateral[accts[i]];
            for (uint8 m = 0; m < marketCount; m++) c += positions[accts[i]][m].isoMargin; // isolated buckets are part of the ledger
        }
        c += collateral[BACKSTOP];
        tracked = c + int256(insurance) + feePool + fundingPool - int256(unresolvedBadDebt) + int256(dustBasis / BASIS_SCALE);
        netDeposits = int256(totalDeposited) - int256(totalWithdrawn);
    }}

interface IERC20Metadata6 { function decimals() external view returns (uint8); }
