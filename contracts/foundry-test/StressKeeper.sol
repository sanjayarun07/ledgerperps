// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test, Vm} from "forge-std/Test.sol";
import {IPerp} from "./Deployer.sol";
import {IStressPerp} from "./StressHandler.sol";
import {PerpExchange} from "../src/PerpExchange.sol";
import {PerpBase} from "../src/PerpBase.sol";
import {MockUSDC} from "../src/MockUSDC.sol";

interface IChecks { function backstopEquity() external view returns (int256); function parseLiqLogs(Vm.Log[] memory logs, uint8 m) external view returns (uint256 bad, uint256 toDebtHere, uint256 refund, uint256 repay); }
interface IStressActions { function fresh() external; function actors(uint256) external view returns (address); function payer() external view returns (address); }

/// @notice Keeper half of the stress handler (split from StressHandler to stay under the EIP-170 limit enforced by foundry.toml).
///         Keepers (any actor) call liquidate / sweep / adl / recapitalize with exact expectation checks; also owns all
///         violation records and the state-only invariant readers.
contract StressKeeper is Test {
    IStressPerp public px;
    PerpExchange public ex;
    MockUSDC public usdc;
    IStressActions public H;
    bytes32 public BACK;
    uint256 constant NM = 3;
    address[] public actors;
    address public payer;
    mapping(bytes32 => uint256) public viol;
    mapping(bytes32 => string) public violMsg;
    mapping(bytes32 => uint256) public calls;
    mapping(bytes32 => uint256) public okCalls;
    uint256 public leak; uint256 public otherBad; uint256 public badSum; uint256 public clearedSum; uint256 public recapSum; uint256 public repaidSum;
    int256 public minBackstopEq;
    uint256 public liqCount; uint256 public adlCount; uint256 public liveFails;
    bool public inited;
    IChecks public CH;
    function setChecks(address c) external { CH = IChecks(c); }

    function init(PerpExchange _ex, MockUSDC _usdc, address hAddr) external {
        IStressActions _h = IStressActions(hAddr);
        require(!inited, "inited"); inited = true;
        ex = _ex; px = IStressPerp(address(_ex)); usdc = _usdc; H = _h; BACK = _ex.BACKSTOP();
        for (uint256 i; i < 8; i++) actors.push(_h.actors(i));
        payer = _h.payer();
    }

    function key(address a) public pure returns (bytes32) { return keccak256(abi.encode(a, uint8(0))); }
    function _a(uint256 s) internal view returns (address) { return actors[s % 8]; }
    function addAdl(uint256 leak_, uint256 cleared) external { vm.writeLine("cache-forge/stress-telemetry.txt", "adl"); leak += leak_; clearedSum += cleared; adlCount++; }
    function flag(bytes32 p, string memory msg_) public { _flag(p, msg_); }
    function _flag(bytes32 p, string memory msg_) internal { if (viol[p] == 0) violMsg[p] = msg_; viol[p]++; }
    function pos(address a, uint256 m) public view returns (int256 s) { (s,,,,,) = px.positions(key(a), uint8(m)); }
    function posK(bytes32 k, uint256 m) public view returns (int256 s) { (s,,,,,) = px.positions(k, uint8(m)); }
    function _fresh() internal { H.fresh(); }

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

    // ------------------------------------------------------------------ keepers
    enum Exp { Success, NotLiquidatable, OracleDegraded, MarketRestricted, NoPosition, StaleUnrelated }
    function _expect(bytes32 a, uint8 m) internal view returns (Exp, int256 eq, uint256 mm) {
        PerpBase.State st = px.getMarket(m).state;
        if (st == PerpBase.State.Paused || st == PerpBase.State.OracleDegraded) return (Exp.MarketRestricted, 0, 0);
        (int256 size,,, bool iso,,) = px.positions(a, m);
        if (iso) { try px.isoState(a, m) returns (bool, int256, int256 e, uint256, uint256 mm_, uint256) { eq = e; mm = mm_; } catch { return (Exp.OracleDegraded, 0, 0); } }
        else {
            try px.accountState(a) returns (int256 e, uint256, uint256 mm_, uint256, uint256) { eq = e; mm = mm_; }
            catch {
                // LIQ-1 rule: another stale held market is valued in the account's favour, so the liquidation outcome
                // (Success or NotLiquidatable) is decided by the contract; only the liquidated market must have a valid mark.
                if (size == 0) return (Exp.StaleUnrelated, 0, 0);
                try px.markPrice(m) returns (uint256) { return (Exp.StaleUnrelated, 0, 0); } catch { return (Exp.OracleDegraded, 0, 0); }
            }
        }
        if (eq >= int256(mm)) return (Exp.NotLiquidatable, eq, mm);
        if (size == 0) return (Exp.NoPosition, eq, mm);
        return (Exp.Success, eq, mm);
    }

    function liquidate(uint256 kS, uint256 aS, uint256 mS) external { _fresh(); _liq(_a(kS), _a(aS), uint8(mS % NM)); _checkState("liquidate"); }

    function sweep(uint256 kS, uint256 seed) external {
        _fresh();
        address k = _a(kS);
        for (uint256 r; r < 3; r++)
            for (uint256 i; i < 8; i++) {
                address a = actors[(i + seed + r) % 8];
                for (uint256 m; m < NM; m++) {
                    if (pos(a, m) == 0) continue;
                    (Exp e,,) = _expect(key(a), uint8(m));
                    if (e == Exp.Success) _liq(k, a, uint8(m));
                }
            }
        _checkState("sweep");
    }

    function _liq(address keeper, address a, uint8 m) internal {
        _fresh();
        bytes32 ka = key(a);
        (Exp e, int256 eq, uint256 mm) = _expect(ka, m);
        int256 v0 = pos(a, m); int256 b0 = posK(BACK, m);
        uint256 ubd0 = ex.unresolvedBadDebt(); uint256 ins0 = ex.insurance(); uint256 ad0 = px.adlDebt(m);
        vm.recordLogs();
        int256[8] memory coll0; int256[8] memory iso0;
        for (uint256 i; i < 8; i++) { coll0[i] = ex.collateral(key(actors[i])); iso0[i] = _isoSum(actors[i]); }
        bool fundingClean = _fundingClean(ka);
        (bool ok, bytes memory ret) = _call("liquidate", keeper, abi.encodeCall(IPerp.liquidate, (ka, m)));
        Vm.Log[] memory logs = vm.getRecordedLogs();
        if (!ok) {
            bytes4 s = _sel(ret);
            Exp got = s == PerpBase.NotLiquidatable.selector ? Exp.NotLiquidatable : s == PerpBase.OracleDegraded.selector ? Exp.OracleDegraded : s == PerpBase.MarketRestricted.selector ? Exp.MarketRestricted : _isNoPos(ret) ? Exp.NoPosition : Exp.Success;
            if (e == Exp.StaleUnrelated && (got == Exp.NotLiquidatable || got == Exp.NoPosition)) return;
            if (got != e || (e == Exp.Success)) {
                if (e == Exp.Success) { liveFails++; _flag("P10", string.concat("underwater position not liquidatable: eq=", vm.toString(eq), " mm=", vm.toString(mm), " (valid oracle, market open)")); }
                else _flag("P5", "liquidate reverted with an unexpected reason");
            }
            return;
        }
        liqCount++; vm.writeLine("cache-forge/stress-telemetry.txt", "liquidation");
        if (e != Exp.Success && e != Exp.StaleUnrelated) _flag("P5", string.concat("liquidation SUCCEEDED but expected ", vm.toString(uint256(e)), " eq=", vm.toString(eq), " mm=", vm.toString(mm)));
        int256 v1 = pos(a, m); int256 b1 = posK(BACKSTOP_(), m);
        int256 closed = v0 - v1; // signed amount that moved from victim to backstop
        if (closed == 0 || (v0 > 0) != (closed > 0) || (closed > 0 ? closed > v0 : -closed > -v0)) _flag("P5", "victim position change inconsistent");
        if (b1 - b0 != closed) _flag("P5", "backstop did not receive exactly the closed size");
        // victim bad debt from the Liquidated event; the backstop sync in the same tx may add (BackstopSynced.toDebt, attributed to its
        // own market) or repay debt/insurance: those are accounted separately by track()
        (uint256 bad, uint256 syncToDebtHere, uint256 syncRefund, uint256 syncRepay) = CH.parseLiqLogs(logs, m);
        badSum += bad; if (bad > 0) vm.writeLine("cache-forge/stress-telemetry.txt", "baddebt");
        if (syncRepay == 0 && px.adlDebt(m) - ad0 != bad + syncToDebtHere) _flag("P3a", "P3a adlDebt delta");
        if (bad > 0 && ex.insurance() > syncRefund) _flag("P8", "bad debt recorded while insurance non-zero");
        if (ex.insurance() > ins0 + _feeUpper(closed, m) + syncRefund) _flag("P8", "P8 insurance grew too much");
        // bucket isolation (P4): everyone except victim, keeper and BACKSTOP is untouched; victim cross bucket only moves for cross liquidations
        (, , , bool visIso, , ) = px.positions(ka, m); // post state flag is unchanged by liquidation
        for (uint256 i; i < 8; i++) {
            address x = actors[i];
            if (x == a || x == keeper) continue;
            if (ex.collateral(key(x)) != coll0[i] || _isoSum(x) != iso0[i]) _flag("P4", "an unrelated account's bucket changed during liquidation");
        }
        if (visIso && fundingClean && a != keeper && ex.collateral(ka) != coll0[_idx(a)]) _flag("P4", "isolated liquidation charged/credited the victim's CROSS collateral");
        if (!visIso && fundingClean && _isoSum(a) != iso0[_idx(a)]) _flag("P4", "cross liquidation changed the victim's isolated margin");
    }
    function BACKSTOP_() internal view returns (bytes32) { return BACK; }
    function _idx(address a) internal view returns (uint256) { for (uint256 i; i < 8; i++) if (actors[i] == a) return i; return 0; }
    function _feeUpper(int256 closed, uint8 m) internal view returns (uint256) {
        uint256 c = uint256(closed < 0 ? -closed : closed); uint256 p = px.markPrice(m);
        return (c * p / 1e8) * 50 / 10_000 + 2;
    }
    function _isoSum(address a) internal view returns (int256 t) { for (uint256 m; m < NM; m++) { (,,,, int256 im,) = px.positions(key(a), uint8(m)); t += im; } }
    function _fundingClean(bytes32 k) internal view returns (bool) {
        for (uint256 m; m < NM; m++) { (int256 s,, int256 last,,,) = px.positions(k, uint8(m)); if (s != 0 && last != px.getMarket(uint8(m)).fundingIndex) return false; }
        return true;
    }

    function recapitalize(uint256 mS, uint256 pct) external {
        uint8 m = uint8(mS % NM); uint256 d = px.adlDebt(m); if (d == 0) return;
        uint256 amt = d * bound(pct, 1, 100) / 100; if (amt == 0) amt = 1;
        uint256 ad0 = d;
        (bool ok,) = _call("recap", payer, abi.encodeCall(IPerp.recapitalize, (m, amt)));
        if (!ok) { _flag("P9", "recapitalize reverted"); return; }
        recapSum += amt;
        if (px.adlDebt(m) != ad0 - amt) _flag("P9", "recapitalize did not reduce adlDebt exactly");
        _checkState("recap");
    }

    function poke(uint256 mS) external { _fresh(); _call("poke", actors[7], abi.encodeCall(IStressPerp.pokeFunding, (uint8(mS % NM)))); _checkState("poke"); }


    // ------------------------------------------------------------------ state invariants
    function _checkState(string memory) internal { track(); }
    function track() public {
        // bad debt can also be recorded outside liquidate(): in-fill write-off of a flat negative account, settleDelisted
        // debt recorded outside liquidate() (in-fill/settleDelisted write-offs, backstop sync) goes to otherBad; unexplained decreases are
        // backstop-sync repayments (bounded by what was ever recorded, and bsDebt <= ubd must hold)
        uint256 act = ex.unresolvedBadDebt(); uint256 expd = badSum + otherBad - clearedSum - recapSum - repaidSum;
        if (act > expd) { otherBad += act - expd; }
        else if (act < expd) { repaidSum += expd - act; if (repaidSum > badSum + otherBad) _flag("P9", "P9 over-repaid"); }
        if (ex.bsDebt() > act) _flag("P9", "P9 bsDebt>ubd");
        int256 be = CH.backstopEquity();
        if (be < minBackstopEq) minBackstopEq = be;
    }



    function donate(uint256 amt) external { uint256 ins0 = ex.insurance(); amt = bound(amt, 1e6, 3_000e6); _call("donate", payer, abi.encodeCall(PerpExchange.fundInsurance, (amt))); if (ex.insurance() != ins0 + amt) _flag("P8", "fundInsurance credited wrong amount"); _checkState("donate"); }

}
