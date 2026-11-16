const { expect } = require("chai");
const { loadFixture, usd, btc, TIF, order, deploy, ledger } = require("./helpers");

const px = (n) => usd(n);

describe("Fees and maker rebate", () => {
  async function funded() {
    const e = await deploy();
    for (const s of [e.alice, e.bob, e.carol]) await e.ex.connect(s).deposit(s.address, 0, usd(100_000));
    return e;
  }
  const cross = async ({ ex, alice, bob }, size = 1, price = 50000) => {
    await ex.connect(alice).placeOrder(alice.address, 0, order({ isBuy: false, price: px(price), size: btc(size) }));
    await ex.connect(bob).placeOrder(bob.address, 0, order({ isBuy: true, price: px(price), size: btc(size), tif: TIF.IOC }));
  };

  it("ships with taker 5 bps and a 1 bp maker rebate", async () => {
    const { ex } = await loadFixture(funded);
    expect(await ex.takerFeeBps()).to.equal(5n);
    expect(await ex.makerFeeBps()).to.equal(-1n);
  });

  it("pays the maker a rebate out of the taker fee; the protocol keeps the difference", async () => {
    const e = await loadFixture(funded);
    const { ex, alice, bob, key } = e;
    await cross(e); // 1 BTC at 50,000: notional 50,000 USDC
    expect(await ex.collateral(await key(bob))).to.equal(usd(100_000) - usd(25));   // taker pays 5 bps
    expect(await ex.collateral(await key(alice))).to.equal(usd(100_000) + usd(5));  // maker earns 1 bp
    expect(await ex.feePool()).to.equal(usd(20));                                   // protocol keeps 4 bps
  });

  it("the ledger identity holds with rebates, including tiny fills where rounding matters", async () => {
    const e = await loadFixture(funded);
    const { ex, alice, bob, carol, key } = e;
    await cross(e, 0.0003, 50000);   // 3 lots: notional 15 USDC, fees well under 1 cent so rounding dominates
    await cross(e, 0.0007, 49990.1);
    const L = await ledger(ex, [await key(alice), await key(bob), await key(carol)]);
    expect(L.drift).to.equal(0n);
    expect(await ex.feePool()).to.be.gt(0n); // rebate (floored) never exceeds the taker fee (ceiled)
  });

  it("a fill never takes more rebate out of the pool than the taker paid in", async () => {
    const e = await loadFixture(funded);
    const { ex, admin } = e;
    await ex.connect(admin).setFees(5, -5, 50, 5000, 10000, usd(1_000_000)); // rebate equal to the taker fee: allowed edge
    const before = await ex.feePool();
    await cross(e, 0.0007, 50000);
    expect(await ex.feePool()).to.be.gte(before);
  });

  it("setFees refuses a rebate larger than the taker fee and emits FeesUpdated", async () => {
    const { ex, admin } = await loadFixture(funded);
    await expect(ex.connect(admin).setFees(5, -6, 50, 5000, 10000, usd(1_000_000))).to.be.revertedWith("maker bounds");
    await expect(ex.connect(admin).setFees(5, 6, 50, 5000, 10000, usd(1_000_000))).to.be.revertedWith("maker bounds");
    await expect(ex.connect(admin).setFees(4, -2, 50, 5000, 10000, usd(1_000_000)))
      .to.emit(ex, "FeesUpdated").withArgs(4, -2, 50, 5000, 10000, usd(1_000_000));
    expect(await ex.makerFeeBps()).to.equal(-2n);
  });

  it("only the admin can change fees", async () => {
    const { ex, alice } = await loadFixture(funded);
    await expect(ex.connect(alice).setFees(5, -1, 50, 5000, 10000, usd(1_000_000))).to.be.reverted;
  });
});
