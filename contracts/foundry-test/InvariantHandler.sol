// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {IPerp} from "./Deployer.sol";
import {PerpExchange} from "../src/PerpExchange.sol";
import {PerpBase} from "../src/PerpBase.sol";
import {MockUSDC} from "../src/MockUSDC.sol";
import {ManualOracle} from "../src/oracles/ManualOracle.sol";

/// @notice Bounded-actor handler. Every protocol call goes through `_call`, which NEVER lets a revert escape and
///         classifies revert data, so Panic(uint256) reverts (compiler-inserted checks: overflow, div-by-zero, array OOB,
///         bad enum...) are COUNTED instead of being swallowed by `fail_on_revert = false`.
///         The `check*` functions hold the invariants; they revert with a descriptive message on violation.
contract InvariantHandler is Test {
    PerpExchange public ex;
    IPerp public px;
    MockUSDC public usdc;
    ManualOracle public oracle;
    bytes32 constant FEED = keccak256("BTC-USD");
    bytes32 public BACK;

    address[] public actors;
    address public keeper = address(0xBEEF);
    uint64 cloidCtr = 1;

    // ---- bookkeeping / telemetry
    uint256 public panicCount;
    uint256 public lastPanicCode;
    bytes public lastPanicCalldata;
    string public lastPanicWhere;
    mapping(bytes4 => uint256) public revertsBySelector; // custom-error / Error(string) counts
    mapping(bytes32 => uint256) public okCalls;
    mapping(bytes32 => uint256) public revertedCalls;
    string[] public actionNames;
    uint256 public liquidations; uint256 public adls; uint256 public fills;

    constructor(PerpExchange _ex, MockUSDC _usdc, ManualOracle _oracle, uint256 nActors) {
        ex = _ex; px = IPerp(address(_ex)); usdc = _usdc; oracle = _oracle;
        BACK = _ex.BACKSTOP();
        for (uint256 i; i < nActors; i++) {
            address a = makeAddr(string.concat("actor", vm.toString(i)));
            actors.push(a);
            usdc.mint(a, 2_000_000e6);
            vm.prank(a); usdc.approve(address(_ex), type(uint256).max);
            vm.prank(a); _ex.deposit(a, 0, 10_000e6);
        }
        usdc.mint(keeper, 2_000_000e6);
        vm.prank(keeper); usdc.approve(address(_ex), type(uint256).max);
    }

    function actorCount() external view returns (uint256) { return actors.length; }
    function key(address a) public pure returns (bytes32) { return keccak256(abi.encode(a, uint8(0))); }
    function _actor(uint256 s) internal view returns (address) { return actors[s % actors.length]; }

    // ================================================================= call wrapper with Panic tracking
    function _call(string memory name, address from, address target, bytes memory data) internal returns (bool ok, bytes memory ret) {
        vm.prank(from);
        (ok, ret) = target.call(data);
        bytes32 h = keccak256(bytes(name));
        if (ok) { okCalls[h]++; return (ok, ret); }
        revertedCalls[h]++;
        if (ret.length >= 4) {
            bytes4 sel;
            assembly { sel := mload(add(ret, 32)) }
            if (sel == 0x4e487b71) { // Panic(uint256)
                panicCount++;
                lastPanicWhere = name;
                lastPanicCalldata = data;
                if (ret.length >= 36) { uint256 c; assembly { c := mload(add(ret, 36)) } lastPanicCode = c; }
            } else {
                revertsBySelector[sel]++;
            }
        } else {
            revertsBySelector[bytes4(0)]++; // empty revert data
        }
    }

    // ================================================================= actions
    function deposit(uint256 aSeed, uint256 amt) external {
        address a = _actor(aSeed);
        amt = bound(amt, 1e6, 50_000e6);
        usdc.mint(a, amt);
        _call("deposit", a, address(ex), abi.encodeCall(PerpExchange.deposit, (a, 0, amt)));
    }

    function withdraw(uint256 aSeed, uint256 pct, bool tooMuch) external {
        address a = _actor(aSeed);
        uint256 w;
        try ex.withdrawable(key(a)) returns (uint256 x) { w = x; } catch { w = 0; }
        uint256 amt = w * bound(pct, 0, 100) / 100;
        if (tooMuch) amt = w + 1 + (pct % 1000);
        if (amt == 0) return;
        _call("withdraw", a, address(ex), abi.encodeCall(PerpExchange.withdraw, (0, amt)));
    }

    function placeOrder(uint256 aSeed, int256 offs, uint256 sz, uint8 tifSeed, bool isBuy, bool ro, uint8 flags) external {
        address a = _actor(aSeed);
        _call("placeOrder", a, address(ex), abi.encodeCall(IPerp.placeOrder, (a, 0, _params(offs, sz, tifSeed, isBuy, ro, flags))));
    }

    function _params(int256 offs, uint256 sz, uint8 tifSeed, bool isBuy, bool ro, uint8 flags) internal returns (PerpBase.OrderParams memory p) {
        (uint256 ref,) = oracle.latest(FEED);
        int256 pxi = int256(ref / 1e5) + bound(offs, -25, 25) * 10; // +-$25 around index, $1 steps
        if (pxi < 1) pxi = 1;
        p.market = 0;
        p.isBuy = isBuy;
        p.price = uint64(uint256(pxi) * 1e5);
        p.size = uint128(bound(sz, 1, 150) * 1e6); // 0.01 .. 1.5 BTC
        p.tif = PerpBase.TIF(tifSeed % 4);
        p.reduceOnly = ro && (flags % 4 == 0);
        p.cloid = (flags % 8 == 1) ? cloidCtr++ : 0;
        p.expiry = (flags % 16 == 2) ? uint64(block.timestamp + 1 + (flags % 5) * 100) : 0;
    }

    /// aggressive order: priced through the opposite top-of-book (or index when empty) so fills actually happen
    function takeBest(uint256 aSeed, uint256 sz, bool isBuy, bool ro, uint8 tifSeed) external {
        address a = _actor(aSeed);
        uint64 top = ex.bestPrice(0, !isBuy);
        (uint256 ref,) = oracle.latest(FEED);
        uint256 p = top != 0 ? top : (ref / 1e5) * 1e5;
        PerpBase.OrderParams memory o = _params(0, sz, tifSeed, isBuy, ro, 0);
        o.price = uint64(isBuy ? p + 50e6 : (p > 100e6 ? p - 50e6 : p));
        o.price = (o.price / 1e5) * 1e5;
        _call("placeOrder", a, address(ex), abi.encodeCall(IPerp.placeOrder, (a, 0, o)));
    }

    function cancelOrder(uint256 aSeed, uint256 idx) external {
        address a = _actor(aSeed);
        uint256[] memory ids = px.openOrderIds(key(a));
        if (ids.length == 0) return;
        _call("cancelOrder", a, address(ex), abi.encodeCall(IPerp.cancelOrder, (uint64(ids[idx % ids.length]))));
    }

    function cancelAll(uint256 aSeed) external {
        address a = _actor(aSeed);
        _call("cancelAll", a, address(ex), abi.encodeCall(IPerp.cancelAll, (a, 0)));
    }

    function replaceOrder(uint256 aSeed, uint256 idx, int256 offs, uint256 sz, uint8 tifSeed, bool isBuy, uint8 flags) external {
        address a = _actor(aSeed);
        uint256[] memory ids = px.openOrderIds(key(a));
        if (ids.length == 0) return;
        PerpBase.OrderParams memory p = _params(offs, sz, tifSeed, isBuy, false, flags);
        _call("replaceOrder", a, address(ex), abi.encodeCall(IPerp.replaceOrder, (uint64(ids[idx % ids.length]), p)));
    }

    /// oracle move; timestamp is refreshed by `set` (block.timestamp)
    function moveOracle(int256 bps) external {
        (uint256 cur,) = oracle.latest(FEED);
        bps = bound(bps, -1500, 1500);
        uint256 n = uint256(int256(cur) * (10_000 + bps) / 10_000);
        if (n < 20_000e6) n = 20_000e6;
        if (n > 120_000e6) n = 120_000e6;
        vm.prank(oracle.owner());
        oracle.set(FEED, n);
    }

    function warp(uint256 dt, bool refresh) external {
        dt = bound(dt, 1, 9 hours);
        vm.warp(block.timestamp + dt);
        (uint256 cur,) = oracle.latest(FEED);
        if (refresh || dt % 50 != 0) { vm.prank(oracle.owner()); oracle.set(FEED, cur); } // else the oracle goes stale: trading must revert OracleDegraded, never Panic
    }

    function pokeFunding() external {
        _call("pokeFunding", keeper, address(ex), abi.encodeCall(PerpExchange.pokeFunding, (0)));
    }

    function liquidate(uint256 aSeed) external {
        address a = _actor(aSeed);
        (bool ok,) = _call("liquidate", keeper, address(ex), abi.encodeCall(IPerp.liquidate, (key(a), 0)));
        if (ok) { liquidations++; vm.writeLine("cache-forge/inv-telemetry.txt", "liquidate"); if (ex.unresolvedBadDebt() > 0) vm.writeLine("cache-forge/inv-telemetry.txt", "baddebt"); }
    }

    function adl(uint256 aSeed, uint256) external {
        // pick the best-scoring actor (a keeper would publish the true ranking); fall back to a random one
        bytes32 best = key(_actor(aSeed)); uint256 bestScore;
        for (uint256 i; i < actors.length; i++) {
            try px.adlScore(key(actors[i]), 0) returns (uint256 sc) { if (sc > bestScore) { bestScore = sc; best = key(actors[i]); } } catch {}
        }
        bytes32[] memory t = new bytes32[](1);
        t[0] = best;
        (bool ok,) = _call("adl", keeper, address(ex), abi.encodeCall(IPerp.adl, (t, 0)));
        if (ok) { adls++; vm.writeLine("cache-forge/inv-telemetry.txt", "adl"); }
    }

    function recapitalize(uint256 amt) external {
        uint256 d = ex.adlDebt(0);
        if (d == 0) return;
        amt = bound(amt, 1, d);
        usdc.mint(keeper, amt);
        _call("recapitalize", keeper, address(ex), abi.encodeCall(IPerp.recapitalize, (0, amt)));
    }

    function fundInsurance(uint256 amt) external {
        amt = bound(amt, 1, 5_000e6);
        usdc.mint(keeper, amt);
        _call("fundInsurance", keeper, address(ex), abi.encodeCall(PerpExchange.fundInsurance, (amt)));
    }

    // ================================================================= invariants
    function _sizeOf(bytes32 k) internal view returns (int256 s) { (s,,,,,) = ex.positions(k, 0); }

    function checkNetPosition() external view {
        int256 sum = _sizeOf(BACK);
        for (uint256 i; i < actors.length; i++) sum += _sizeOf(key(actors[i]));
        require(sum == 0, "aggregate signed position (incl BACKSTOP) != 0");
    }

    function checkOpenInterest() external view {
        int256 pos = _sizeOf(BACK) > 0 ? _sizeOf(BACK) : int256(0);
        for (uint256 i; i < actors.length; i++) { int256 s = _sizeOf(key(actors[i])); if (s > 0) pos += s; }
        require(uint256(px.getMarket(0).oi) == uint256(pos), "OI != sum of positive sizes");
    }

    function checkLedgerBalance() external view {
        require(usdc.balanceOf(address(ex)) == ex.totalDeposited() - ex.totalWithdrawn(), "USDC balance != deposited - withdrawn");
    }

    function checkReserved() external view {
        for (uint256 i; i < actors.length; i++) {
            bytes32 k = key(actors[i]);
            uint256[] memory ids = px.openOrderIds(k);
            uint256 s;
            for (uint256 j; j < ids.length; j++) { (, , uint128 rsv,,,,,,,,) = ex.orders(uint64(ids[j])); s += rsv; }
            require(ex.reserved(k) == s, "reserved != sum of open-order reserves");
            require(ids.length <= 32, "too many open orders");
        }
    }

    function checkBook() external view {
        uint256 inBook = _walkSide(true) + _walkSide(false);
        uint64 bb = ex.bestPrice(0, true); uint64 ba = ex.bestPrice(0, false);
        if (bb != 0 && ba != 0) require(bb < ba, "book crossed");
        uint256 owned;
        for (uint256 i; i < actors.length; i++) owned += px.openOrderIds(key(actors[i])).length;
        require(owned == inBook, "orders in book != orders in per-account sets");
    }

    function _walkSide(bool side) internal view returns (uint256 n) {
        uint64 cur = ex.bestPrice(0, side);
        uint64 prevPx;
        while (cur != 0) {
            if (prevPx != 0) require(side ? cur < prevPx : cur > prevPx, "levels not sorted");
            PerpBase.Level memory L = px.getLevel(0, side, cur);
            require(L.head != 0 && L.total > 0, "empty level linked in book");
            require(L.prevPrice == prevPx, "level prev link broken");
            n += _walkLevel(side, cur, L);
            prevPx = cur; cur = L.nextPrice;
        }
    }

    function _walkLevel(bool side, uint64 cur, PerpBase.Level memory L) internal view returns (uint256 n) {
        uint64 id = L.head; uint64 prevId; uint256 sum;
        while (id != 0) {
            (, uint128 size,, uint64 price_, , uint64 oprev, uint64 onext,, uint8 m, bool isBuy,) = ex.orders(id);
            require(size > 0, "zero-size order in level");
            require(price_ == cur && isBuy == side && m == 0, "order in wrong level");
            require(oprev == prevId, "order prev link broken");
            sum += size; n++;
            prevId = id; id = onext;
        }
        require(prevId == L.tail, "tail mismatch");
        require(sum == L.total, "level.total != sum of order sizes");
    }

    function checkNoPanics() external view {
        require(panicCount == 0, string.concat("Panic(", vm.toString(lastPanicCode), ") in ", lastPanicWhere));
    }

}
