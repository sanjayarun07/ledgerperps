// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test, Vm} from "forge-std/Test.sol";
import {IPerp} from "./Deployer.sol";
import {IStressPerp} from "./StressHandler.sol";
import {PerpExchange} from "../src/PerpExchange.sol";
import {PerpBase} from "../src/PerpBase.sol";

interface IStressKeeperLike {
    function flag(bytes32, string memory) external;
    function addAdl(uint256 leak_, uint256 cleared) external;
    function track() external;
    function actors(uint256) external view returns (address);
}
interface IFresh { function fresh() external; }

/// @notice ADL keeper action with exact bound checks (P7, P3a), split out of StressKeeper for the EIP-170 limit.
contract StressAdl is Test {
    IStressPerp px; PerpExchange ex; IStressKeeperLike K; IFresh H; bytes32 BACK; address[] actors; uint256 constant NM = 3; bool inited;
    function init(PerpExchange _ex, address keeper, address handler) external {
        require(!inited); inited = true;
        ex = _ex; px = IStressPerp(address(_ex)); K = IStressKeeperLike(keeper); H = IFresh(handler); BACK = _ex.BACKSTOP();
        for (uint256 i; i < 8; i++) actors.push(K.actors(i));
    }
    function key(address a) public pure returns (bytes32) { return keccak256(abi.encode(a, uint8(0))); }
    function _a(uint256 s) internal view returns (address) { return actors[s % 8]; }
    function pos(address a, uint256 m) public view returns (int256 s) { (s,,,,,) = px.positions(key(a), uint8(m)); }
    function posK(bytes32 k, uint256 m) public view returns (int256 s) { (s,,,,,) = px.positions(k, uint8(m)); }
    function _fresh() internal { H.fresh(); }
    function _sel(bytes memory ret) internal pure returns (bytes4 s) { if (ret.length >= 4) assembly { s := mload(add(ret, 32)) } }
    function _call(bytes32, address from, bytes memory data) internal returns (bool ok, bytes memory ret) {
        vm.prank(from);
        (ok, ret) = address(ex).call(data);
        if (!ok && (ret.length < 4 || _sel(ret) == 0x4e487b71)) K.flag("P0", "panic or empty revert in adl");
    }

    function adl(uint256 kS, uint256 mS, uint8 mode) external {
        _fresh();
        uint8 m = uint8(mS % NM); address k = _a(kS);
        bytes32[] memory list = _rank(m, mode % 4 == 3 ? 1 : 8);
        if (mode % 4 == 1 && list.length > 1) { bytes32 t = list[0]; list[0] = list[list.length - 1]; list[list.length - 1] = t; } // unranked
        if (list.length == 0) { list = new bytes32[](1); list[0] = key(actors[0]); }
        uint256 ad0 = px.adlDebt(m); uint256 ubd0 = ex.unresolvedBadDebt(); uint256 mark; try px.markPrice(m) returns (uint256 mk) { mark = mk; } catch {}
        int256 bs0 = posK(BACK, m); uint256 bsDebt0 = ex.bsDebt();
        vm.recordLogs();
        (bool ok, bytes memory ret) = _call("adl", k, abi.encodeCall(IPerp.adl, (list, m)));
        Vm.Log[] memory logs = vm.getRecordedLogs();
        if (!ok) { bytes4 s = _sel(ret); if (s != PerpBase.BadParam.selector && s != PerpBase.MarketRestricted.selector && s != PerpBase.OracleDegraded.selector) K.flag("P0", "adl: unexpected revert"); return; }
        uint256 cleared; uint256 leak_; uint256 syncBad;
        bytes32 syncT = keccak256("BackstopSynced(int256,uint256,uint256,uint8,uint256,uint256)");
        for (uint256 i; i < logs.length; i++) if (logs[i].emitter == address(ex) && logs[i].topics[0] == syncT) { (,, uint256 tb,,) = abi.decode(logs[i].data, (int256, uint256, uint256, uint256, uint256)); syncBad += tb; }
        if (ex.unresolvedBadDebt() > ubd0 + syncBad) K.flag("P7", "debt increased through adl() beyond backstop sync");
        for (uint256 i; i < logs.length; i++) {
            if (logs[i].emitter != address(ex) || logs[i].topics[0] != keccak256("AdlExecuted(bytes32,uint8,uint128,uint64,uint256)")) continue;
            (uint128 sz, uint64 pT, uint256 c) = abi.decode(logs[i].data, (uint128, uint64, uint256));
            cleared += c;
            bool targetLong = bs0 < 0; // target is opposite to the backstop
            uint256 prem = targetLong ? (mark > pT ? mark - pT : 0) : (pT > mark ? pT - mark : 0);
            if (prem * 10_000 > mark * (bsDebt0 > 0 ? 10_000 : 2500)) K.flag("P7", "ADL premium above the ADL ceiling");
            uint256 raw = uint256(sz) * prem; uint256 cc = c * 1e8;
            if (raw >= cc) leak_ += raw - cc; else K.flag("P7", "ADL cleared more debt than the concession taken from the target");
        }
        K.addAdl(leak_, cleared);
        // ubd after = ubd0 - cleared + (sync debt) - (sync repay); repay is covered by the P9 bound in track()
        if (ubd0 + syncBad < cleared || ex.unresolvedBadDebt() > ubd0 + syncBad - cleared) K.flag("P3a", "unresolvedBadDebt after adl > before - cleared + sync debt");
        K.track();
    }
    function syncBackstop(uint256 kS) external {
        _fresh();
        (bool ok,) = _call("sync", _a(kS), abi.encodeCall(IStressPerp.syncBackstop, ()));
        if (!ok) { K.flag("P0", "syncBackstop reverted"); return; }
        uint256 ubd1 = ex.unresolvedBadDebt(); int256 cb = ex.collateral(BACK);
        if (cb < 0) K.flag("P11", "backstop collateral negative after sync");
        (bool ok2, bytes memory r2) = address(ex).call(abi.encodeCall(IStressPerp.syncBackstop, ()));
        if (!ok2 || ex.unresolvedBadDebt() != ubd1 || ex.collateral(BACK) != cb) K.flag("P11", string.concat("sync not idempotent ", string(r2)));
        K.track();
    }

    function deposit(uint256 aS, uint256 amt) external { address a = _a(aS); amt = bound(amt, 1e6, 5_000e6); _call("deposit", a, abi.encodeCall(PerpExchange.deposit, (a, 0, amt))); K.track(); }
    function withdraw(uint256 aS, uint256 amt) external { address a = _a(aS); _fresh(); _call("withdraw", a, abi.encodeCall(PerpExchange.withdraw, (0, bound(amt, 1e6, 30_000e6)))); K.track(); }
    function rebalance(uint256 pct, bool back) external {
        int256 amt = back ? -int256(uint256(ex.collateral(BACK) > 0 ? uint256(ex.collateral(BACK)) : 0) * bound(pct, 1, 100) / 100) : int256(ex.insurance() * bound(pct, 1, 100) / 100);
        if (amt == 0) return;
        px.rebalanceBackstop(amt); K.track();
    }

    function _rank(uint8 m, uint256 maxN) internal view returns (bytes32[] memory out) {
        bytes32[] memory tmp = new bytes32[](8); uint256[] memory sc = new uint256[](8); uint256 n;
        int256 bs = posK(BACK, m);
        for (uint256 i; i < 8; i++) {
            bytes32 k = key(actors[i]); int256 s = pos(actors[i], m);
            if (s == 0 || bs == 0 || (s > 0) == (bs > 0)) continue;
            try px.adlScore(k, m) returns (uint256 x) { if (x == 0) continue; tmp[n] = k; sc[n] = x; n++; } catch {}
        }
        for (uint256 i; i < n; i++) for (uint256 j = i + 1; j < n; j++) if (sc[j] > sc[i] || (sc[j] == sc[i] && tmp[j] < tmp[i])) { (sc[i], sc[j]) = (sc[j], sc[i]); (tmp[i], tmp[j]) = (tmp[j], tmp[i]); }
        uint256 len = n < maxN ? n : maxN;
        out = new bytes32[](len); for (uint256 i; i < len; i++) out[i] = tmp[i];
    }


}
