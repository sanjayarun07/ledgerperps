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

/// @dev Shared storage, events, errors and internal accounting. Core and modules inherit this IDENTICAL layout;
///      modules run via delegatecall from PerpExchange, so NEVER reorder or insert state here without a layout check.
abstract contract PerpBase is AccessControl, ReentrancyGuard, EIP712 {
    using SafeERC20 for IERC20;
    using EnumerableSet for EnumerableSet.UintSet;

    constructor() EIP712("PerpExchange", "1") {}
    // ------------------------------------------------------------------ roles
    bytes32 public constant GUARDIAN_ROLE = keccak256("GUARDIAN_ROLE"); // can pause / reduce-only, cannot unpause
    bytes32 public constant BACKSTOP_ROLE = keccak256("BACKSTOP_ROLE"); // trades the backstop inventory

    // ------------------------------------------------------------------ constants / bounds
    uint256 constant SIZE_SCALE = 1e8;
    uint256 constant BASIS_SCALE = 1e8; // basis (size*price) -> 1e6 USDC
    uint256 constant FUND_SCALE = 1e14; // size*fundingIdx -> 1e6 USDC
    uint256 constant BPS = 1e4;
    uint256 constant RATE_SCALE = 1e12;
    uint256 public constant MAX_MARKETS = 16;
    uint256 public constant MAX_LEVELS_PER_TX = 16; // price levels visited
    uint256 public constant MAX_TOUCHES_PER_TX = 40; // maker orders touched (fills + removals)
    uint256 public constant MAX_INSERT_WALK = 64; // levels walked on insertion
    uint256 public constant MAX_OPEN_ORDERS = 32;
    uint256 public constant MAX_CONDITIONALS = 16;
    bytes32 public constant BACKSTOP = keccak256("PERP.BACKSTOP");

    enum State { Normal, ReduceOnly, OracleDegraded, Paused, Recovery, Delisted }
    enum TIF { GTC, IOC, FOK, PostOnly }
    enum CancelReason { User, Expired, SelfTrade, InvalidReduceOnly, MakerMargin, Filled, Liquidation, Replaced, PriceBand }

    struct Tier { uint128 upToNotional; uint32 imrBps; uint32 mmrBps; } // whole-position tiering

    struct Market {
        bool exists;
        State state;
        bytes32 feed;
        uint64 tick; // price granularity
        uint64 lot; // size granularity
        uint64 minNotional; // 1e6
        uint128 maxOrderSize;
        uint128 maxOI; // sum of long sizes
        uint128 oi;
        uint32 maxAge; // oracle freshness (s)
        uint32 bandBps; // mark may deviate from index by at most this
        uint32 maxSpreadBps; // book mid ignored when spread wider
        uint32 fundingInterval; // s
        uint32 premiumDivisor; // 8 => 8h-style premium paid hourly
        uint64 fundingCap; // max |rate| per interval, 1e12
        // funding state
        int256 fundingIndex;
        uint64 lastFunding;
        uint64 lastSample;
        int256 lastPremium;
        bool lastPremiumValid;
        int256 premiumIntegral;
        uint256 sampledTime;
        uint256 lastIndexPrice;
        uint64 lastTradePrice;
        Tier[] tiers;
        uint64 settlePrice; // final settlement price once Delisted
    }

    struct Position {
        int256 size; int256 basis; int256 lastFundingIdx;
        bool isolated; int256 isoMargin; uint256 isoReserved; // isolated-margin mode (see PerpExchange.setIsolated)
    }

    /// @dev TWAP parent order. Slices are executed by permissionless keepers (NOT guaranteed on-time); each slice is an IOC
    ///      through the normal margin path. Visible child status: done/failed/filled.
    struct Twap {
        bytes32 acct; uint128 total; uint128 filled; uint64 nextTime; uint32 interval; uint32 slippageBps;
        uint16 slices; uint16 done; uint16 failed; uint8 market; bool isBuy; bool reduceOnly; bool active;
    }

    struct Order {
        bytes32 acct;
        uint128 size;
        uint128 reserve;
        uint64 price;
        uint64 expiry;
        uint64 prev;
        uint64 next;
        uint64 cloid;
        uint8 market;
        bool isBuy;
        bool reduceOnly;
    }

    struct Level { uint128 total; uint64 head; uint64 tail; uint64 nextPrice; uint64 prevPrice; }

    struct OrderParams {
        uint8 market;
        bool isBuy;
        uint64 price; // limit price; for market orders pass worst acceptable price + IOC
        uint128 size;
        TIF tif;
        bool reduceOnly;
        uint64 cloid; // client order id, unique per account while non-zero (idempotency)
        uint64 expiry; // 0 = none
    }

    struct Cond {
        bytes32 acct;
        uint128 size;
        uint64 trigger;
        uint64 limit;
        uint64 sibling; // OCO partner
        uint8 market;
        bool isBuy;
        bool above; // fire when mark >= trigger (true) or <= trigger (false)
        bool reduceOnly;
        bool active;
    }

    // ------------------------------------------------------------------ storage
    IERC20 public usdc;
    IOracle public oracle;

    uint8 public marketCount;
    mapping(uint8 => Market) internal markets;

    // accounts
    mapping(bytes32 => int256) public collateral;
    mapping(bytes32 => uint256) public reserved;
    mapping(bytes32 => address) public acctOwner;
    mapping(bytes32 => mapping(address => uint64)) public agentExpiry; // trading-only keys
    mapping(bytes32 => mapping(uint8 => Position)) public positions;
    mapping(bytes32 => EnumerableSet.UintSet) internal openOrders;
    mapping(bytes32 => mapping(uint64 => bool)) public cloidUsed;
    mapping(address => mapping(uint256 => bool)) public nonceUsed;
    mapping(bytes32 => uint256) public condCount;

    // book
    mapping(uint64 => Order) public orders;
    mapping(uint8 => mapping(bool => mapping(uint64 => Level))) internal levels;
    mapping(uint8 => mapping(bool => uint64)) public bestPrice;
    uint64 public nextOrderId = 1;
    uint64 public nextTradeId = 1;

    mapping(uint64 => Cond) public conds;
    uint64 public nextCondId = 1;

    mapping(uint64 => Twap) public twaps;
    uint64 public nextTwapId = 1;
    mapping(bytes32 => uint256) public twapCount;

    // ADL: per-market unresolved loss (1e6 USDC) awaiting deleveraging of profitable counterparties
    mapping(uint8 => uint256) public adlDebt;
    uint32 public adlMaxPremBps = 2500;

    /// @dev Optional limits on a session key. Unscoped keys (scoped=false) may trade any market at any size but can never withdraw.
    struct AgentScope { bool scoped; uint64 marketMask; uint128 maxOrderNotional; }
    mapping(bytes32 => mapping(address => AgentScope)) public agentScope;

    // ledger (1e6 USDC unless noted). Invariant when all accounts are settled:
    // sum(collateral) + insurance + feePool + fundingPool - unresolvedBadDebt + floor(dustBasis/1e8) == totalDeposited - totalWithdrawn
    uint256 public totalDeposited;
    uint256 public totalWithdrawn;
    uint256 public insurance;
    int256 public feePool;
    int256 public fundingPool;
    uint256 public unresolvedBadDebt;
    uint256 public dustBasis;

    // ---- backstop mark-to-market recognition (BACKSTOP-1, docs/BACKSTOP_DESIGN.md design (b)) ----
    uint256 public bsInsDrawn;          // insurance charged for backstop deficits and not yet refunded
    uint256 public bsDebt;              // part of unresolvedBadDebt that arose from backstop deficits (always <= unresolvedBadDebt)
    uint32 public adlHardPremBps = 10000; // ADL premium ceiling (bps of mark) while bsDebt > 0; target break-even still binds
    uint256 public wdGateThreshold = 100e6; // withdrawal limiter: active while unresolvedBadDebt > this (1e6 USDC)
    mapping(bytes32 => uint256) public principal; // deposited (not earned) collateral still withdrawable while the limiter is active

    // params
    uint32 public takerFeeBps = 5;
    int32 public makerFeeBps = 1; // negative = rebate
    uint32 public liqFeeBps = 50; // of liquidated notional
    uint32 public keeperShareBps = 5000; // share of liq fee paid to liquidator
    uint32 public closeFactorBps = 5000;
    uint64 public fullCloseNotional = 10_000e6; // positions below this close fully
    bool public globalPaused;

    // ------------------------------------------------------------------ events
    event Deposit(bytes32 indexed acct, address indexed from, uint256 amount);
    event Withdraw(bytes32 indexed acct, uint256 amount);
    event InternalTransfer(bytes32 indexed from, bytes32 indexed to, uint256 amount);
    event OrderAccepted(uint64 indexed id, bytes32 indexed acct, uint8 market, bool isBuy, uint64 price, uint128 size, TIF tif, bool reduceOnly, uint64 cloid);
    event OrderRested(uint64 indexed id, uint128 remaining);
    event OrderCanceled(uint64 indexed id, CancelReason reason, uint128 remaining);
    event OrderTruncated(uint64 indexed id, uint128 remaining);
    event Fill(uint64 indexed tradeId, uint8 indexed market, uint64 makerOrderId, bytes32 maker, bytes32 taker, bool takerIsBuy, uint64 price, uint128 size, uint256 takerFee, int256 makerFee);
    event Liquidated(bytes32 indexed acct, uint8 indexed market, address indexed keeper, uint128 size, uint64 price, uint256 fee, uint256 badDebt);
    event BadDebtUnresolved(bytes32 indexed acct, uint256 amount); // ADL would be required (NOT IMPLEMENTED)
    event BackstopSynced(int256 equityBefore, uint256 fromInsurance, uint256 toDebt, uint8 indexed market, uint256 refundedInsurance, uint256 repaidDebt);
    event FundingUpdated(uint8 indexed market, uint256 intervals, int256 rate, int256 newIndex);
    event FundingSettled(bytes32 indexed acct, uint8 indexed market, int256 owed);
    event MarketState(uint8 indexed market, State s);
    event CondPlaced(uint64 indexed id, bytes32 indexed acct, uint8 market, bool isBuy, bool above, uint64 trigger, uint64 limit, uint128 size, bool reduceOnly, uint64 sibling);
    event CondTriggered(uint64 indexed id, uint64 markPrice);
    event CondCanceled(uint64 indexed id);
    event AgentApproved(bytes32 indexed acct, address indexed agent, uint64 expiry);

    // ------------------------------------------------------------------ errors (stable string-free codes)
    error NotAuthorized();
    error BadParam(string what);
    error MarketRestricted();
    error OracleDegraded();
    error Unhealthy();
    error ReduceOnlyViolation();
    error PostOnlyCross();
    error FokUnfilled();
    error DuplicateClientId();
    error TooManyOrders();
    error PriceTooFarFromTop();
    error OICap();
    error NotLiquidatable();
    error Expired();
    error WithdrawGated();
    bytes32 constant ORDER_TYPEHASH = keccak256(
        "OrderAction(address owner,uint8 sub,uint8 market,bool isBuy,uint64 price,uint128 size,uint8 tif,bool reduceOnly,uint64 cloid,uint64 expiry,uint256 nonce,uint256 deadline)"
    );

    function acctKey(address owner, uint8 sub) public pure returns (bytes32) {
        return keccak256(abi.encode(owner, sub));
    }

    function _register(address owner, uint8 sub) internal returns (bytes32 a) {
        a = acctKey(owner, sub);
        if (acctOwner[a] == address(0)) acctOwner[a] = owner;
    }

    /// @dev Auth + agent scope check (market bit and max order notional at the limit price).
    function _authTradeScoped(bytes32 a, uint8 market, uint128 size, uint64 price) internal view {
        _authTrade(a);
        if (msg.sender != acctOwner[a]) _checkScope(a, msg.sender, market, size, price);
    }

    function _checkScope(bytes32 a, address agent, uint8 market, uint128 size, uint64 price) internal view {
        AgentScope memory sc = agentScope[a][agent];
        if (!sc.scoped) return;
        if (market >= 64 || (sc.marketMask >> market) & 1 == 0 || _notionalFloor(size, price) > sc.maxOrderNotional) revert NotAuthorized();
    }

    function _authTrade(bytes32 a) internal view {
        address o = acctOwner[a];
        if (msg.sender != o && agentExpiry[a][msg.sender] <= block.timestamp) revert NotAuthorized();
    }


    // ================================================================== prices
    function _index(uint8 m) internal view returns (uint256 px, bool ok) {
        Market storage M = markets[m];
        try oracle.latest(M.feed) returns (uint256 p, uint256 t) {
            if (p == 0 || t > block.timestamp || block.timestamp - t > M.maxAge) return (0, false);
            return (p, true);
        } catch { return (0, false); }
    }

    /// @notice Mark = book mid clamped to index +/- band; index if the book is absent/thin/wide. Never last-trade.
    function _markFrom(uint8 m, uint256 idx) internal view returns (uint256) {
        Market storage M = markets[m];
        uint256 bb = bestPrice[m][true];
        uint256 ba = bestPrice[m][false];
        if (bb == 0 || ba == 0 || bb >= ba) return idx;
        if ((ba - bb) * BPS > ((ba + bb) / 2) * M.maxSpreadBps) return idx;
        uint256 mid = (bb + ba) / 2;
        uint256 lo = idx - idx * M.bandBps / BPS;
        uint256 hi = idx + idx * M.bandBps / BPS;
        return mid < lo ? lo : (mid > hi ? hi : mid);
    }

    function markPrice(uint8 m) public view returns (uint256) {
        if (markets[m].state == State.Delisted) return markets[m].settlePrice; // frozen final price
        (uint256 idx, bool ok) = _index(m);
        if (!ok) revert OracleDegraded();
        return _markFrom(m, idx);
    }

    // ================================================================== math helpers
    function _abs(int256 x) internal pure returns (uint256) { return x >= 0 ? uint256(x) : uint256(-x); }

    function _fdiv(int256 a, int256 b) internal pure returns (int256 q) {
        q = a / b;
        if ((a % b != 0) && ((a < 0) != (b < 0))) q--;
    }

    function _notionalFloor(uint256 size, uint256 px) internal pure returns (uint256) { return size * px / SIZE_SCALE; }
    function _notionalCeil(uint256 size, uint256 px) internal pure returns (uint256) { return (size * px + SIZE_SCALE - 1) / SIZE_SCALE; }
    function _ceilBps(uint256 x, uint256 bps) internal pure returns (uint256) { return (x * bps + BPS - 1) / BPS; }

    function _tier(uint8 m, uint256 notional) internal view returns (uint32 imr, uint32 mmr) {
        Tier[] storage t = markets[m].tiers;
        for (uint256 i; i < t.length; i++) {
            if (notional <= t[i].upToNotional) return (t[i].imrBps, t[i].mmrBps);
        }
        return (t[t.length - 1].imrBps, t[t.length - 1].mmrBps);
    }

    /// @dev equity = collateral + unrealized (rounded against the user) - unsettled funding. Reverts if any held market lacks a valid mark.
    function _risk(bytes32 a) internal view returns (int256 equity, uint256 im, uint256 mm) {
        equity = collateral[a];
        for (uint8 m = 0; m < marketCount; m++) {
            Position storage p = positions[a][m];
            if (p.size == 0 || p.isolated) continue; // isolated positions are margined separately
            uint256 mk = markPrice(m);
            equity += _fdiv(p.size * int256(mk) - p.basis, int256(BASIS_SCALE));
            equity -= _fundingOwed(p.size, markets[m].fundingIndex - p.lastFundingIdx);
            uint256 n = _notionalCeil(_abs(p.size), mk);
            (uint32 i_, uint32 m_) = _tier(m, n);
            im += _ceilBps(n, i_);
            mm += _ceilBps(n, m_);
        }
    }


    /// @dev Isolated position equity = isoMargin + unrealized - unsettled funding. Loss is capped at isoMargin by liquidation.
    function _isoRisk(bytes32 a, uint8 m) internal view returns (int256 equity, uint256 im, uint256 mm) {
        Position storage p = positions[a][m];
        equity = p.isoMargin;
        if (p.size == 0) return (equity, 0, 0);
        uint256 mk = markPrice(m);
        equity += _fdiv(p.size * int256(mk) - p.basis, int256(BASIS_SCALE));
        equity -= _fundingOwed(p.size, markets[m].fundingIndex - p.lastFundingIdx);
        uint256 n = _notionalCeil(_abs(p.size), mk);
        (uint32 i_, uint32 m_) = _tier(m, n);
        im = _ceilBps(n, i_);
        mm = _ceilBps(n, m_);
    }

    /// @dev Liquidation/ADL-ranking variant of `_risk`. The liquidated market (`lm`) must have a valid mark (reverts otherwise).
    ///      Any OTHER held cross market whose oracle is stale/invalid does not block: it is valued at its last good index
    ///      (`lastIndexPrice`, else entry price) moved STALE_FAV_BPS in the ACCOUNT'S FAVOUR, so a stale feed can only make
    ///      the account look healthier, never less healthy. A healthy account can therefore be liquidated through a stale
    ///      feed only if that feed's true price has since moved more than STALE_FAV_BPS in the account's favour.
    uint256 constant STALE_FAV_BPS = 2000;
    function _riskLiq(bytes32 a, uint8 lm) internal view returns (int256 equity, uint256 im, uint256 mm) {
        equity = collateral[a];
        for (uint8 m = 0; m < marketCount; m++) {
            Position storage p = positions[a][m];
            if (p.size == 0 || p.isolated) continue;
            uint256 mk; uint256 vk;
            if (m == lm) { mk = markPrice(m); vk = mk; }
            else {
                bool ok;
                if (markets[m].state == State.Delisted) { mk = markets[m].settlePrice; ok = true; }
                else { uint256 idx; (idx, ok) = _index(m); if (ok) mk = _markFrom(m, idx); }
                vk = mk;
                if (!ok) {
                    mk = markets[m].lastIndexPrice != 0 ? markets[m].lastIndexPrice : _abs(p.basis) / _abs(p.size);
                    vk = p.size > 0 ? mk * (BPS + STALE_FAV_BPS) / BPS : mk * (BPS - STALE_FAV_BPS) / BPS;
                }
            }
            equity += _fdiv(p.size * int256(vk) - p.basis, int256(BASIS_SCALE));
            equity -= _fundingOwed(p.size, markets[m].fundingIndex - p.lastFundingIdx);
            uint256 n = _notionalCeil(_abs(p.size), mk);
            (uint32 i_, uint32 m_) = _tier(m, n);
            im += _ceilBps(n, i_);
            mm += _ceilBps(n, m_);
        }
    }

    function _noCrossPositions(bytes32 a) internal view returns (bool) {
        for (uint8 m = 0; m < marketCount; m++) if (positions[a][m].size != 0 && !positions[a][m].isolated) return false;
        return true;
    }

    /// @dev If the account's bucket for market `m` (isolated margin, or cross collateral when no cross position remains) is
    ///      FLAT and NEGATIVE, covers the deficit from insurance and records the rest as unresolvedBadDebt / adlDebt[m],
    ///      returning the bucket to 0. Shared by liquidation, delisting settlement, trade fills and `writeOff`, so a loss
    ///      can never sit unrecorded in a flat account. No-op otherwise.
    function _writeOffIfFlat(bytes32 a, uint8 m) internal returns (uint256 bad) {
        Position storage s = positions[a][m];
        bool iso = s.isolated;
        int256 bal = iso ? s.isoMargin : collateral[a];
        if (bal >= 0 || (iso ? s.size != 0 : !_noCrossPositions(a))) return 0;
        uint256 deficit = uint256(-bal);
        uint256 cover = deficit < insurance ? deficit : insurance;
        insurance -= cover;
        bad = deficit - cover;
        _credit(a, m, int256(deficit));
        if (bad > 0) {
            unresolvedBadDebt += bad;
            adlDebt[m] += bad; // ADL (PerpAdl) deleverages profitable counterparties against this
            emit BadDebtUnresolved(a, bad);
        }
    }

    // ================================================================== backstop recognition (BACKSTOP-1)
    /// @dev Valuation price of a backstop position. A stale/invalid feed is valued ADVERSELY to the backstop by STALE_FAV_BPS
    ///      (last good index moved against it), so an outage can only over-record debt (which is repaid on recovery), never hide it.
    function _backstopMark(uint8 m, int256 size, int256 basis) internal view returns (uint256 vk) {
        if (markets[m].state == State.Delisted) return markets[m].settlePrice;
        (uint256 idx, bool ok) = _index(m);
        if (ok) return _markFrom(m, idx);
        uint256 lp = markets[m].lastIndexPrice != 0 ? markets[m].lastIndexPrice : _abs(basis) / _abs(size);
        return size > 0 ? lp * (BPS - STALE_FAV_BPS) / BPS : lp * (BPS + STALE_FAV_BPS) / BPS;
    }

    /// @dev Backstop equity = collateral + unrealised PnL - unsettled funding over every market it holds (never reverts on prices).
    ///      `wm` = market with the largest unrealised loss (where new debt is attributed).
    function _backstopEquity() internal view returns (int256 eq, uint8 wm) {
        eq = collateral[BACKSTOP];
        int256 worst;
        for (uint8 m = 0; m < marketCount; m++) {
            Position storage p = positions[BACKSTOP][m];
            if (p.size == 0) continue;
            int256 u = _fdiv(p.size * int256(_backstopMark(m, p.size, p.basis)) - p.basis, int256(BASIS_SCALE))
                - _fundingOwed(p.size, markets[m].fundingIndex - p.lastFundingIdx);
            eq += u;
            if (u < worst) { worst = u; wm = m; }
        }
    }

    /// @dev Clears `x` of per-market debt records, `first` market first, then ascending ids (pass 255 for plain ascending).
    function _clearAdlDebt(uint8 first, uint256 x) internal {
        if (first < marketCount) { uint256 t = adlDebt[first] < x ? adlDebt[first] : x; adlDebt[first] -= t; x -= t; }
        for (uint8 m = 0; m < marketCount && x > 0; m++) { uint256 t = adlDebt[m] < x ? adlDebt[m] : x; adlDebt[m] -= t; x -= t; }
    }

    /// @dev Recognises backstop mark-to-market losses. Negative equity E<0: the deficit is credited to collateral[BACKSTOP] (bucket back
    ///      to E=0), charged to insurance first, the rest recorded as unresolvedBadDebt/adlDebt/bsDebt. Positive equity repays earlier
    ///      draws: insurance first, then bsDebt. Idempotent. Ledger identity is unchanged (every move is bucket-to-bucket).
    function _syncBackstop() internal {
        (int256 eq, uint8 wm) = _backstopEquity();
        if (eq < 0) {
            uint256 d = uint256(-eq);
            uint256 cover = d < insurance ? d : insurance;
            insurance -= cover; bsInsDrawn += cover;
            uint256 bad = d - cover;
            collateral[BACKSTOP] += int256(d);
            if (bad > 0) {
                unresolvedBadDebt += bad; adlDebt[wm] += bad; bsDebt += bad;
                emit BadDebtUnresolved(BACKSTOP, bad);
            }
            emit BackstopSynced(eq, cover, bad, wm, 0, 0);
        } else if (eq > 0 && (bsInsDrawn > 0 || bsDebt > 0)) {
            uint256 room = uint256(eq);
            uint256 rIns = room < bsInsDrawn ? room : bsInsDrawn;
            uint256 rDebt = room - rIns < bsDebt ? room - rIns : bsDebt;
            collateral[BACKSTOP] -= int256(rIns + rDebt);
            if (rIns > 0) { bsInsDrawn -= rIns; insurance += rIns; }
            if (rDebt > 0) { bsDebt -= rDebt; unresolvedBadDebt -= rDebt; _clearAdlDebt(255, rDebt); }
            emit BackstopSynced(eq, 0, 0, 0, rIns, rDebt);
        }
    }

    function _marginOK(bytes32 a, uint8 m) internal view returns (bool) {
        Position storage p = positions[a][m];
        if (!p.isolated) return _initialOK(a);
        (int256 eq, uint256 im,) = _isoRisk(a, m);
        return eq >= int256(im) + int256(p.isoReserved);
    }

    /// @dev Routes balance changes to the isolated margin bucket or the cross collateral bucket.
    function _credit(bytes32 a, uint8 m, int256 amt) internal {
        Position storage p = positions[a][m];
        if (p.isolated) p.isoMargin += amt; else collateral[a] += amt;
    }

    function _reserveAdd(bytes32 a, uint8 m, uint256 x) internal {
        if (positions[a][m].isolated) positions[a][m].isoReserved += x; else reserved[a] += x;
    }

    function _reserveSub(bytes32 a, uint8 m, uint256 x) internal {
        if (positions[a][m].isolated) positions[a][m].isoReserved -= x; else reserved[a] -= x;
    }

    function _initialOK(bytes32 a) internal view returns (bool) {
        (int256 eq, uint256 im,) = _risk(a);
        return eq >= int256(im) + int256(reserved[a]);
    }

    // ================================================================== funding
    /// @dev positive owed = account pays. Pays rounded up, receipts rounded toward zero (residual stays in fundingPool).
    function _fundingOwed(int256 size, int256 dIdx) internal pure returns (int256) {
        int256 p = size * dIdx;
        if (p > 0) return (p + int256(FUND_SCALE) - 1) / int256(FUND_SCALE);
        return p / int256(FUND_SCALE);
    }

    function _settleMarket(bytes32 a, uint8 m) internal {
        Position storage p = positions[a][m];
        int256 idx = markets[m].fundingIndex;
        if (p.size != 0 && p.lastFundingIdx != idx) {
            int256 owed = _fundingOwed(p.size, idx - p.lastFundingIdx);
            _credit(a, m, -owed);
            fundingPool += owed;
            emit FundingSettled(a, m, owed);
        }
        p.lastFundingIdx = idx;
    }

    function _settleAll(bytes32 a) internal {
        for (uint8 m = 0; m < marketCount; m++) _settleMarket(a, m);
    }


    // ================================================================== position accounting
    /// @dev Applies a signed fill to an account. Returns realized pnl (already credited to collateral).
    function _applyFill(bytes32 a, uint8 m, int256 q, uint256 px) internal {
        Position storage s = positions[a][m];
        int256 old = s.size;
        int256 nw = old + q;
        if (old == 0 || (old > 0) == (q > 0)) {
            s.basis += q * int256(px);
        } else {
            uint256 aq = _abs(q);
            uint256 ao = _abs(old);
            uint256 closed = aq < ao ? aq : ao;
            int256 remB = s.basis * int256(closed) / int256(ao); // exact when closed == ao
            int256 val = (old > 0 ? int256(closed) : -int256(closed)) * int256(px);
            int256 scaled = val - remB;
            int256 pnl = _fdiv(scaled, int256(BASIS_SCALE));
            dustBasis += uint256(scaled - pnl * int256(BASIS_SCALE)); // remainder >= 0, kept by the protocol
            _credit(a, m, pnl);
            s.basis -= remB;
            if (aq > ao) s.basis = (q > 0 ? int256(1) : int256(-1)) * int256(aq - ao) * int256(px);
        }
        s.size = nw;
        if (nw == 0) s.basis = 0;
        // open interest = sum of long sizes
        Market storage M = markets[m];
        int256 oiDelta = (nw > 0 ? nw : int256(0)) - (old > 0 ? old : int256(0));
        M.oi = uint128(uint256(int256(uint256(M.oi)) + oiDelta));
    }

    // ================================================================== order book internals
    function _isBetter(bool isBuy, uint64 a, uint64 b) internal pure returns (bool) { return isBuy ? a > b : a < b; }

    function _insert(uint64 id) internal {
        Order storage o = orders[id];
        uint8 m = o.market; bool isBuy = o.isBuy; uint64 px = o.price;
        Level storage L = levels[m][isBuy][px];
        if (L.head == 0) {
            // new level: find position
            uint64 cur = bestPrice[m][isBuy];
            if (cur == 0 || _isBetter(isBuy, px, cur)) {
                L.nextPrice = cur; L.prevPrice = 0;
                if (cur != 0) levels[m][isBuy][cur].prevPrice = px;
                bestPrice[m][isBuy] = px;
            } else {
                uint64 prevP = cur; uint256 steps;
                uint64 nxt = levels[m][isBuy][cur].nextPrice;
                while (nxt != 0 && _isBetter(isBuy, nxt, px)) {
                    if (++steps > MAX_INSERT_WALK) revert PriceTooFarFromTop();
                    prevP = nxt; nxt = levels[m][isBuy][nxt].nextPrice;
                }
                L.prevPrice = prevP; L.nextPrice = nxt;
                levels[m][isBuy][prevP].nextPrice = px;
                if (nxt != 0) levels[m][isBuy][nxt].prevPrice = px;
            }
            L.head = id; L.tail = id; o.prev = 0; o.next = 0;
        } else {
            orders[L.tail].next = id; o.prev = L.tail; o.next = 0; L.tail = id;
        }
        L.total += o.size;
        openOrders[o.acct].add(id);
    }

    function _unlink(uint64 id) internal {
        Order storage o = orders[id];
        uint8 m = o.market; bool isBuy = o.isBuy; uint64 px = o.price;
        Level storage L = levels[m][isBuy][px];
        if (o.prev != 0) orders[o.prev].next = o.next; else L.head = o.next;
        if (o.next != 0) orders[o.next].prev = o.prev; else L.tail = o.prev;
        L.total -= o.size;
        if (L.head == 0) {
            if (L.prevPrice != 0) levels[m][isBuy][L.prevPrice].nextPrice = L.nextPrice; else bestPrice[m][isBuy] = L.nextPrice;
            if (L.nextPrice != 0) levels[m][isBuy][L.nextPrice].prevPrice = L.prevPrice;
            delete levels[m][isBuy][px];
        }
    }

    function _remove(uint64 id, CancelReason why) internal {
        Order storage o = orders[id];
        uint128 rem = o.size;
        _unlink(id);
        _reserveSub(o.acct, o.market, o.reserve);
        openOrders[o.acct].remove(id);
        emit OrderCanceled(id, why, rem);
        delete orders[id];
    }

    function _orderReserve(uint8 m, uint64 px, uint128 size, bool reduceOnly) internal view returns (uint128) {
        if (reduceOnly) return 0;
        (uint32 imr,) = _tier(m, _notionalCeil(size, px));
        return uint128(_ceilBps(_notionalCeil(size, px), imr));
    }


    function _cancelAllFor(bytes32 a, CancelReason why) internal {
        uint256[] memory ids = openOrders[a].values();
        for (uint256 i; i < ids.length; i++) _remove(uint64(ids[i]), why);
    }

}
