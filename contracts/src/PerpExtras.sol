// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {SignatureChecker} from "@openzeppelin/contracts/utils/cryptography/SignatureChecker.sol";
import {EnumerableSet} from "@openzeppelin/contracts/utils/structs/EnumerableSet.sol";
import {IOracle} from "./IOracle.sol";
import {PerpBase} from "./PerpBase.sol";

interface IPlacer {
    function placeFor(bytes32 a, PerpBase.OrderParams calldata p) external returns (uint64 id, uint128 filled);
}

/// @notice Relayed (EIP-712/1271) orders and conditional orders. Executed ONLY via delegatecall from PerpExchange.
contract PerpExtras is PerpBase {
    using EnumerableSet for EnumerableSet.UintSet;

    /// @notice (moved from PerpTrading to stay under EIP-170; selector unchanged) Backstop operator order.
    function backstopPlace(OrderParams calldata p) external nonReentrant onlyRole(BACKSTOP_ROLE) returns (uint64 id, uint128 filled) {
        return IPlacer(address(this)).placeFor(BACKSTOP, p);
    }

    /// @notice (moved from PerpTrading; selector unchanged) Atomic cancel + new order. The new order ALWAYS takes a fresh queue position.
    function replaceOrder(uint64 oldId, OrderParams calldata p) external nonReentrant returns (uint64 id, uint128 filled) {
        Order storage o = orders[oldId];
        if (o.size == 0) revert BadParam("no order");
        _authTrade(o.acct);
        bytes32 a = o.acct;
        _remove(oldId, CancelReason.Replaced);
        return IPlacer(address(this)).placeFor(a, p);
    }

    /// @notice Relayed EIP-712 order. Signer must be the owner (EOA or EIP-1271 wallet) or an unexpired agent key.
    function placeSigned(address owner, uint8 sub, OrderParams calldata p, uint256 nonce, uint256 deadline, bytes calldata sig)
        external nonReentrant returns (uint64 id, uint128 filled)
    {
        if (block.timestamp > deadline) revert Expired();
        if (nonceUsed[owner][nonce]) revert BadParam("nonce used");
        bytes32 digest = _hashTypedDataV4(keccak256(abi.encode(
            ORDER_TYPEHASH, owner, sub, p.market, p.isBuy, p.price, p.size, uint8(p.tif), p.reduceOnly, p.cloid, p.expiry, nonce, deadline
        )));
        bytes32 a = _register(owner, sub);
        (bool ok, address signer) = _signedBy(owner, a, digest, sig);
        if (!ok) revert NotAuthorized();
        if (signer != owner) _checkScope(a, signer, p.market, p.size, p.price);
        nonceUsed[owner][nonce] = true;
        return IPlacer(address(this)).placeFor(a, p);
    }

    /// @dev Owner (EOA or EIP-1271 wallet) or unexpired agent key. Returns the effective signer.
    function _signedBy(address owner, bytes32 a, bytes32 digest, bytes calldata sig) internal view returns (bool ok, address signer) {
        if (SignatureChecker.isValidSignatureNow(owner, digest, sig)) return (true, owner);
        ECDSA.RecoverError err;
        (signer, err,) = ECDSA.tryRecover(digest, sig);
        ok = err == ECDSA.RecoverError.NoError && agentExpiry[a][signer] > block.timestamp;
    }

    bytes32 constant CANCEL_TYPEHASH = keccak256("CancelAction(address owner,uint8 sub,uint64 orderId,uint256 nonce,uint256 deadline)");

    /// @notice Relayed EIP-712 cancel so relayers/keepers can cancel on a user's behalf with the user's signature.
    function cancelSigned(address owner, uint8 sub, uint64 orderId, uint256 nonce, uint256 deadline, bytes calldata sig) external nonReentrant {
        if (block.timestamp > deadline) revert Expired();
        if (nonceUsed[owner][nonce]) revert BadParam("nonce used");
        bytes32 a = acctKey(owner, sub);
        bytes32 digest = _hashTypedDataV4(keccak256(abi.encode(CANCEL_TYPEHASH, owner, sub, orderId, nonce, deadline)));
        (bool ok,) = _signedBy(owner, a, digest, sig);
        if (!ok) revert NotAuthorized();
        if (orders[orderId].acct != a || orders[orderId].size == 0) revert BadParam("no order");
        nonceUsed[owner][nonce] = true;
        _remove(orderId, CancelReason.User);
    }

    // ================================================================== conditional orders (TP/SL, brackets)
    /// @dev Conditional orders are NOT resting book orders. They live in contract storage and are triggered by anyone
    ///      once the on-chain MARK price crosses the trigger; they then execute as IOC through the normal margin path.
    function placeConditional(address owner, uint8 sub, uint8 market, bool isBuy, bool above, uint64 trigger, uint64 limit, uint128 size, bool reduceOnly)
        external nonReentrant returns (uint64 id)
    {
        bytes32 a = _register(owner, sub);
        _authTradeScoped(a, market, size, limit);
        return _newCond(a, market, isBuy, above, trigger, limit, size, reduceOnly, 0);
    }

    function _newCond(bytes32 a, uint8 market, bool isBuy, bool above, uint64 trigger, uint64 limit, uint128 size, bool ro, uint64 sib)
        internal returns (uint64 id)
    {
        Market storage M = markets[market];
        if (!M.exists || trigger == 0 || limit == 0 || size == 0 || size % M.lot != 0 || limit % M.tick != 0) revert BadParam("cond");
        if (++condCount[a] > MAX_CONDITIONALS) revert TooManyOrders();
        id = nextCondId++;
        conds[id] = Cond(a, size, trigger, limit, sib, market, isBuy, above, ro, true);
        emit CondPlaced(id, a, market, isBuy, above, trigger, limit, size, ro, sib);
    }

    /// @notice TP + SL for the current position, linked OCO: triggering one cancels the other.
    function placeBracket(address owner, uint8 sub, uint8 market, uint64 tpTrigger, uint64 tpLimit, uint64 slTrigger, uint64 slLimit, uint128 size)
        external nonReentrant returns (uint64 tpId, uint64 slId)
    {
        bytes32 a = _register(owner, sub);
        _authTradeScoped(a, market, size, tpLimit > slLimit ? tpLimit : slLimit);
        int256 pos = positions[a][market].size;
        if (pos == 0) revert ReduceOnlyViolation();
        bool isLong = pos > 0;
        tpId = _newCond(a, market, !isLong, isLong, tpTrigger, tpLimit, size, true, 0);
        slId = _newCond(a, market, !isLong, !isLong, slTrigger, slLimit, size, true, tpId);
        conds[tpId].sibling = slId;
    }

    function cancelConditional(uint64 id) external nonReentrant {
        Cond storage c = conds[id];
        if (!c.active) revert BadParam("inactive");
        _authTrade(c.acct);
        _dropCond(id);
    }

    function _dropCond(uint64 id) internal {
        Cond storage c = conds[id];
        condCount[c.acct]--;
        delete conds[id];
        emit CondCanceled(id);
    }

    /// @notice Permissionless. Fires if the mark crosses the trigger; consumed even if nothing fills (IOC semantics).
    function executeConditional(uint64 id) external nonReentrant {
        Cond memory c = conds[id];
        if (!c.active) revert BadParam("inactive");
        uint256 mk = markPrice(c.market);
        if (c.above ? mk < c.trigger : mk > c.trigger) revert BadParam("not triggered");
        uint64 sib = c.sibling;
        _dropCond(id);
        if (sib != 0 && conds[sib].active) _dropCond(sib);
        emit CondTriggered(id, uint64(mk));
        int256 pos = positions[c.acct][c.market].size;
        bool reducing = (c.isBuy && pos < 0) || (!c.isBuy && pos > 0);
        if (c.reduceOnly && !reducing) return; // invalidated reduce-only: dropped without execution
        OrderParams memory p = OrderParams(c.market, c.isBuy, c.limit, c.size, TIF.IOC, c.reduceOnly, 0, 0);
        IPlacer(address(this)).placeFor(c.acct, p);
    }

    // ------------------------------------------------------------------ cancel
    function cancelOrder(uint64 id) external nonReentrant {
        Order storage o = orders[id];
        if (o.size == 0) revert BadParam("no order");
        _authTrade(o.acct);
        _remove(id, CancelReason.User);
    }

    /// @notice Bounded (<= MAX_OPEN_ORDERS). Allowed in every market state.
    function cancelAll(address owner, uint8 sub) external nonReentrant {
        bytes32 a = acctKey(owner, sub);
        _authTrade(a);
        _cancelAllFor(a, CancelReason.User);
    }

    // ================================================================== views
    function getMarket(uint8 m) external view returns (Market memory) { return markets[m]; }

    function getLevel(uint8 m, bool isBuy, uint64 price) external view returns (Level memory) { return levels[m][isBuy][price]; }

    function openOrderIds(bytes32 a) external view returns (uint256[] memory) { return openOrders[a].values(); }

    /// @notice Top-of-book depth snapshot: up to `n` levels per side as (price,total) pairs.
    function bookSnapshot(uint8 m, bool isBuy, uint256 n) external view returns (uint64[] memory px, uint128[] memory sz) {
        px = new uint64[](n); sz = new uint128[](n);
        uint64 cur = bestPrice[m][isBuy];
        for (uint256 i; i < n && cur != 0; i++) {
            px[i] = cur; sz[i] = levels[m][isBuy][cur].total;
            cur = levels[m][isBuy][cur].nextPrice;
        }
    }

}
