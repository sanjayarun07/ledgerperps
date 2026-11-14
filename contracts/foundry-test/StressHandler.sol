// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test, Vm} from "forge-std/Test.sol";
import {IPerp} from "./Deployer.sol";
import {PerpExchange} from "../src/PerpExchange.sol";
import {PerpBase} from "../src/PerpBase.sol";
import {MockUSDC} from "../src/MockUSDC.sol";
import {ManualOracle} from "../src/oracles/ManualOracle.sol";

interface IStressPerp is IPerp {
    function isoState(bytes32 a, uint8 m) external view returns (bool isolated, int256 margin, int256 equity, uint256 im, uint256 mm, uint256 resv);
    function accountState(bytes32 a) external view returns (int256 equity, uint256 im, uint256 mm, uint256 resv, uint256 avail);
    function positions(bytes32 a, uint8 m) external view returns (int256 size, int256 basis, int256 lastFundingIdx, bool isolated, int256 isoMargin, uint256 isoReserved);
    function markPrice(uint8 m) external view returns (uint256);
    function adlDebt(uint8 m) external view returns (uint256);
    function setMarketState(uint8 m, PerpBase.State s) external;
    function setGlobalPause(bool p) external;
    function delistMarket(uint8 m, uint64 settlePrice) external;
    function settleDelisted(bytes32 a, uint8 m) external;
    function setIsolated(uint8 sub, uint8 market, bool on) external;
    function addIsoMargin(uint8 sub, uint8 market, uint256 amount) external;
    function pokeFunding(uint8 m) external;
    function rebalanceBackstop(int256 amount) external;
    function fundInsurance(uint256 amount) external;
    function syncBackstop() external;
    function backstopEquity() external view returns (int256);
    function setFees(uint32 taker, int32 maker, uint32 liq, uint32 keeperShare, uint32 closeFactor, uint64 fullClose) external;
}

/// @notice Stress handler: 3 markets, cross + isolated books, random oracle shocks from -60% to +150% (single gap, correlated,
///         independent, whipsaw, cascade-by-repetition), stale oracles, keepers (any actor) calling liquidate / adl /
///         recapitalize / pokeFunding, market state changes, global pause, delist + settleDelisted.
///         Per-call checks record violations in `viol[prop]`; state-only invariants are in `check*`.
interface StressKeeperLike { function flag(bytes32, string memory) external; function track() external; }

contract StressHandler is Test {
    IStressPerp public px;
    PerpExchange public ex;
    MockUSDC public usdc;
    ManualOracle public oracle;
    bytes32 public BACK;
    uint256 constant NM = 3;
    bytes32[3] feeds;
    uint256[3] px0;
    uint256[3] public tick;
    uint256[3] public lot;

    address[] public actors; // 0..5 traders, 6 cp (deep), 7 kp
    address public bsOp;
    address public payer;
    uint256[3] public price; // desired true price
    uint256 public staleMask;
    uint256 public lastRefresh;
    bool[3] public delisted;

    function _checkState(string memory) internal { K.track(); }
    // telemetry
    mapping(bytes32 => uint256) public calls;
    mapping(bytes32 => uint256) public okCalls;

    bool public inited;
    /// @dev constructor logic lives in init() because the handler exceeds EIP-170; the test etches the runtime code (vm.etch) then calls init.
    function init(PerpExchange _ex, MockUSDC _usdc, ManualOracle _oracle, bytes32[3] memory _feeds, uint256[3] memory _px0, uint256[3] memory _tick, uint256[3] memory _lot) external {
        require(!inited, "inited"); inited = true;
        bsOp = address(0xB5); payer = address(0xA11);
        ex = _ex; px = IStressPerp(address(_ex)); usdc = _usdc; oracle = _oracle; BACK = _ex.BACKSTOP();
        feeds = _feeds; px0 = _px0; tick = _tick; lot = _lot;
        for (uint256 m; m < NM; m++) price[m] = _px0[m];
        for (uint256 i; i < 8; i++) {
            address a = makeAddr(string.concat("sa", vm.toString(i)));
            actors.push(a);
            usdc.mint(a, 100_000_000e6);
            vm.prank(a); usdc.approve(address(_ex), type(uint256).max);
        }
        usdc.mint(payer, 1_000_000_000e6); vm.prank(payer); usdc.approve(address(_ex), type(uint256).max);
        for (uint256 i; i < 6; i++) { vm.prank(actors[i]); _ex.deposit(actors[i], 0, 5_000e6 + i * 4_000e6); }
        vm.prank(actors[6]); _ex.deposit(actors[6], 0, 20_000_000e6);
        vm.prank(actors[7]); _ex.deposit(actors[7], 0, 10_000e6);
        lastRefresh = block.timestamp;
    }

    // ------------------------------------------------------------------ plumbing
    function key(address a) public pure returns (bytes32) { return keccak256(abi.encode(a, uint8(0))); }
    function _a(uint256 s) internal view returns (address) { return actors[s % 8]; }
    StressKeeperLike public K;
    function setKeeper(address k) external { K = StressKeeperLike(k); }
    function fresh() external { _fresh(); }
    function _flag(bytes32 p, string memory msg_) internal { K.flag(p, msg_); }
    function pos(address a, uint256 m) public view returns (int256 s) { (s,,,,,) = px.positions(key(a), uint8(m)); }
    function posK(bytes32 k, uint256 m) public view returns (int256 s) { (s,,,,,) = px.positions(k, uint8(m)); }
    function _rt(uint256 p, uint256 m) internal view returns (uint256) { return p / tick[m] * tick[m]; }

    function _refresh() internal {
        vm.startPrank(oracle.owner());
        for (uint256 m; m < NM; m++) if ((staleMask >> m) & 1 == 0) oracle.set(feeds[m], price[m]);
        vm.stopPrank();
        lastRefresh = block.timestamp;
    }
    function _fresh() internal { if (block.timestamp - lastRefresh > 20) _refresh(); }

    function _call(bytes32 tag, address from, bytes memory data) internal returns (bool ok, bytes memory ret) {
        calls[tag]++;
        vm.prank(from);
        (ok, ret) = address(ex).call(data);
        if (ok) { okCalls[tag]++; return (ok, ret); }
        if (ret.length < 4) { _flag("P0", string.concat("empty revert (OOG?) in ", string(abi.encodePacked(tag)))); return (ok, ret); }
        bytes4 sel; assembly { sel := mload(add(ret, 32)) }
        if (sel == 0x4e487b71) _flag("P0", string.concat("Panic in ", string(abi.encodePacked(tag))));
    }
    function _sel(bytes memory ret) internal pure returns (bytes4 s) { if (ret.length >= 4) assembly { s := mload(add(ret, 32)) } }
    function _isNoPos(bytes memory ret) internal pure returns (bool) { return ret.length >= 4 && _sel(ret) == PerpBase.BadParam.selector && keccak256(ret) == keccak256(abi.encodeWithSelector(PerpBase.BadParam.selector, "no position")); }

    // ------------------------------------------------------------------ setup / trading
    function configIso(uint256 aS, uint256 mS, uint256 frac) external {
        address a = _a(aS); uint8 m = uint8(mS % NM); if (a == actors[6] || a == actors[7]) return;
        if (pos(a, m) != 0) return;
        vm.prank(a); try px.setIsolated(0, m, true) {} catch { return; }
        uint256 av; try px.accountState(key(a)) returns (int256, uint256, uint256, uint256, uint256 x) { av = x; } catch { return; }
        uint256 amt = av * bound(frac, 10, 80) / 100;
        if (amt > 0) { vm.prank(a); try px.addIsoMargin(0, m, amt) {} catch {} }
    }

    function _freeMargin(address a, uint8 m) internal view returns (uint256) {
        (, , , bool iso, , ) = px.positions(key(a), m);
        if (iso) {
            try px.isoState(key(a), m) returns (bool, int256 margin, int256 eq, uint256 im, uint256, uint256 rs) {
                int256 av = (margin < eq ? margin : eq) - int256(im) - int256(rs); return av > 0 ? uint256(av) : 0;
            } catch { return 0; }
        }
        try px.accountState(key(a)) returns (int256, uint256, uint256, uint256, uint256 av) { return av; } catch { return 0; }
    }

    function openPosition(uint256 tkS, uint256 mkS, uint256 mS, bool buy, uint256 fS) external {
        _fresh();
        address tk = _a(tkS); address mk = _a(mkS); uint8 m = uint8(mS % NM); if (tk == mk) return;
        uint256 cap = _freeMargin(tk, m); uint256 cap2 = _freeMargin(mk, m); if (cap2 < cap) cap = cap2;
        if (cap == 0) return;
        uint256 p = _rt(price[m], m);
        uint256 notional = cap * 9 * bound(fS, 30, 100) / 100;
        if (notional > 100_000e6) notional = 100_000e6 + (notional - 100_000e6) / 8;
        uint256 size = notional * 1e8 / p / lot[m] * lot[m];
        if (size == 0 || size > 100e8 || size * p / 1e8 < 10e6) return;
        (bool ok,) = _place(mk, m, !buy, p, size, PerpBase.TIF.GTC, false);
        if (ok) _place(tk, m, buy, p, size, PerpBase.TIF.IOC, false);
        _cancelAll(mk);
        _checkState("openPosition");
    }

    function _place(address a, uint8 m, bool isBuy, uint256 p, uint256 size, PerpBase.TIF tif, bool ro) internal returns (bool, bytes memory) {
        PerpBase.OrderParams memory o = PerpBase.OrderParams({market: m, isBuy: isBuy, price: uint64(p), size: uint128(size), tif: tif, reduceOnly: ro, cloid: 0, expiry: 0});
        return _call("place", a, abi.encodeCall(IPerp.placeOrder, (a, 0, o)));
    }
    function _cancelAll(address a) internal { _call("cancelAll", a, abi.encodeCall(IPerp.cancelAll, (a, 0))); }

    function close(uint256 aS, uint256 mS, uint256 pct) external {
        _fresh();
        address a = _a(aS); uint8 m = uint8(mS % NM); if (a == actors[6]) return;
        int256 s = pos(a, m); if (s == 0) return;
        uint256 sz = uint256(s > 0 ? s : -s) * bound(pct, 10, 100) / 100 / lot[m] * lot[m]; if (sz == 0) sz = lot[m];
        if (sz > uint256(s > 0 ? s : -s)) sz = uint256(s > 0 ? s : -s);
        uint256 p = _rt(price[m], m);
        (bool ok,) = _place(actors[6], m, s > 0, p, sz, PerpBase.TIF.GTC, false);
        if (ok) _place(a, m, s < 0, p, sz, PerpBase.TIF.IOC, true);
        _cancelAll(actors[6]);
        _checkState("close");
    }

    function premium(uint256 mS, int256 bps) external {
        _fresh();
        uint8 m = uint8(mS % NM); bps = bound(bps, -400, 400);
        uint256 p = _rt(uint256(int256(price[m]) * (10_000 + bps) / 10_000), m);
        _cancelAll(actors[6]);
        uint256 sz = lot[m] * (m == 0 ? 10 : 100);
        _place(actors[6], m, true, p, sz, PerpBase.TIF.GTC, false);
        _place(actors[6], m, false, p + tick[m], sz, PerpBase.TIF.GTC, false);
        for (uint256 i; i < 3; i++) {
            _call("poke", actors[7], abi.encodeCall(IStressPerp.pokeFunding, (m)));
            if (i < 2) { vm.warp(block.timestamp + 1900); _refresh(); }
        }
        _checkState("premium");
    }

    // ------------------------------------------------------------------ price shocks / oracle
    function shock(uint8 mode, uint256 mS, int256 bps, int256 bps2) external {
        bps = bound(bps, -6000, 15000); bps2 = bound(bps2, -6000, 15000);
        uint8 m = uint8(mS % NM); mode = mode % 5;
        if (mode == 0) _mv(m, bps);
        else if (mode == 1) { for (uint256 i; i < NM; i++) _mv(i, bps); }
        else if (mode == 2) { _mv(0, bps); _mv(1, bps2); _mv(2, (bps + bps2) / 2); }
        else if (mode == 3) { _mv(m, bps); _refresh(); _mv(m, -bps * 8 / 10); _mv((m + 1) % NM, bps2); }
        else { for (uint256 i; i < 3; i++) _mv(m, bps / 3); }
        _refresh();
        _checkState("shock");
    }
    function _mv(uint256 m, int256 bps) internal {
        int256 np = int256(price[m]) * (10_000 + bps) / 10_000;
        uint256 u = _rt(uint256(np < 0 ? int256(0) : np), m);
        if (u < px0[m] / 30) u = _rt(px0[m] / 30, m);
        if (u > px0[m] * 30) u = _rt(px0[m] * 30, m);
        price[m] = u;
    }
    function stale(uint256 mask) external { staleMask = bound(mask, 1, 7); vm.warp(block.timestamp + 70); _checkState("stale"); }
    function recover(int256 bps) external { staleMask = 0; bps = bound(bps, -2000, 3000); for (uint256 i; i < NM; i++) _mv(i, bps); _refresh(); _checkState("recover"); }
    function warp(uint256 dt) external { vm.warp(block.timestamp + bound(dt, 60, 40_000)); _refresh(); _checkState("warp"); }

    // ------------------------------------------------------------------ market state changes
    function setState(uint256 mS, uint8 s) external {
        uint8 m = uint8(mS % NM); if (delisted[m]) return; s = s % 5;
        px.setMarketState(m, PerpBase.State(s)); _checkState("setState");
    }
    function pause(bool on) external { px.setGlobalPause(on); }
    function delist(uint256 mS, int256 bps) external {
        uint8 m = uint8(mS % NM); if (delisted[m]) return; bps = bound(bps, -1000, 1000);
        px.setMarketState(m, PerpBase.State.ReduceOnly);
        px.delistMarket(m, uint64(_rt(uint256(int256(price[m]) * (10_000 + bps) / 10_000), m))); delisted[m] = true; _checkState("delist");
    }
    function settle(uint256 kS, uint256 aS, uint256 mS) external {
        uint8 m = uint8(mS % NM); if (!delisted[m]) return;
        bytes32 ka = key(_a(aS));
        (bool ok,) = _call("settle", _a(kS), abi.encodeCall(IStressPerp.settleDelisted, (ka, m)));
        if (ok && posK(ka, m) != 0) _flag("P1", "position not closed by settleDelisted");
        _checkState("settle");
    }
    function bsunwind(uint256 mS, uint256 pct) external {
        _fresh(); uint8 m = uint8(mS % NM); int256 bs = posK(BACK, m); if (bs == 0) return;
        uint256 a = uint256(bs > 0 ? bs : -bs); uint256 sz = a * bound(pct, 10, 100) / 100 / lot[m] * lot[m]; if (sz == 0) return;
        uint256 p = _rt(price[m], m);
        _place(actors[6], m, bs > 0, p, sz, PerpBase.TIF.GTC, false);
        PerpBase.OrderParams memory o = PerpBase.OrderParams({market: m, isBuy: bs < 0, price: uint64(p), size: uint128(sz), tif: PerpBase.TIF.IOC, reduceOnly: true, cloid: 0, expiry: 0});
        _call("backstopPlace", bsOp, abi.encodeCall(IPerp.backstopPlace, (o)));
        _cancelAll(actors[6]); _checkState("bsunwind");
    }

}
