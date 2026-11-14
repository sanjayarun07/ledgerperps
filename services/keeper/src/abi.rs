//! Minimal ABI of the exchange router (see contracts/abi/PerpExchange.merged.json).
//! Only PERMISSIONLESS entry points are declared as writes; the keeper has no role on-chain.
#![allow(clippy::too_many_arguments)]

use alloy::sol;

sol! {
    #[sol(rpc)]
    interface IPerp {
        struct Twap {
            bytes32 acct; uint128 total; uint128 filled; uint64 nextTime; uint32 interval; uint32 slippageBps;
            uint16 slices; uint16 done; uint16 failed; uint8 market; bool isBuy; bool reduceOnly; bool active;
        }

        // ---- views
        function marketCount() external view returns (uint8);
        function markPrice(uint8 m) external view returns (uint256);
        function BACKSTOP() external view returns (bytes32);
        function accountState(bytes32 a) external view returns (int256 equity, uint256 im, uint256 mm, uint256 resv, uint256 avail);
        function isoState(bytes32 a, uint8 market) external view returns (bool isolated, int256 margin, int256 equity, uint256 im, uint256 mm, uint256 resv);
        function positions(bytes32 a, uint8 market) external view returns (int256 size, int256 basis, int256 lastFundingIdx, bool isolated, int256 isoMargin, uint256 isoReserved);
        function conds(uint64 id) external view returns (bytes32 acct, uint128 size, uint64 trigger, uint64 limit, uint64 sibling, uint8 market, bool isBuy, bool above, bool reduceOnly, bool active);
        function twapStatus(uint64 id) external view returns (Twap memory);
        function adlDebt(uint8 market) external view returns (uint256);
        function adlScore(bytes32 a, uint8 market) external view returns (uint256);
        function adlHealth(bytes32 a, uint8 market) external view returns (int256 eq, uint256 mm);
        function backstopEquity() external view returns (int256);
        function bsInsDrawn() external view returns (uint256);
        function bsDebt() external view returns (uint256);
        function unresolvedBadDebt() external view returns (uint256);
        function MAX_ADL_TARGETS() external view returns (uint256);
        function liqFeeBps() external view returns (uint32);
        function keeperShareBps() external view returns (uint32);
        function closeFactorBps() external view returns (uint32);
        function fullCloseNotional() external view returns (uint64);
        // NOTE: the real return type is a big tuple; the keeper only uses this declaration to encode the call (the selector
        // depends on the name + argument types alone) and parses the few words it needs itself, see chain::parse_market_info.
        function getMarket(uint8 m) external view returns (bytes memory);

        // ---- permissionless writes (the ONLY ones the keeper ever sends)
        function pokeFunding(uint8 m) external;
        function liquidate(bytes32 a, uint8 market) external;
        function executeConditional(uint64 id) external;
        function executeTwapSlice(uint64 id) external;
        function adl(bytes32[] calldata targets, uint8 market) external;
        /// Permissionless; records the loss of a FLAT, NEGATIVE bucket (LIQ-2). No keeper reward on-chain.
        function writeOff(bytes32 a, uint8 market) external;
        /// Permissionless; idempotent. Records the backstop's mark-to-market deficit (insurance first, then bad debt) or repays earlier draws.
        function syncBackstop() external;

        // ---- events scanned for discovery
        event Deposit(bytes32 indexed acct, address indexed from, uint256 amount);
        event Fill(uint64 indexed tradeId, uint8 indexed market, uint64 makerOrderId, bytes32 maker, bytes32 taker, bool takerIsBuy, uint64 price, uint128 size, uint256 takerFee, int256 makerFee);
        event CondPlaced(uint64 indexed id, bytes32 indexed acct, uint8 market, bool isBuy, bool above, uint64 trigger, uint64 limit, uint128 size, bool reduceOnly, uint64 sibling);
        event CondTriggered(uint64 indexed id, uint64 markPrice);
        event CondCanceled(uint64 indexed id);
        event TwapPlaced(uint64 indexed id, bytes32 indexed acct, uint8 market, bool isBuy, uint128 total, uint16 slices, uint32 interval, uint32 slippageBps, bool reduceOnly);
        event TwapDone(uint64 indexed id, uint128 filled, uint16 failed);
        event TwapCanceled(uint64 indexed id, uint128 filled);
        event BackstopSynced(int256 equityBefore, uint256 fromInsurance, uint256 toDebt, uint8 indexed market, uint256 refundedInsurance, uint256 repaidDebt);
        event AdlSkipped(bytes32 indexed target, uint8 indexed market, uint256 slack);
        event BadDebtUnresolved(bytes32 indexed acct, uint256 amount);
        event Liquidated(bytes32 indexed acct, uint8 indexed market, address indexed keeper, uint128 size, uint64 price, uint256 fee, uint256 badDebt);

        // ---- errors
        error NotAuthorized();
        error BadParam(string what);
        error MarketRestricted();
        error OracleDegraded();
        error Unhealthy();
        error NotLiquidatable();
        error Expired();
        error TooManyOrders();
        error WithdrawGated();
        error ReentrancyGuardReentrantCall();
    }
}
