// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test, Vm} from "forge-std/Test.sol";
import {IStressPerp} from "./StressHandler.sol";
import {PerpExchange} from "../src/PerpExchange.sol";
import {MockUSDC} from "../src/MockUSDC.sol";

interface IKeeperState {
    function leak() external view returns (uint256);
    function badSum() external view returns (uint256);
    function otherBad() external view returns (uint256);
    function clearedSum() external view returns (uint256);
    function recapSum() external view returns (uint256);
    function repaidSum() external view returns (uint256);
    function viol(bytes32) external view returns (uint256);
    function violMsg(bytes32) external view returns (string memory);
    function actors(uint256) external view returns (address);
}

/// @notice State-only invariant readers for the stress suite (third contract to stay under EIP-170).
contract StressChecks is Test {
    IStressPerp public px; PerpExchange public ex; MockUSDC public usdc; IKeeperState public K; bytes32 public BACK; uint256 constant NM = 3; address[] actors;
    function init(PerpExchange _ex, MockUSDC _usdc, address keeper) external {
        ex = _ex; px = IStressPerp(address(_ex)); usdc = _usdc; K = IKeeperState(keeper); BACK = _ex.BACKSTOP();
        for (uint256 i; i < 8; i++) actors.push(K.actors(i));
    }
    function key(address a) public pure returns (bytes32) { return keccak256(abi.encode(a, uint8(0))); }
    function pos(address a, uint256 m) public view returns (int256 s) { (s,,,,,) = px.positions(key(a), uint8(m)); }
    function posK(bytes32 k, uint256 m) public view returns (int256 s) { (s,,,,,) = px.positions(k, uint8(m)); }
    function leak() internal view returns (uint256) { return K.leak(); }
    function badSum() internal view returns (uint256) { return K.badSum() + K.otherBad(); }
    function clearedSum() internal view returns (uint256) { return K.clearedSum(); }
    function recapSum() internal view returns (uint256) { return K.recapSum(); }
    function repaidSum() internal view returns (uint256) { return K.repaidSum(); }
    function viol(bytes32 p) internal view returns (uint256) { return K.viol(p); }
    function violMsg(bytes32 p) internal view returns (string memory) { return K.violMsg(p); }
    function backstopEquity() public view returns (int256 eq) {
        eq = ex.collateral(BACK);
        for (uint256 m; m < NM; m++) {
            (int256 s, int256 basis,,, int256 im,) = px.positions(BACK, uint8(m));
            eq += im;
            if (s != 0) { try px.markPrice(uint8(m)) returns (uint256 mk) { eq += _fdiv(s * int256(mk) - basis, 1e8); } catch {} }
        }
    }
    function _fdiv(int256 a, int256 b) internal pure returns (int256 q) { q = a / b; if ((a % b != 0) && ((a < 0) != (b < 0))) q--; }

    function checkNetPosition() external view {
        for (uint256 m; m < NM; m++) {
            int256 net = posK(BACK, m); int256 longs = net > 0 ? net : int256(0);
            for (uint256 i; i < 8; i++) { int256 s = pos(actors[i], m); net += s; if (s > 0) longs += s; }
            require(net == 0, string.concat("P1: aggregate signed position (incl BACKSTOP) != 0 on market ", vm.toString(m), ": ", vm.toString(net)));
            require(uint256(px.getMarket(uint8(m)).oi) == uint256(longs), "P1: OI != sum of long sizes");
        }
    }

    /// exact identity in 1e-8 USDC: 1e8*(sumColl+sumIso+ins+fee+fund-ubd-(D-W)) + dust - sumBasis == -leak
    function ledgerResidual() public view returns (int256 E) {
        int256 sc = ex.collateral(BACK); int256 sb; int256 si;
        for (uint256 m; m < NM; m++) { (, int256 b,,, int256 im,) = px.positions(BACK, uint8(m)); sb += b; si += im; }
        for (uint256 i; i < 8; i++) {
            bytes32 k = key(actors[i]); sc += ex.collateral(k);
            for (uint256 m; m < NM; m++) { (, int256 b,,, int256 im,) = px.positions(k, uint8(m)); sb += b; si += im; }
        }
        int256 tracked = sc + si + int256(ex.insurance()) + ex.feePool() + ex.fundingPool() - int256(ex.unresolvedBadDebt()) - (int256(ex.totalDeposited()) - int256(ex.totalWithdrawn()));
        E = tracked * 1e8 + int256(ex.dustBasis()) - sb;
    }
    function checkLedger() external view {
        require(usdc.balanceOf(address(ex)) == ex.totalDeposited() - ex.totalWithdrawn(), "P2: USDC balance != deposited - withdrawn");
        int256 E = ledgerResidual();
        require(E + int256(leak()) == 0, string.concat("P2: ledger identity broken (isoMargin + open-position basis included): E=", vm.toString(E), " leak=", vm.toString(leak())));
    }
    function checkDebtSum() external view {
        uint256 s; for (uint256 m; m < NM; m++) s += px.adlDebt(uint8(m));
        require(s == ex.unresolvedBadDebt(), "P3a: unresolvedBadDebt != sum(adlDebt)");
        require(ex.unresolvedBadDebt() == badSum() - clearedSum() - recapSum() - repaidSum(), "P9: debt != bad debts recorded - ADL cleared - recapitalised - backstop repaid");
        require(ex.bsDebt() <= ex.unresolvedBadDebt(), "P9: bsDebt > unresolvedBadDebt");
    }
    function checkFunding() external view {
        int256 pend;
        for (uint256 m; m < NM; m++) {
            int256 idx = px.getMarket(uint8(m)).fundingIndex;
            (int256 sb,, int256 lb,,,) = px.positions(BACK, uint8(m)); pend += sb * (idx - lb);
            for (uint256 i; i < 8; i++) { (int256 s,, int256 l,,,) = px.positions(key(actors[i]), uint8(m)); pend += s * (idx - l); }
        }
        int256 Q = ex.fundingPool() * 1e14 + pend;
        require(Q >= 0 && Q < 4000 * 1e14, string.concat("FUND: funding not conserved incl. BACKSTOP: residue(1e-14)=", vm.toString(Q)));
    }
    function _parseLiqLogs(Vm.Log[] memory logs, uint8 m) public view returns (uint256 bad, uint256 toDebtHere, uint256 refund, uint256 repay) {
        bytes32 liqT = keccak256("Liquidated(bytes32,uint8,address,uint128,uint64,uint256,uint256)");
        bytes32 syncT = keccak256("BackstopSynced(int256,uint256,uint256,uint8,uint256,uint256)");
        for (uint256 i; i < logs.length; i++) {
            if (logs[i].emitter != address(ex)) continue;
            if (logs[i].topics[0] == liqT) { (,,, uint256 bd) = abi.decode(logs[i].data, (uint128, uint64, uint256, uint256)); bad = bd; }
            else if (logs[i].topics[0] == syncT) {
                (, , uint256 toDebt, uint256 rf, uint256 rp) = abi.decode(logs[i].data, (int256, uint256, uint256, uint256, uint256));
                if (uint8(uint256(logs[i].topics[1])) == m) toDebtHere += toDebt;
                refund += rf; repay += rp;
            }
        }
    }
    function checkViol(bytes32 p) external view { require(viol(p) == 0, string.concat(string(abi.encodePacked(p)), ": ", violMsg(p))); }
    /// P3/P11 (BACKSTOP-1 fixed): the oracle can move between transactions, so the invariant is evaluated on a hypothetical keeper
    /// `syncBackstop()` (state snapshot, reverted afterwards): after it the backstop bucket is non-negative, its marked equity is >= 0
    /// (stale feeds valued adversely by the contract), and a second sync changes nothing. Replaces the old "ins + E_B - ubd >= 0"
    /// predicate, which also failed on pre-existing, already-recorded debt.
    function checkProtocolBuffers() external {
        uint256 id = vm.snapshotState();
        px.syncBackstop();
        int256 eq = px.backstopEquity(); int256 cb = ex.collateral(BACK);
        uint256 ubd1 = ex.unresolvedBadDebt(); uint256 ins1 = ex.insurance();
        px.syncBackstop();
        bool idem = ex.unresolvedBadDebt() == ubd1 && ex.insurance() == ins1 && ex.collateral(BACK) == cb;
        vm.revertToState(id);
        require(cb >= 0, string.concat("P3: backstop collateral negative after sync: ", vm.toString(cb)));
        require(eq >= -2, string.concat("P11: backstop equity negative after sync: ", vm.toString(eq)));
        require(idem, "P11: syncBackstop not idempotent");
    }
}
