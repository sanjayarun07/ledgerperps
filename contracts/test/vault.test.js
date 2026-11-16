const { expect } = require("chai");
const { ethers, loadFixture, time, usd, btc, TIF, order, deploy, setPx, ledger } = require("./helpers");

const px = (n) => usd(n);
const LOCK = 3600;

describe("MarketMakerVault", () => {
  async function setup() {
    const e = await deploy();
    const { ex, usdc, admin, alice, bob, carol, agent, guardian } = e;
    const vault = await (await ethers.getContractFactory("MarketMakerVault")).deploy(
      await usdc.getAddress(), await ex.getAddress(), 5, admin.address, usd(500_000), LOCK);
    await usdc.connect(alice).approve(await vault.getAddress(), ethers.MaxUint256);
    await usdc.connect(bob).approve(await vault.getAddress(), ethers.MaxUint256);
    await ex.connect(carol).deposit(carol.address, 0, usd(100_000)); // a counterparty
    const vkey = await ex.acctKey(await vault.getAddress(), 5);
    const expiry = (await time.latest()) + 30 * 86400;
    await vault.connect(admin).setOperator(agent.address, expiry, 1n, usd(200_000)); // market 0 only
    return { ...e, vault, vkey, expiry };
  }
  const dep = (v, s, n, min = 0n) => v.connect(s).deposit(usd(n), s.address, min);
  const eqOf = async (ex, k) => (await ex.accountState(k)).equity;

  it("first deposit mints shares and puts the USDC on the exchange as the vault's collateral", async () => {
    const { vault, ex, alice, vkey } = await loadFixture(setup);
    await dep(vault, alice, 10_000);
    expect(await ex.collateral(vkey)).to.equal(usd(10_000));
    expect(await vault.totalAssets()).to.equal(usd(10_000));
    expect(await vault.balanceOf(alice.address)).to.be.gt(0n);
    expect(await vault.convertToAssets(await vault.balanceOf(alice.address))).to.be.closeTo(usd(10_000), 10n);
  });

  it("a second depositor gets the same share price", async () => {
    const { vault, alice, bob } = await loadFixture(setup);
    await dep(vault, alice, 10_000); await dep(vault, bob, 10_000);
    const [a, b] = [await vault.balanceOf(alice.address), await vault.balanceOf(bob.address)];
    expect(a).to.be.closeTo(b, a / 1_000_000n + 2n);
  });

  it("the operator trades the vault account with the scoped key and NAV follows its PnL", async () => {
    const { vault, ex, oracle, alice, carol, agent, vkey } = await loadFixture(setup);
    await dep(vault, alice, 50_000);
    const v = await vault.getAddress();
    await ex.connect(agent).placeOrder(v, 5, order({ isBuy: true, price: px(50000), size: btc(0.5) })); // vault bids
    await ex.connect(carol).placeOrder(carol.address, 0, order({ isBuy: false, price: px(50000), size: btc(0.5), tif: TIF.IOC }));
    expect((await ex.positions(vkey, 0)).size).to.equal(btc(0.5));
    await setPx(oracle, px(52000));
    // NAV = 50,000 + 0.5 * 2,000 unrealised - rebate/fee effects; vault was the maker so it earned a rebate
    const nav = await vault.totalAssets();
    expect(nav).to.be.gt(usd(50_900)).and.lt(usd(51_100));
    expect(await vault.convertToAssets(await vault.balanceOf(alice.address))).to.be.closeTo(nav, nav / 1_000_000n + 10n);
  });

  it("a loss lowers the share price for everyone, new depositors included", async () => {
    const { vault, ex, oracle, alice, bob, carol, agent } = await loadFixture(setup);
    await dep(vault, alice, 50_000);
    const v = await vault.getAddress();
    await ex.connect(agent).placeOrder(v, 5, order({ isBuy: true, price: px(50000), size: btc(0.5) }));
    await ex.connect(carol).placeOrder(carol.address, 0, order({ isBuy: false, price: px(50000), size: btc(0.5), tif: TIF.IOC }));
    await setPx(oracle, px(48000));
    const nav = await vault.totalAssets();
    expect(nav).to.be.lt(usd(49_100));
    await dep(vault, bob, 10_000); // bob buys in at the lower NAV
    expect(await vault.convertToAssets(await vault.balanceOf(bob.address))).to.be.closeTo(usd(10_000), usd(1));
  });

  it("redeem is blocked during the lock and pays the full value after it", async () => {
    const { vault, usdc, alice } = await loadFixture(setup);
    await dep(vault, alice, 10_000);
    const sh = await vault.balanceOf(alice.address);
    await expect(vault.connect(alice).redeem(sh, alice.address, alice.address, 0)).to.be.revertedWithCustomError(vault, "Locked");
    expect(await vault.maxRedeem(alice.address)).to.equal(0n);
    await time.increase(LOCK + 1);
    const before = await usdc.balanceOf(alice.address);
    await vault.connect(alice).redeem(sh, alice.address, alice.address, 0);
    expect((await usdc.balanceOf(alice.address)) - before).to.be.closeTo(usd(10_000), 10n);
    expect(await vault.totalSupply()).to.equal(0n);
  });

  it("transferring shares does not skip the lock", async () => {
    const { vault, alice, bob } = await loadFixture(setup);
    await dep(vault, alice, 10_000);
    await time.increase(LOCK + 1); // alice is unlocked
    await dep(vault, bob, 1_000);  // bob just deposited: locked
    await vault.connect(alice).transfer(bob.address, await vault.balanceOf(alice.address));
    expect(await vault.maxRedeem(bob.address)).to.equal(0n);
  });

  it("redeem is limited by free margin while the operator holds a position, and a partial redeem works", async () => {
    const { vault, ex, oracle, usdc, alice, carol, agent } = await loadFixture(setup);
    await dep(vault, alice, 50_000);
    const v = await vault.getAddress();
    await ex.connect(agent).placeOrder(v, 5, order({ isBuy: true, price: px(50000), size: btc(2) })); // 100k notional: IM 10k at 10%
    await ex.connect(carol).placeOrder(carol.address, 0, order({ isBuy: false, price: px(50000), size: btc(2), tif: TIF.IOC }));
    await time.increase(LOCK + 1);
    await setPx(oracle, px(50000)); // keep the oracle fresh after the time jump
    const all = await vault.balanceOf(alice.address);
    await expect(vault.connect(alice).redeem(all, alice.address, alice.address, 0)).to.be.revertedWithCustomError(vault, "InsufficientLiquidity");
    const max = await vault.maxRedeem(alice.address);
    expect(max).to.be.gt(0n).and.lt(all);
    const before = await usdc.balanceOf(alice.address);
    await vault.connect(alice).redeem(max, alice.address, alice.address, 0);
    expect((await usdc.balanceOf(alice.address)) - before).to.be.gt(usd(30_000));
  });

  it("the operator key cannot withdraw or move vault funds, and has no vault admin rights", async () => {
    const { vault, ex, alice, agent, vkey } = await loadFixture(setup);
    await dep(vault, alice, 10_000);
    // withdraw/transfer act on the CALLER's own account, never the vault's
    await expect(ex.connect(agent).withdraw(5, usd(1))).to.be.reverted;
    await expect(ex.connect(agent).transferInternal(5, 6, usd(1))).to.be.reverted;
    expect(await ex.collateral(vkey)).to.equal(usd(10_000));
    await expect(vault.connect(agent).setOperator(agent.address, 2n ** 60n, 1n, 1n)).to.be.reverted;
    await expect(vault.connect(agent).setParams(1n, 1n)).to.be.reverted;
  });

  it("the operator is limited to its markets and max order notional", async () => {
    const { vault, ex, alice, agent } = await loadFixture(setup);
    await dep(vault, alice, 50_000);
    const v = await vault.getAddress();
    await expect(ex.connect(agent).placeOrder(v, 5, order({ isBuy: true, price: px(50000), size: btc(5) }))).to.be.reverted; // 250k > 200k cap
    await ex.connect(agent).placeOrder(v, 5, order({ isBuy: true, price: px(50000), size: btc(1) })); // within scope
  });

  it("revoking the operator stops it trading immediately", async () => {
    const { vault, ex, admin, guardian, alice, agent } = await loadFixture(setup);
    await dep(vault, alice, 10_000);
    const v = await vault.getAddress();
    await vault.connect(admin).grantRole(await vault.GUARDIAN_ROLE(), guardian.address);
    await vault.connect(guardian).revokeOperator();
    await expect(ex.connect(agent).placeOrder(v, 5, order({ isBuy: true, price: px(50000), size: btc(0.1) }))).to.be.revertedWithCustomError(ex, "NotAuthorized");
    expect(await vault.operator()).to.equal(ethers.ZeroAddress);
  });

  it("replacing the operator revokes the old key", async () => {
    const { vault, ex, admin, alice, bob, agent, expiry } = await loadFixture(setup);
    await dep(vault, alice, 10_000);
    const v = await vault.getAddress();
    await vault.connect(admin).setOperator(bob.address, expiry, 1n, usd(100_000));
    await expect(ex.connect(agent).placeOrder(v, 5, order({ isBuy: true, price: px(50000), size: btc(0.1) }))).to.be.revertedWithCustomError(ex, "NotAuthorized");
    await ex.connect(bob).placeOrder(v, 5, order({ isBuy: true, price: px(50000), size: btc(0.1) }));
  });

  it("enforces the deposit cap and the pause, and a pause never blocks redemptions", async () => {
    const { vault, admin, alice, bob } = await loadFixture(setup);
    await expect(dep(vault, alice, 600_000)).to.be.revertedWithCustomError(vault, "CapExceeded");
    await dep(vault, alice, 10_000);
    await vault.connect(admin).setDepositsPaused(true);
    await expect(dep(vault, bob, 1_000)).to.be.revertedWithCustomError(vault, "Paused");
    expect(await vault.maxDeposit(bob.address)).to.equal(0n);
    await time.increase(LOCK + 1);
    await vault.connect(alice).redeem(await vault.balanceOf(alice.address), alice.address, alice.address, 0);
  });

  it("slippage guards: minShares on deposit, minAssets on redeem", async () => {
    const { vault, alice } = await loadFixture(setup);
    await expect(dep(vault, alice, 1_000, ethers.MaxUint256)).to.be.revertedWithCustomError(vault, "Slippage");
    await dep(vault, alice, 1_000);
    await time.increase(LOCK + 1);
    const sh = await vault.balanceOf(alice.address);
    await expect(vault.connect(alice).redeem(sh, alice.address, alice.address, usd(2_000))).to.be.revertedWithCustomError(vault, "Slippage");
  });

  it("a donation to an empty vault cannot make later depositors lose their deposit (inflation attack)", async () => {
    const { vault, ex, usdc, alice, bob } = await loadFixture(setup);
    await vault.connect(alice).deposit(1n, alice.address, 0).catch(() => {}); // 1 base-unit deposit may mint 0 shares: allowed to revert
    await usdc.connect(alice).transfer(await vault.getAddress(), usd(20_000)); // attacker donates idle USDC
    await dep(vault, bob, 10_000);
    const got = await vault.convertToAssets(await vault.balanceOf(bob.address));
    expect(got).to.be.gt(usd(9_990)); // bob keeps essentially all of it
  });

  it("an impaired vault (equity wiped out) refuses new deposits instead of minting against nothing", async () => {
    const { vault, ex, oracle, alice, bob, carol, agent, vkey } = await loadFixture(setup);
    await dep(vault, alice, 10_000);
    const v = await vault.getAddress();
    await ex.connect(agent).placeOrder(v, 5, order({ isBuy: true, price: px(50000), size: btc(0.3) }));
    await ex.connect(carol).placeOrder(carol.address, 0, order({ isBuy: false, price: px(50000), size: btc(0.3), tif: TIF.IOC }));
    await setPx(oracle, px(5000)); // crash: the vault's long is far underwater
    expect(await eqOf(ex, vkey)).to.be.lt(0n);
    expect(await vault.totalAssets()).to.equal(0n);
    await expect(dep(vault, bob, 1_000)).to.be.revertedWithCustomError(vault, "Impaired");
  });

  it("pushIdle moves stray USDC onto the exchange; the ledger identity holds throughout", async () => {
    const { vault, ex, usdc, alice, carol, vkey } = await loadFixture(setup);
    await dep(vault, alice, 10_000);
    await usdc.connect(alice).transfer(await vault.getAddress(), usd(500));
    await vault.pushIdle();
    expect(await ex.collateral(vkey)).to.equal(usd(10_500));
    const L = await ledger(ex, [vkey, await ex.acctKey(carol.address, 0)]);
    expect(L.drift).to.equal(0n);
  });
});
