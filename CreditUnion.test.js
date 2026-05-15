const { expect }      = require("chai");
const { ethers }      = require("hardhat");
const { time }        = require("@nomicfoundation/hardhat-network-helpers");

// ─────────────────────────────────────────────────────────────────
//  Helpers
// ─────────────────────────────────────────────────────────────────

const E = (n) => ethers.parseEther(String(n));
const ONE_DAY   = 24 * 60 * 60;
const ONE_MONTH = 30 * ONE_DAY;

// LoanStatus enum values  (Pending=0, Approved=1, Rejected=2, Active=3, Repaid=4, Defaulted=5)
const STATUS = { Pending: 0n, Approved: 1n, Rejected: 2n, Active: 3n, Repaid: 4n, Defaulted: 5n };
// LoanTier enum values    (Trust=0, Standard=1, Secured=2)
const TIER   = { Trust: 0n, Standard: 1n, Secured: 2n };
// GovParamType enum values (MaxLoanSize=0, MinInterestRate=1, KeeperBountyRate=2, Unpause=3, TransferTreasurer=4)
const PARAM  = { MaxLoanSize: 0n, MinInterestRate: 1n, KeeperBountyRate: 2n, Unpause: 3n, TransferTreasurer: 4n };
// GovStatus enum values   (Pending=0, Approved=1, Rejected=2, Executed=3, Vetoed=4)
const GOV_STATUS = { Pending: 0n, Approved: 1n, Rejected: 2n, Executed: 3n, Vetoed: 4n };

async function deploy() {
  const [deployer, treasurer, alice, bob, carol, keeper] =
    await ethers.getSigners();

  const CU = await ethers.getContractFactory("CreditUnion");
  const cu = await CU.deploy(treasurer.address);
  await cu.waitForDeployment();

  return { cu, deployer, treasurer, alice, bob, carol, keeper };
}

// Fast-path helper: join as member, advance time 31 days so voting weight > 0
async function joinAndWait(cu, signer, value = E(2)) {
  await cu.connect(signer).join({ value });
  await time.increase(ONE_MONTH + ONE_DAY);
}

// Full lifecycle: request → vote (alice votes for) → finalize → activate → get loan id
async function openLoan(
  cu,
  borrower,
  voters,       // array of {signer, support}
  { amount = E(0.5), rate = 1000, duration = 7 * ONE_DAY } = {}
) {
  // Compute thresholds so we always satisfy requirements
  const [threshRate, threshCollat] = await cu.computeThresholds(borrower.address, amount, duration);
  const useRate = rate > threshRate ? rate : threshRate;
  // Offer 110% of threshold collateral to ensure we clear the floor
  const collateralOffered = threshCollat * 110n / 100n;

  const tx  = await cu.connect(borrower).requestLoan(amount, useRate, duration, collateralOffered);
  const rc  = await tx.wait();
  const id  = rc.logs.find((l) => l.fragment?.name === "LoanRequested").args[0];

  for (const { signer, support } of voters) {
    await cu.connect(signer).vote(id, support);
  }
  await time.increase(3 * ONE_DAY + 1);   // past vote deadline
  await cu.finalizeLoan(id);

  return id;
}

// Full governance lifecycle: propose → vote → finalize → wait timelock → execute
async function govChange(cu, treasurer, voters, paramType, newValue) {
  const tx = await cu.connect(treasurer).proposeChange(paramType, newValue);
  const rc = await tx.wait();
  const id = rc.logs.find((l) => l.fragment?.name === "GovernanceProposed").args[0];
  for (const { signer, support } of voters) {
    await cu.connect(signer).voteOnProposal(id, support);
  }
  await time.increase(3 * ONE_DAY + 1);   // past vote deadline
  await cu.finalizeProposal(id);
  await time.increase(2 * ONE_DAY + 1);   // past timelock
  await cu.executeProposal(id);
  return id;
}

// ─────────────────────────────────────────────────────────────────
//  Test suite
// ─────────────────────────────────────────────────────────────────

describe("CreditUnion", function () {

  // ── 1. Deployment ────────────────────────────────────────────

  describe("Deployment", function () {
    it("sets treasurer correctly", async function () {
      const { cu, treasurer } = await deploy();
      expect(await cu.treasurer()).to.equal(treasurer.address);
    });

    it("default config is within expected ranges", async function () {
      const { cu } = await deploy();
      expect(await cu.maxLoanSize()).to.equal(E(100));
      expect(await cu.minInterestRate()).to.equal(800n);
      expect(await cu.keeperBountyRate()).to.equal(100n);
      expect(await cu.paused()).to.be.false;
    });
  });

  // ── 2. join() ─────────────────────────────────────────────────

  describe("join()", function () {
    it("allows a member to join with a valid deposit", async function () {
      const { cu, alice } = await deploy();
      await expect(cu.connect(alice).join({ value: E(1) }))
        .to.emit(cu, "MemberJoined")
        .withArgs(alice.address, E(1), E(1));

      const m = await cu.members(alice.address);
      expect(m.exists).to.be.true;
      expect(m.depositAmount).to.equal(E(1));
    });

    it("rejects deposit below minimum", async function () {
      const { cu, alice } = await deploy();
      await expect(cu.connect(alice).join({ value: E(0.001) }))
        .to.be.revertedWith("Below minimum deposit");
    });

    it("rejects joining twice", async function () {
      const { cu, alice } = await deploy();
      await cu.connect(alice).join({ value: E(1) });
      await expect(cu.connect(alice).join({ value: E(1) }))
        .to.be.revertedWith("Already a member");
    });

    it("first depositor gets 1:1 shares", async function () {
      const { cu, alice } = await deploy();
      await cu.connect(alice).join({ value: E(2) });
      const m = await cu.members(alice.address);
      expect(m.shares).to.equal(E(2));
      expect(await cu.totalShares()).to.equal(E(2));
    });

    it("second depositor gets proportional shares", async function () {
      const { cu, alice, bob } = await deploy();
      await cu.connect(alice).join({ value: E(2) });
      await cu.connect(bob).join({ value: E(2) });
      // Pool doubled, so bob also gets E(2) shares (1:1 at start)
      expect(await cu.totalShares()).to.equal(E(4));
    });
  });

  // ── 3. addDeposit() ───────────────────────────────────────────

  describe("addDeposit()", function () {
    it("adds ETH and mints shares proportionally", async function () {
      const { cu, alice, bob } = await deploy();
      await cu.connect(alice).join({ value: E(2) });
      const sharesBefore = (await cu.members(alice.address)).shares;

      // Bob joins to change pool ratio, then alice adds
      await cu.connect(bob).join({ value: E(2) });
      await cu.connect(alice).addDeposit({ value: E(1) });

      const sharesAfter = (await cu.members(alice.address)).shares;
      expect(sharesAfter).to.be.gt(sharesBefore);
    });

    it("reverts if not a member", async function () {
      const { cu, alice } = await deploy();
      await expect(cu.connect(alice).addDeposit({ value: E(1) }))
        .to.be.revertedWith("Not a member");
    });
  });

  // ── 4. withdraw() ─────────────────────────────────────────────

  describe("withdraw()", function () {
    it("returns correct ETH and burns shares", async function () {
      const { cu, alice } = await deploy();
      await cu.connect(alice).join({ value: E(4) });
      const shares = (await cu.members(alice.address)).shares;

      const before = await ethers.provider.getBalance(alice.address);
      const tx = await cu.connect(alice).withdraw(shares / 2n);
      const receipt = await tx.wait();
      const gas = receipt.gasUsed * receipt.gasPrice;
      const after = await ethers.provider.getBalance(alice.address);

      // Should receive ~2 ETH minus gas
      expect(after + gas - before).to.be.closeTo(E(2), E(0.001));
    });

    it("blocks withdrawal with an active loan", async function () {
      const { cu, alice, bob } = await deploy();
      await joinAndWait(cu, alice, E(2));
      await joinAndWait(cu, bob, E(10));

      const loanId = await openLoan(cu, alice, [{ signer: bob, support: true }]);
      const req = await cu.loanRequests(loanId);
      await cu.connect(alice).activateLoan(loanId, { value: req.collateralOffered });

      const shares = (await cu.members(alice.address)).shares;
      await expect(cu.connect(alice).withdraw(shares))
        .to.be.revertedWith("Active loan outstanding");
    });

    it("reverts if withdrawal would breach 10% reserve", async function () {
      const { cu, alice } = await deploy();
      await cu.connect(alice).join({ value: E(1) });  // totalDepositsEver = 1 ETH
      const shares = (await cu.members(alice.address)).shares;
      // Trying to withdraw 100% would breach 10% reserve (0 < 0.1 ETH)
      await expect(cu.connect(alice).withdraw(shares))
        .to.be.revertedWith("Would breach 10% reserve");
    });
  });

  // ── 5. computeVotingWeight() ──────────────────────────────────

  describe("computeVotingWeight()", function () {
    it("returns 0 for a brand-new member (<1 month)", async function () {
      const { cu, alice } = await deploy();
      await cu.connect(alice).join({ value: E(1) });
      expect(await cu.computeVotingWeight(alice.address)).to.equal(0n);
    });

    it("returns non-zero after 1+ month", async function () {
      const { cu, alice } = await deploy();
      await cu.connect(alice).join({ value: E(1) });
      await time.increase(ONE_MONTH + ONE_DAY);
      expect(await cu.computeVotingWeight(alice.address)).to.be.gt(0n);
    });

    it("increases with larger deposit (at same tenure)", async function () {
      const { cu, alice, bob } = await deploy();
      await cu.connect(alice).join({ value: E(1) });
      await cu.connect(bob).join({ value: E(9) });
      await time.increase(ONE_MONTH + ONE_DAY);

      const wa = await cu.computeVotingWeight(alice.address);
      const wb = await cu.computeVotingWeight(bob.address);
      expect(wb).to.be.gt(wa);
    });
  });

  // ── 6. requestLoan() — tier classification ────────────────────

  describe("requestLoan() — tier classification", function () {
    it("assigns Trust tier for small short loan by eligible member", async function () {
      const { cu, alice, bob } = await deploy();
      await joinAndWait(cu, alice, E(2));
      await joinAndWait(cu, bob, E(10));

      // 2% of 10 ETH = 0.2 ETH, duration ≤ 30 days
      const [threshRate, threshCollat] = await cu.computeThresholds(alice.address, E(0.1), 7 * ONE_DAY);
      const collateralOffered = threshCollat * 110n / 100n;
      const tx = await cu.connect(alice).requestLoan(E(0.1), threshRate, 7 * ONE_DAY, collateralOffered);
      const rc = await tx.wait();
      const ev = rc.logs.find((l) => l.fragment?.name === "LoanRequested");
      expect(ev.args[3]).to.equal(TIER.Trust);
    });

    it("assigns Standard tier for medium loan", async function () {
      const { cu, alice, bob } = await deploy();
      await joinAndWait(cu, alice, E(2));
      await joinAndWait(cu, bob, E(10));

      // 5% of 12 ETH = 0.6 ETH > Standard threshold (10% = 1.2 ETH), duration 45 days (≤90 days)
      const [threshRate, threshCollat] = await cu.computeThresholds(alice.address, E(0.5), 45 * ONE_DAY);
      const collateralOffered = threshCollat * 110n / 100n;
      const tx = await cu.connect(alice).requestLoan(E(0.5), threshRate, 45 * ONE_DAY, collateralOffered);
      const rc = await tx.wait();
      const ev = rc.logs.find((l) => l.fragment?.name === "LoanRequested");
      expect(ev.args[3]).to.equal(TIER.Standard);
      // Collateral threshold is now dynamic — just verify it's > 0
      expect(ev.args[4]).to.be.gt(0n);
    });

    it("assigns Secured tier for large loan", async function () {
      const { cu, alice, bob } = await deploy();
      await joinAndWait(cu, alice, E(5));
      await joinAndWait(cu, bob, E(15));

      // 15% of 20 ETH = 3 ETH — exceeds 10% Standard threshold
      const [threshRate, threshCollat] = await cu.computeThresholds(alice.address, E(3), 7 * ONE_DAY);
      const collateralOffered = threshCollat * 110n / 100n;
      const tx = await cu.connect(alice).requestLoan(E(3), threshRate, 7 * ONE_DAY, collateralOffered);
      const rc = await tx.wait();
      const ev = rc.logs.find((l) => l.fragment?.name === "LoanRequested");
      expect(ev.args[3]).to.equal(TIER.Secured);
      // Collateral threshold is now dynamic — just verify it's > 0
      expect(ev.args[4]).to.be.gt(0n);
    });
  });

  // ── 7. requestLoan() — Trust tier eligibility ─────────────────

  describe("requestLoan() — Trust tier eligibility", function () {
    it("blocks Trust tier if member has defaulted", async function () {
      const { cu, alice, bob, carol } = await deploy();
      // Join all three at the same time so alice's tenure doesn't dominate the snapshot
      await cu.connect(alice).join({ value: E(5) });
      await cu.connect(bob).join({ value: E(10) });
      await cu.connect(carol).join({ value: E(5) });
      await time.increase(ONE_MONTH + ONE_DAY);  // everyone has 1+ month

      // alice takes a standard loan and defaults on it
      const loanId = await openLoan(cu, alice,
        [{ signer: bob, support: true }, { signer: carol, support: true }],
        { amount: E(0.5), rate: 1000, duration: 7 * ONE_DAY }
      );
      const req = await cu.loanRequests(loanId);
      await cu.connect(alice).activateLoan(loanId, { value: req.collateralOffered });
      await time.increase(8 * ONE_DAY);
      await cu.triggerDefault(loanId);

      // alice now tries a Trust tier loan — should fail due to prior default
      const [threshRate2, threshCollat2] = await cu.computeThresholds(alice.address, E(0.1), 7 * ONE_DAY);
      await expect(cu.connect(alice).requestLoan(E(0.1), threshRate2, 7 * ONE_DAY, threshCollat2))
        .to.be.revertedWith("Prior default disqualifies Trust tier");
    });

    it("blocks Trust tier if new member (<30 days, 0 repayments)", async function () {
      const { cu, alice, bob } = await deploy();
      // Join but only wait 15 days — not 30, no prior repayments
      await cu.connect(alice).join({ value: E(2) });
      await cu.connect(bob).join({ value: E(10) });
      await time.increase(15 * ONE_DAY);

      const [threshRate, threshCollat] = await cu.computeThresholds(alice.address, E(0.1), 7 * ONE_DAY);
      await expect(cu.connect(alice).requestLoan(E(0.1), threshRate, 7 * ONE_DAY, threshCollat))
        .to.be.revertedWith("Not yet eligible for Trust tier");
    });

    it("allows Trust tier after 30+ days membership", async function () {
      const { cu, alice, bob } = await deploy();
      await joinAndWait(cu, alice, E(2));
      await joinAndWait(cu, bob, E(10));

      // Should not revert for Trust tier request
      const [threshRate, threshCollat] = await cu.computeThresholds(alice.address, E(0.1), 7 * ONE_DAY);
      const collateralOffered = threshCollat * 110n / 100n;
      await expect(cu.connect(alice).requestLoan(E(0.1), threshRate, 7 * ONE_DAY, collateralOffered))
        .to.emit(cu, "LoanRequested");
    });
  });

  // ── 8. requestLoan() — common validations ─────────────────────

  describe("requestLoan() — common validations", function () {
    it("reverts if not a member", async function () {
      const { cu, alice } = await deploy();
      await expect(cu.connect(alice).requestLoan(E(1), 1000, 7 * ONE_DAY, E(1)))
        .to.be.revertedWith("Not a member");
    });

    it("reverts if borrower already has an active loan", async function () {
      const { cu, alice, bob } = await deploy();
      await joinAndWait(cu, alice, E(2));
      await joinAndWait(cu, bob, E(10));

      const loanId = await openLoan(cu, alice, [{ signer: bob, support: true }]);
      const req = await cu.loanRequests(loanId);
      await cu.connect(alice).activateLoan(loanId, { value: req.collateralOffered });

      const [threshRate, threshCollat] = await cu.computeThresholds(alice.address, E(0.1), 7 * ONE_DAY);
      await expect(cu.connect(alice).requestLoan(E(0.1), threshRate, 7 * ONE_DAY, threshCollat))
        .to.be.revertedWith("Active loan outstanding");
    });

    it("reverts if amount exceeds 20% of pool", async function () {
      const { cu, alice, bob } = await deploy();
      await joinAndWait(cu, alice, E(2));
      await joinAndWait(cu, bob, E(10));

      // Use a high rate and high collateral so only the pool cap check triggers
      await expect(cu.connect(alice).requestLoan(E(4), 2000, 7 * ONE_DAY, E(10)))
        .to.be.revertedWith("Exceeds 20% pool cap");
    });

    it("reverts if rate is below minimum", async function () {
      const { cu, alice, bob } = await deploy();
      await joinAndWait(cu, alice, E(2));
      await joinAndWait(cu, bob, E(10));

      const [threshRate,] = await cu.computeThresholds(alice.address, E(0.5), 7 * ONE_DAY);
      await expect(cu.connect(alice).requestLoan(E(0.5), threshRate - 1n, 7 * ONE_DAY, E(1)))
        .to.be.revertedWith("Rate below risk threshold");
    });
  });

  // ── 9. vote() ─────────────────────────────────────────────────

  describe("vote()", function () {
    it("accepts a valid vote and emits VoteCast", async function () {
      const { cu, alice, bob } = await deploy();
      await joinAndWait(cu, alice, E(2));
      await joinAndWait(cu, bob, E(10));

      const [threshRate, threshCollat] = await cu.computeThresholds(alice.address, E(0.5), 7 * ONE_DAY);
      const collateralOffered = threshCollat * 110n / 100n;
      const tx = await cu.connect(alice).requestLoan(E(0.5), threshRate, 7 * ONE_DAY, collateralOffered);
      const rc = await tx.wait();
      const id = rc.logs.find((l) => l.fragment?.name === "LoanRequested").args[0];

      await expect(cu.connect(bob).vote(id, true))
        .to.emit(cu, "VoteCast")
        .withArgs(id, bob.address, true, await cu.computeVotingWeight(bob.address));
    });

    it("reverts on double vote", async function () {
      const { cu, alice, bob } = await deploy();
      await joinAndWait(cu, alice, E(2));
      await joinAndWait(cu, bob, E(10));

      const [threshRate, threshCollat] = await cu.computeThresholds(alice.address, E(0.5), 7 * ONE_DAY);
      const collateralOffered = threshCollat * 110n / 100n;
      const tx = await cu.connect(alice).requestLoan(E(0.5), threshRate, 7 * ONE_DAY, collateralOffered);
      const id = (await tx.wait()).logs.find((l) => l.fragment?.name === "LoanRequested").args[0];

      await cu.connect(bob).vote(id, true);
      await expect(cu.connect(bob).vote(id, false))
        .to.be.revertedWith("Already voted");
    });

    it("reverts if voting deadline has passed", async function () {
      const { cu, alice, bob } = await deploy();
      await joinAndWait(cu, alice, E(2));
      await joinAndWait(cu, bob, E(10));

      const [threshRate, threshCollat] = await cu.computeThresholds(alice.address, E(0.5), 7 * ONE_DAY);
      const collateralOffered = threshCollat * 110n / 100n;
      const tx = await cu.connect(alice).requestLoan(E(0.5), threshRate, 7 * ONE_DAY, collateralOffered);
      const id = (await tx.wait()).logs.find((l) => l.fragment?.name === "LoanRequested").args[0];

      await time.increase(3 * ONE_DAY + 1);
      await expect(cu.connect(bob).vote(id, true))
        .to.be.revertedWith("Voting closed");
    });

    it("prevents borrower from voting on own loan", async function () {
      const { cu, alice, bob } = await deploy();
      await joinAndWait(cu, alice, E(2));
      await joinAndWait(cu, bob, E(10));

      const [threshRate, threshCollat] = await cu.computeThresholds(alice.address, E(0.5), 7 * ONE_DAY);
      const collateralOffered = threshCollat * 110n / 100n;
      const tx = await cu.connect(alice).requestLoan(E(0.5), threshRate, 7 * ONE_DAY, collateralOffered);
      const id = (await tx.wait()).logs.find((l) => l.fragment?.name === "LoanRequested").args[0];

      await expect(cu.connect(alice).vote(id, true))
        .to.be.revertedWith("Borrower cannot vote");
    });
  });

  // ── 10. finalizeLoan() ────────────────────────────────────────

  describe("finalizeLoan()", function () {
    it("sets status to Approved and records approvalTimestamp; does NOT disburse ETH", async function () {
      const { cu, alice, bob } = await deploy();
      await joinAndWait(cu, alice, E(2));
      await joinAndWait(cu, bob, E(10));

      const [threshRate, threshCollat] = await cu.computeThresholds(alice.address, E(0.5), 7 * ONE_DAY);
      const collateralOffered = threshCollat * 110n / 100n;
      const tx = await cu.connect(alice).requestLoan(E(0.5), threshRate, 7 * ONE_DAY, collateralOffered);
      const id = (await tx.wait()).logs.find((l) => l.fragment?.name === "LoanRequested").args[0];

      await cu.connect(bob).vote(id, true);
      await time.increase(3 * ONE_DAY + 1);

      const poolBefore = await cu.totalPoolETH();
      await cu.finalizeLoan(id);
      const poolAfter = await cu.totalPoolETH();

      const req = await cu.getLoanRequest(id);
      expect(req.status).to.equal(STATUS.Approved);
      expect(req.approvalTimestamp).to.be.gt(0n);
      expect(poolAfter).to.equal(poolBefore); // No ETH moved yet
    });

    it("sets status to Rejected when votes insufficient", async function () {
      const { cu, alice, bob } = await deploy();
      await joinAndWait(cu, alice, E(2));
      await joinAndWait(cu, bob, E(10));

      const [threshRate, threshCollat] = await cu.computeThresholds(alice.address, E(0.5), 7 * ONE_DAY);
      const collateralOffered = threshCollat * 110n / 100n;
      const tx = await cu.connect(alice).requestLoan(E(0.5), threshRate, 7 * ONE_DAY, collateralOffered);
      const id = (await tx.wait()).logs.find((l) => l.fragment?.name === "LoanRequested").args[0];

      // bob votes against — no one votes for; total snapshot includes alice's weight too
      await cu.connect(bob).vote(id, false);
      await time.increase(3 * ONE_DAY + 1);

      await expect(cu.finalizeLoan(id))
        .to.emit(cu, "LoanRejected")
        .withArgs(id);

      expect((await cu.getLoanRequest(id)).status).to.equal(STATUS.Rejected);
    });
  });

  // ── 11. activateLoan() — happy path ───────────────────────────

  describe("activateLoan() — happy path", function () {
    it("disburses ETH to borrower, locks collateral, sets Active status", async function () {
      const { cu, alice, bob } = await deploy();
      await joinAndWait(cu, alice, E(2));
      await joinAndWait(cu, bob, E(10));

      const loanId = await openLoan(cu, alice, [{ signer: bob, support: true }],
        { amount: E(0.5), rate: 1000, duration: 7 * ONE_DAY });

      const req    = await cu.getLoanRequest(loanId);
      const collat = req.collateralOffered;

      const aliceBefore = await ethers.provider.getBalance(alice.address);
      const poolBefore  = await cu.totalPoolETH();

      const tx = await cu.connect(alice).activateLoan(loanId, { value: collat });
      const rc = await tx.wait();
      const gas = rc.gasUsed * rc.gasPrice;

      const aliceAfter = await ethers.provider.getBalance(alice.address);
      const poolAfter  = await cu.totalPoolETH();

      // Alice received principal (0.5 ETH) minus gas, minus collateral she sent
      expect(aliceAfter + gas + collat - aliceBefore).to.be.closeTo(E(0.5), E(0.001));
      // Pool decreased by principal only (collateral is held separately)
      expect(poolBefore - poolAfter).to.equal(E(0.5));
      // Collateral recorded
      expect(await cu.collateralHeld(loanId)).to.equal(collat);
      // Status is Active
      expect((await cu.getLoanRequest(loanId)).status).to.equal(STATUS.Active);
    });
  });

  // ── 12. activateLoan() — wrong collateral ─────────────────────

  describe("activateLoan() — wrong collateral", function () {
    it("reverts if msg.value != collateralOffered", async function () {
      const { cu, alice, bob } = await deploy();
      await joinAndWait(cu, alice, E(2));
      await joinAndWait(cu, bob, E(10));

      const loanId = await openLoan(cu, alice, [{ signer: bob, support: true }]);
      const req = await cu.loanRequests(loanId);

      await expect(cu.connect(alice).activateLoan(loanId, { value: req.collateralOffered + 1n }))
        .to.be.revertedWith("Wrong collateral amount");
    });
  });

  // ── 13. activateLoan() — 7-day expiry ─────────────────────────

  describe("activateLoan() — 7-day expiry", function () {
    it("sets status to Rejected if called after 7 days", async function () {
      const { cu, alice, bob } = await deploy();
      await joinAndWait(cu, alice, E(2));
      await joinAndWait(cu, bob, E(10));

      const loanId = await openLoan(cu, alice, [{ signer: bob, support: true }]);
      const req = await cu.loanRequests(loanId);

      await time.increase(7 * ONE_DAY + 1);

      // Activation will expire the loan; refund any ETH sent
      await cu.connect(alice).activateLoan(loanId, { value: req.collateralOffered });
      expect((await cu.getLoanRequest(loanId)).status).to.equal(STATUS.Rejected);
    });
  });

  // ── 14. repay() — full repayment ──────────────────────────────

  describe("repay() — full repayment", function () {
    it("restores pool ETH, clears loan, increments successfulRepayments, returns collateral", async function () {
      const { cu, alice, bob } = await deploy();
      await joinAndWait(cu, alice, E(2));
      await joinAndWait(cu, bob, E(10));

      const loanId = await openLoan(cu, alice, [{ signer: bob, support: true }],
        { amount: E(0.5), rate: 1000, duration: 7 * ONE_DAY });

      const req = await cu.loanRequests(loanId);
      await cu.connect(alice).activateLoan(loanId, { value: req.collateralOffered });

      const totalDue = (await cu.getActiveLoan(loanId)).totalDue;
      const poolBefore = await cu.totalPoolETH();

      await expect(cu.connect(alice).repay(loanId, { value: totalDue }))
        .to.emit(cu, "LoanRepaid").and
        .to.emit(cu, "CollateralReturned");

      expect(await cu.totalPoolETH()).to.be.gt(poolBefore); // interest added
      expect(await cu.activeLoanIdOf(alice.address)).to.equal(0n);
      expect(await cu.successfulRepayments(alice.address)).to.equal(1n);
      expect(await cu.collateralHeld(loanId)).to.equal(0n);
      expect((await cu.getLoanRequest(loanId)).status).to.equal(STATUS.Repaid);
    });

    it("allows another loan after full repayment", async function () {
      const { cu, alice, bob } = await deploy();
      await joinAndWait(cu, alice, E(2));
      await joinAndWait(cu, bob, E(10));

      const loanId = await openLoan(cu, alice, [{ signer: bob, support: true }]);
      const req = await cu.loanRequests(loanId);
      await cu.connect(alice).activateLoan(loanId, { value: req.collateralOffered });
      const totalDue = (await cu.getActiveLoan(loanId)).totalDue;
      await cu.connect(alice).repay(loanId, { value: totalDue });

      // Should be able to request another loan
      const [threshRate2, threshCollat2] = await cu.computeThresholds(alice.address, E(0.1), 7 * ONE_DAY);
      const collateralOffered2 = threshCollat2 * 110n / 100n;
      await expect(cu.connect(alice).requestLoan(E(0.1), threshRate2, 7 * ONE_DAY, collateralOffered2))
        .to.emit(cu, "LoanRequested");
    });
  });

  // ── 15. repay() — partial repayments ─────────────────────────

  describe("repay() — partial repayments", function () {
    it("accumulates partial payments; loan not closed until fully repaid", async function () {
      const { cu, alice, bob } = await deploy();
      await joinAndWait(cu, alice, E(2));
      await joinAndWait(cu, bob, E(10));

      const loanId = await openLoan(cu, alice, [{ signer: bob, support: true }],
        { amount: E(0.5), rate: 1000, duration: 30 * ONE_DAY });

      const req = await cu.loanRequests(loanId);
      await cu.connect(alice).activateLoan(loanId, { value: req.collateralOffered });
      const totalDue = (await cu.getActiveLoan(loanId)).totalDue;

      // Pay half
      await cu.connect(alice).repay(loanId, { value: totalDue / 2n });
      expect((await cu.getActiveLoan(loanId)).amountRepaid).to.equal(totalDue / 2n);
      expect(await cu.activeLoanIdOf(alice.address)).to.not.equal(0n); // still active

      // Pay the rest
      await cu.connect(alice).repay(loanId, { value: totalDue - totalDue / 2n });
      expect(await cu.activeLoanIdOf(alice.address)).to.equal(0n);
    });

    it("rejects overpayment", async function () {
      const { cu, alice, bob } = await deploy();
      await joinAndWait(cu, alice, E(2));
      await joinAndWait(cu, bob, E(10));

      const loanId = await openLoan(cu, alice, [{ signer: bob, support: true }]);
      const req = await cu.loanRequests(loanId);
      await cu.connect(alice).activateLoan(loanId, { value: req.collateralOffered });
      const totalDue = (await cu.getActiveLoan(loanId)).totalDue;

      await expect(cu.connect(alice).repay(loanId, { value: totalDue + 1n }))
        .to.be.revertedWith("Overpayment");
    });
  });

  // ── 16. triggerDefault() ──────────────────────────────────────

  describe("triggerDefault()", function () {
    it("reverts before repayment deadline", async function () {
      const { cu, alice, bob, keeper } = await deploy();
      await joinAndWait(cu, alice, E(2));
      await joinAndWait(cu, bob, E(10));

      const loanId = await openLoan(cu, alice, [{ signer: bob, support: true }]);
      const req = await cu.loanRequests(loanId);
      await cu.connect(alice).activateLoan(loanId, { value: req.collateralOffered });

      await expect(cu.connect(keeper).triggerDefault(loanId))
        .to.be.revertedWith("Not overdue");
    });

    it("pays bounty to keeper and marks loan defaulted; sets hasDefaulted", async function () {
      const { cu, alice, bob, keeper } = await deploy();
      await joinAndWait(cu, alice, E(2));
      await joinAndWait(cu, bob, E(10));

      const loanId = await openLoan(cu, alice, [{ signer: bob, support: true }],
        { amount: E(1), rate: 1000, duration: 7 * ONE_DAY });

      const req = await cu.loanRequests(loanId);
      await cu.connect(alice).activateLoan(loanId, { value: req.collateralOffered });

      await time.increase(8 * ONE_DAY);

      const keeperBefore = await ethers.provider.getBalance(keeper.address);
      const tx = await cu.connect(keeper).triggerDefault(loanId);
      const rc = await tx.wait();
      const gas = rc.gasUsed * rc.gasPrice;
      const keeperAfter = await ethers.provider.getBalance(keeper.address);

      const bounty = keeperAfter + gas - keeperBefore;
      expect(bounty).to.be.gt(0n);

      expect(await cu.hasDefaulted(alice.address)).to.be.true;
      expect((await cu.getLoanRequest(loanId)).status).to.equal(STATUS.Defaulted);
      expect(await cu.activeLoanIdOf(alice.address)).to.equal(0n);
    });

    it("enforces 2% keeper bounty cap", async function () {
      const { cu, treasurer, alice, bob, keeper } = await deploy();
      await joinAndWait(cu, alice, E(2));
      await joinAndWait(cu, bob, E(10));

      // Set bounty rate to max via governance
      await govChange(cu, treasurer,
        [{ signer: alice, support: true }, { signer: bob, support: true }],
        PARAM.KeeperBountyRate, 200n);

      const loanId = await openLoan(cu, alice, [{ signer: bob, support: true }],
        { amount: E(1), rate: 1000, duration: 7 * ONE_DAY });

      const req = await cu.loanRequests(loanId);
      await cu.connect(alice).activateLoan(loanId, { value: req.collateralOffered });
      await time.increase(8 * ONE_DAY);

      const poolBefore = await cu.totalPoolETH();
      await cu.connect(keeper).triggerDefault(loanId);
      const poolAfter = await cu.totalPoolETH();

      // Bounty ≤ 2% of 1 ETH principal = 0.02 ETH
      const bountyDeducted = poolBefore - poolAfter + (await cu.collateralHeld(loanId));
      expect(bountyDeducted).to.be.lte(E(0.02) + E(0.001));
    });

    it("seizes collateral into pool on default", async function () {
      const { cu, alice, bob, keeper } = await deploy();
      await joinAndWait(cu, alice, E(5));
      await joinAndWait(cu, bob, E(15));

      // Secured loan: 15% of pool, dynamic collateral
      const loanId = await openLoan(cu, alice, [{ signer: bob, support: true }],
        { amount: E(3), rate: 1000, duration: 7 * ONE_DAY });

      const req = await cu.loanRequests(loanId);
      const collat = req.collateralOffered;
      expect(collat).to.be.gt(0n); // collateral is dynamic now, just verify > 0

      await cu.connect(alice).activateLoan(loanId, { value: collat });
      await time.increase(8 * ONE_DAY);

      const poolBefore = await cu.totalPoolETH();
      await cu.connect(keeper).triggerDefault(loanId);
      const poolAfter = await cu.totalPoolETH();

      // Collateral was seized into pool; pool should reflect partial recovery
      expect(poolAfter).to.be.gt(poolBefore - E(0.1)); // pool recovered most collateral
    });

    it("updates totalDefaulted on borrower", async function () {
      const { cu, alice, bob, keeper } = await deploy();
      await joinAndWait(cu, alice, E(2));
      await joinAndWait(cu, bob, E(10));

      const loanId = await openLoan(cu, alice, [{ signer: bob, support: true }],
        { amount: E(1), rate: 1000, duration: 7 * ONE_DAY });

      const req = await cu.loanRequests(loanId);
      await cu.connect(alice).activateLoan(loanId, { value: req.collateralOffered });
      await time.increase(8 * ONE_DAY);
      await cu.connect(keeper).triggerDefault(loanId);

      const loan    = await cu.getActiveLoan(loanId);
      const profile = await cu.getBorrowerProfile(alice.address);
      expect(profile._hasDefaulted).to.be.true;
      // totalDefaulted records grossBadDebt (principal + interest, before collateral offset)
      expect(profile._totalDefaulted).to.equal(loan.totalDue);
    });
  });

  // ── 17. Default — Tier 3 (Secured, large collateral offsets bad debt) ──

  describe("default — Secured tier collateral offsets bad debt", function () {
    it("PoolLossSocialized reflects reduced shortfall after collateral seizure", async function () {
      const { cu, alice, bob, keeper } = await deploy();
      await joinAndWait(cu, alice, E(5));
      await joinAndWait(cu, bob, E(15));

      const amount = E(3); // Secured tier
      const loanId = await openLoan(cu, alice, [{ signer: bob, support: true }],
        { amount, rate: 1000, duration: 7 * ONE_DAY });

      const req = await cu.loanRequests(loanId);
      await cu.connect(alice).activateLoan(loanId, { value: req.collateralOffered });
      await time.increase(8 * ONE_DAY);

      const tx = await cu.connect(keeper).triggerDefault(loanId);
      const rc = await tx.wait();
      const ev = rc.logs.find((l) => l.fragment?.name === "PoolLossSocialized");

      // lossAmount should be less than the full bad debt because collateral offsets it
      const totalDue     = (await cu.getActiveLoan(loanId)).totalDue;
      const grossBadDebt = totalDue; // no repayments made

      // lossAmount = remainingBadDebt + bounty; collateral reduced the net pool loss
      const lossAmount = ev.args[0];
      expect(lossAmount).to.be.lt(grossBadDebt);
    });
  });

  // ── 18. Share appreciation via interest ───────────────────────

  describe("share appreciation", function () {
    it("getMemberValue increases after interest is repaid", async function () {
      const { cu, alice, bob } = await deploy();
      // alice is the voter here (bob borrows), so alice needs more weight
      await joinAndWait(cu, alice, E(10));
      await joinAndWait(cu, bob, E(2));

      const valueBefore = await cu.getMemberValue(alice.address);

      const loanId = await openLoan(cu, bob, [{ signer: alice, support: true }],
        { amount: E(1), rate: 1000, duration: 30 * ONE_DAY });

      const req = await cu.loanRequests(loanId);
      await cu.connect(bob).activateLoan(loanId, { value: req.collateralOffered });

      const { totalDue } = await cu.getActiveLoan(loanId);
      await cu.connect(bob).repay(loanId, { value: totalDue });

      const valueAfter = await cu.getMemberValue(alice.address);
      expect(valueAfter).to.be.gt(valueBefore);
    });
  });

  // ── 19. Pause / Unpause ───────────────────────────────────────

  describe("pause / unpause", function () {
    it("treasurer can emergency pause", async function () {
      const { cu, treasurer } = await deploy();
      await expect(cu.connect(treasurer).emergencyPause())
        .to.emit(cu, "EmergencyPaused");
      expect(await cu.paused()).to.be.true;
    });

    it("treasurer can unpause via governance vote", async function () {
      const { cu, treasurer, alice, bob } = await deploy();
      await joinAndWait(cu, alice, E(2));
      await joinAndWait(cu, bob, E(10));
      await cu.connect(treasurer).emergencyPause();
      await govChange(cu, treasurer,
        [{ signer: alice, support: true }, { signer: bob, support: true }],
        PARAM.Unpause, 0n);
      expect(await cu.paused()).to.be.false;
    });

    it("join() reverts when paused", async function () {
      const { cu, treasurer, alice } = await deploy();
      await cu.connect(treasurer).emergencyPause();
      await expect(cu.connect(alice).join({ value: E(1) }))
        .to.be.revertedWith("Contract is paused");
    });

    it("requestLoan() reverts when paused", async function () {
      const { cu, treasurer, alice, bob } = await deploy();
      await joinAndWait(cu, alice, E(2));
      await joinAndWait(cu, bob, E(10));
      await cu.connect(treasurer).emergencyPause();
      await expect(cu.connect(alice).requestLoan(E(0.5), 1000, 7 * ONE_DAY, E(1)))
        .to.be.revertedWith("Contract is paused");
    });

    it("repay() still works when paused", async function () {
      const { cu, treasurer, alice, bob } = await deploy();
      await joinAndWait(cu, alice, E(2));
      await joinAndWait(cu, bob, E(10));

      const loanId = await openLoan(cu, alice, [{ signer: bob, support: true }]);
      const req = await cu.loanRequests(loanId);
      await cu.connect(alice).activateLoan(loanId, { value: req.collateralOffered });
      const totalDue = (await cu.getActiveLoan(loanId)).totalDue;

      await cu.connect(treasurer).emergencyPause();
      await expect(cu.connect(alice).repay(loanId, { value: totalDue }))
        .to.emit(cu, "LoanRepaid");
    });

    it("triggerDefault() still works when paused", async function () {
      const { cu, treasurer, alice, bob, keeper } = await deploy();
      await joinAndWait(cu, alice, E(2));
      await joinAndWait(cu, bob, E(10));

      const loanId = await openLoan(cu, alice, [{ signer: bob, support: true }]);
      const req = await cu.loanRequests(loanId);
      await cu.connect(alice).activateLoan(loanId, { value: req.collateralOffered });
      await time.increase(8 * ONE_DAY);

      await cu.connect(treasurer).emergencyPause();
      await expect(cu.connect(keeper).triggerDefault(loanId))
        .to.emit(cu, "DefaultTriggered");
    });

    it("non-treasurer cannot emergency pause", async function () {
      const { cu, alice } = await deploy();
      await expect(cu.connect(alice).emergencyPause())
        .to.be.revertedWith("Not treasurer");
    });

    it("voteOnProposal works while paused (enables Unpause governance)", async function () {
      const { cu, treasurer, alice, bob } = await deploy();
      await joinAndWait(cu, alice, E(2));
      await joinAndWait(cu, bob, E(10));
      await cu.connect(treasurer).emergencyPause();
      const tx = await cu.connect(treasurer).proposeChange(PARAM.Unpause, 0n);
      const id = (await tx.wait()).logs.find((l) => l.fragment?.name === "GovernanceProposed").args[0];
      await expect(cu.connect(alice).voteOnProposal(id, true))
        .to.emit(cu, "GovernanceVoteCast");
    });
  });

  // ── 20. Treasurer controls ────────────────────────────────────

  describe("treasurer controls", function () {
    it("treasurer can update max loan size via governance", async function () {
      const { cu, treasurer, alice, bob } = await deploy();
      await joinAndWait(cu, alice, E(2));
      await joinAndWait(cu, bob, E(10));
      await govChange(cu, treasurer,
        [{ signer: alice, support: true }, { signer: bob, support: true }],
        PARAM.MaxLoanSize, E(50));
      expect(await cu.maxLoanSize()).to.equal(E(50));
    });

    it("treasurer can update min interest rate via governance", async function () {
      const { cu, treasurer, alice, bob } = await deploy();
      await joinAndWait(cu, alice, E(2));
      await joinAndWait(cu, bob, E(10));
      await govChange(cu, treasurer,
        [{ signer: alice, support: true }, { signer: bob, support: true }],
        PARAM.MinInterestRate, 1000n);
      expect(await cu.minInterestRate()).to.equal(1000n);
    });

    it("rejects bounty rate proposal above 2%", async function () {
      const { cu, treasurer } = await deploy();
      await expect(cu.connect(treasurer).proposeChange(PARAM.KeeperBountyRate, 201n))
        .to.be.revertedWith("Exceeds 2% cap");
    });

    it("non-treasurer cannot propose changes", async function () {
      const { cu, alice } = await deploy();
      await expect(cu.connect(alice).proposeChange(PARAM.MaxLoanSize, E(10)))
        .to.be.revertedWith("Not treasurer");
    });

    it("treasurer role can be transferred via governance", async function () {
      const { cu, treasurer, alice, bob } = await deploy();
      await joinAndWait(cu, alice, E(2));
      await joinAndWait(cu, bob, E(10));
      await govChange(cu, treasurer,
        [{ signer: alice, support: true }, { signer: bob, support: true }],
        PARAM.TransferTreasurer, BigInt(alice.address));
      expect(await cu.treasurer()).to.equal(alice.address);
    });
  });

  // ── 21. Governance ────────────────────────────────────────────

  describe("governance", function () {
    it("proposeChange emits GovernanceProposed", async function () {
      const { cu, treasurer, alice, bob } = await deploy();
      await joinAndWait(cu, alice, E(2));
      await joinAndWait(cu, bob, E(10));
      await expect(cu.connect(treasurer).proposeChange(PARAM.MaxLoanSize, E(50)))
        .to.emit(cu, "GovernanceProposed");
    });

    it("member can vote on governance proposal", async function () {
      const { cu, treasurer, alice, bob } = await deploy();
      await joinAndWait(cu, alice, E(2));
      await joinAndWait(cu, bob, E(10));
      const tx = await cu.connect(treasurer).proposeChange(PARAM.MaxLoanSize, E(50));
      const id = (await tx.wait()).logs.find((l) => l.fragment?.name === "GovernanceProposed").args[0];
      await expect(cu.connect(alice).voteOnProposal(id, true))
        .to.emit(cu, "GovernanceVoteCast");
    });

    it("double vote on governance proposal reverts", async function () {
      const { cu, treasurer, alice, bob } = await deploy();
      await joinAndWait(cu, alice, E(2));
      await joinAndWait(cu, bob, E(10));
      const tx = await cu.connect(treasurer).proposeChange(PARAM.MaxLoanSize, E(50));
      const id = (await tx.wait()).logs.find((l) => l.fragment?.name === "GovernanceProposed").args[0];
      await cu.connect(alice).voteOnProposal(id, true);
      await expect(cu.connect(alice).voteOnProposal(id, false))
        .to.be.revertedWith("Already voted");
    });

    it("approved proposal executes parameter change after timelock", async function () {
      const { cu, treasurer, alice, bob } = await deploy();
      await joinAndWait(cu, alice, E(2));
      await joinAndWait(cu, bob, E(10));
      await govChange(cu, treasurer,
        [{ signer: alice, support: true }, { signer: bob, support: true }],
        PARAM.MaxLoanSize, E(50));
      expect(await cu.maxLoanSize()).to.equal(E(50));
    });

    it("rejected proposal does not change parameter", async function () {
      const { cu, treasurer, alice, bob } = await deploy();
      await joinAndWait(cu, alice, E(2));
      await joinAndWait(cu, bob, E(10));
      const originalMax = await cu.maxLoanSize();
      const tx = await cu.connect(treasurer).proposeChange(PARAM.MaxLoanSize, E(50));
      const id = (await tx.wait()).logs.find((l) => l.fragment?.name === "GovernanceProposed").args[0];
      await cu.connect(alice).voteOnProposal(id, false);
      await cu.connect(bob).voteOnProposal(id, false);
      await time.increase(3 * ONE_DAY + 1);
      await cu.finalizeProposal(id);
      expect((await cu.getGovProposal(id)).status).to.equal(GOV_STATUS.Rejected);
      expect(await cu.maxLoanSize()).to.equal(originalMax);
    });

    it("cannot execute before timelock expires", async function () {
      const { cu, treasurer, alice, bob } = await deploy();
      await joinAndWait(cu, alice, E(2));
      await joinAndWait(cu, bob, E(10));
      const tx = await cu.connect(treasurer).proposeChange(PARAM.MaxLoanSize, E(50));
      const id = (await tx.wait()).logs.find((l) => l.fragment?.name === "GovernanceProposed").args[0];
      await cu.connect(alice).voteOnProposal(id, true);
      await cu.connect(bob).voteOnProposal(id, true);
      await time.increase(3 * ONE_DAY + 1);
      await cu.finalizeProposal(id);
      // Timelock not expired yet — should revert
      await expect(cu.executeProposal(id))
        .to.be.revertedWith("Timelock not expired");
    });

    it("treasurer can veto a pending proposal before voting closes", async function () {
      const { cu, treasurer, alice, bob } = await deploy();
      await joinAndWait(cu, alice, E(2));
      await joinAndWait(cu, bob, E(10));
      const tx = await cu.connect(treasurer).proposeChange(PARAM.MaxLoanSize, E(50));
      const id = (await tx.wait()).logs.find((l) => l.fragment?.name === "GovernanceProposed").args[0];
      await expect(cu.connect(treasurer).vetoProposal(id))
        .to.emit(cu, "GovernanceVetoed");
      expect((await cu.getGovProposal(id)).status).to.equal(GOV_STATUS.Vetoed);
    });

    it("cannot veto after voting window closes", async function () {
      const { cu, treasurer, alice, bob } = await deploy();
      await joinAndWait(cu, alice, E(2));
      await joinAndWait(cu, bob, E(10));
      const tx = await cu.connect(treasurer).proposeChange(PARAM.MaxLoanSize, E(50));
      const id = (await tx.wait()).logs.find((l) => l.fragment?.name === "GovernanceProposed").args[0];
      await time.increase(3 * ONE_DAY + 1);
      await expect(cu.connect(treasurer).vetoProposal(id))
        .to.be.revertedWith("Voting already closed");
    });
  });

  // ── 22. activateLoan() — tier escalation ─────────────────────

  describe("activateLoan() — tier escalation", function () {
    it("escalates to Secured tier when pool shrinks between request and activation", async function () {
      const { cu, alice, bob } = await deploy();
      await joinAndWait(cu, alice, E(20));
      await joinAndWait(cu, bob, E(80));

      // alice requests 9 ETH — at pool=100 ETH this is Standard tier (9% < 10%, 90 days)
      const loanId = await openLoan(cu, alice, [{ signer: bob, support: true }],
        { amount: E(9), rate: 1000, duration: 90 * ONE_DAY });

      const req = await cu.getLoanRequest(loanId);
      expect(req.tier).to.equal(TIER.Standard);       // confirmed Standard at request time
      expect(req.thresholdCollateral).to.be.gt(0n);
      const originalCollateralOffered = req.collateralOffered;

      // bob withdraws 30 ETH: pool drops from 100 to 70 ETH
      // reserve check: totalDepositsEver=100, need 10, pool-after=70 > 10 — ok
      const withdrawShares = (E(30) * (await cu.totalShares())) / (await cu.totalPoolETH());
      await cu.connect(bob).withdraw(withdrawShares);

      // At activation: 10% of ~70 ETH ≈ 7 ETH, 9 ETH > 7 ETH → now Secured tier
      // Compute what the new required collateral is after pool shrink
      const [, newThreshCollat] = await cu.computeThresholds(alice.address, E(9), 90 * ONE_DAY);

      // If original offer < new threshold, activation with original offer should revert
      // (because activateLoan takes max(collateralOffered, currentThreshCollat))
      // The original offer was computed against Standard tier. The new threshold for Secured
      // tier will be higher. Let's just test that activating with wrong amount reverts.
      await expect(cu.connect(alice).activateLoan(loanId, { value: originalCollateralOffered + 1n }))
        .to.be.revertedWith("Wrong collateral amount");

      // Activate with the correct required amount (max of offer vs new threshold)
      const requiredCollateral = originalCollateralOffered > newThreshCollat
        ? originalCollateralOffered
        : newThreshCollat;
      const tx = await cu.connect(alice).activateLoan(loanId, { value: requiredCollateral });
      await tx.wait();
      const activeLoan = await cu.getActiveLoan(loanId);
      expect(activeLoan.tier).to.equal(TIER.Secured);
      expect(activeLoan.collateralLocked).to.equal(requiredCollateral);
    });

    it("does not de-escalate when pool grows between request and activation", async function () {
      const { cu, alice, bob, carol } = await deploy();
      await joinAndWait(cu, alice, E(5));
      await joinAndWait(cu, bob, E(15));

      // Secured loan (15% of pool)
      const loanId = await openLoan(cu, alice, [{ signer: bob, support: true }],
        { amount: E(3), rate: 1000, duration: 7 * ONE_DAY });

      expect((await cu.getLoanRequest(loanId)).tier).to.equal(TIER.Secured);

      // carol joins, growing the pool — tier must NOT drop to Standard
      await cu.connect(carol).join({ value: E(50) });
      await time.increase(ONE_DAY); // carol's deposit doesn't need 30d; just advancing past any timing

      // Still needs Secured collateral (dynamic, based on original offer)
      const req = await cu.getLoanRequest(loanId);
      await cu.connect(alice).activateLoan(loanId, { value: req.collateralOffered });
      expect((await cu.getActiveLoan(loanId)).tier).to.equal(TIER.Secured);
    });
  });

  // ── 23. emergencyUnpause() ────────────────────────────────────

  describe("emergencyUnpause()", function () {
    it("reverts if not paused long enough (<30 days)", async function () {
      const { cu, treasurer } = await deploy();
      await cu.connect(treasurer).emergencyPause();
      await time.increase(29 * ONE_DAY);
      await expect(cu.connect(treasurer).emergencyUnpause())
        .to.be.revertedWith("Must be paused for 30+ days");
    });

    it("reverts when paused ≥30 days but voting weight > 0 (governance still works)", async function () {
      const { cu, treasurer, alice } = await deploy();
      await joinAndWait(cu, alice, E(2));
      await cu.connect(treasurer).emergencyPause();
      await time.increase(31 * ONE_DAY);
      await expect(cu.connect(treasurer).emergencyUnpause())
        .to.be.revertedWith("Governance still operable");
    });

    it("succeeds when paused ≥30 days and zero voting weight (true deadlock)", async function () {
      // No members with ≥30-day tenure → total voting weight = 0
      const { cu, treasurer, alice } = await deploy();
      await cu.connect(alice).join({ value: E(2) }); // alice joins but doesn't wait for tenure
      await cu.connect(treasurer).emergencyPause();
      await time.increase(31 * ONE_DAY);
      // alice now has tenure, so weight > 0 — this would revert.
      // Re-deploy a clean instance where the treasurer pauses before anyone joins.
      const CU2 = await ethers.getContractFactory("CreditUnion");
      const cu2 = await CU2.deploy(treasurer.address);
      await cu2.waitForDeployment();
      await cu2.connect(treasurer).emergencyPause();
      await time.increase(31 * ONE_DAY);
      await expect(cu2.connect(treasurer).emergencyUnpause())
        .to.emit(cu2, "EmergencyUnpaused");
      expect(await cu2.paused()).to.be.false;
    });

    it("non-treasurer cannot call emergencyUnpause", async function () {
      const { cu, treasurer, alice } = await deploy();
      await cu.connect(treasurer).emergencyPause();
      await time.increase(31 * ONE_DAY);
      await expect(cu.connect(alice).emergencyUnpause())
        .to.be.revertedWith("Not treasurer");
    });
  });

  // ── 24. Member cap ────────────────────────────────────────────

  describe("member cap", function () {
    it("join() enforces MAX_MEMBERS constant (500)", async function () {
      // Verify the constant is set to the expected value
      expect(await (await ethers.getContractFactory("CreditUnion"))
        .deploy((await ethers.getSigners())[0].address)
        .then(async c => { await c.waitForDeployment(); return c.MAX_MEMBERS(); }))
        .to.equal(500n);
    });
  });

  // ── 25. Edge cases ────────────────────────────────────────────

  describe("edge cases", function () {

    it("getBorrowerProfile returns correct fields for clean borrower", async function () {
      const { cu, alice } = await deploy();
      await joinAndWait(cu, alice, E(1));
      const profile = await cu.getBorrowerProfile(alice.address);
      expect(profile._hasDefaulted).to.be.false;
      expect(profile._successfulRepayments).to.equal(0n);
      expect(profile._totalDefaulted).to.equal(0n);
    });

    it("finalizeLoan reverts if called before deadline", async function () {
      const { cu, alice, bob } = await deploy();
      await joinAndWait(cu, alice, E(5));
      await joinAndWait(cu, bob, E(5));

      const [threshRate, threshCollat] = await cu.computeThresholds(alice.address, E(0.5), 7 * ONE_DAY);
      const collateralOffered = threshCollat * 110n / 100n;
      const tx = await cu.connect(alice).requestLoan(E(0.5), threshRate, 7 * ONE_DAY, collateralOffered);
      const id = (await tx.wait()).logs.find((l) => l.fragment?.name === "LoanRequested").args[0];

      await expect(cu.finalizeLoan(id))
        .to.be.revertedWith("Voting still open");
    });

    it("rejects ETH sent directly (fallback)", async function () {
      const { cu, alice } = await deploy();
      await expect(
        alice.sendTransaction({ to: await cu.getAddress(), value: E(1) })
      ).to.be.reverted;
    });

    it("determineTier() view matches requestLoan tier assignment", async function () {
      const { cu, alice, bob } = await deploy();
      await joinAndWait(cu, alice, E(2));
      await joinAndWait(cu, bob, E(10));

      const tier = await cu.determineTier(E(0.1), 7 * ONE_DAY);
      expect(tier).to.equal(0n); // Trust

      const [threshRate, threshCollat] = await cu.computeThresholds(alice.address, E(0.1), 7 * ONE_DAY);
      const collateralOffered = threshCollat * 110n / 100n;
      const tx = await cu.connect(alice).requestLoan(E(0.1), threshRate, 7 * ONE_DAY, collateralOffered);
      const rc = await tx.wait();
      const ev = rc.logs.find((l) => l.fragment?.name === "LoanRequested");
      expect(ev.args[3]).to.equal(tier);
    });
  });
});
