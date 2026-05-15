const fs = require("fs");
const hre = require("hardhat");

async function main() {
  const { ethers } = hre;
  const addr = JSON.parse(fs.readFileSync("./frontend/contractAddress.json", "utf8")).address;
  const CU = await ethers.getContractAt("CreditUnion", addr);
  const signers = await ethers.getSigners();
  const fmt = (v) => ethers.formatEther(v);

  const contractBalance = await ethers.provider.getBalance(addr);
  const [totalPoolETH, totalShares, memberCount, loanCount] = await CU.getPool();
  const totalDepositsEver = await CU.totalDepositsEver();

  console.log("=== Contract ===");
  console.log("address:           ", addr);
  console.log("contract ETH bal:  ", fmt(contractBalance));
  console.log("totalPoolETH:      ", fmt(totalPoolETH));
  console.log("totalShares:       ", fmt(totalShares), "(shares wei-scaled)");
  console.log("totalDepositsEver: ", fmt(totalDepositsEver));
  console.log("memberCount:       ", memberCount.toString());
  console.log("loanCounter:       ", loanCount.toString());

  console.log("\n=== Wallets (accounts 0–9) ===");
  for (let i = 0; i < 10; i++) {
    const s = signers[i];
    const bal = await ethers.provider.getBalance(s.address);
    console.log(`acct${i} ${s.address}: ${fmt(bal)} ETH`);
  }

  console.log("\n=== Members ===");
  for (let i = 0; i < 10; i++) {
    const s = signers[i];
    const m = await CU.members(s.address);
    if (m.exists) {
      const value = await CU.getMemberValue(s.address);
      const weight = await CU.computeVotingWeight(s.address);
      const locked = await CU.lockedGuarantorValueEth(s.address);
      console.log(`acct${i}:`);
      console.log(`  shares:        ${fmt(m.shares)}`);
      console.log(`  depositAmount: ${fmt(m.depositAmount)}  (cost-basis used in voting weight)`);
      console.log(`  joinTimestamp: ${m.joinTimestamp.toString()}`);
      console.log(`  current value: ${fmt(value)}`);
      console.log(`  voting weight: ${weight.toString()}`);
      console.log(`  locked guarantee: ${fmt(locked)}`);
    }
  }

  const STATUS = ["Pending","Approved","Rejected","Active","Repaid","Defaulted"];
  const TIER   = ["Trust","Standard","Secured"];
  const COL    = ["ETH","NFT"];

  console.log("\n=== Loans ===");
  for (let id = 1n; id <= loanCount; id++) {
    const r = await CU.getLoanRequest(id);
    console.log(`\nLoan #${id}: ${STATUS[Number(r.status)]}, ${TIER[Number(r.tier)]}, ${COL[Number(r.collateralType)]}`);
    console.log(`  borrower:          ${r.borrower}`);
    console.log(`  amount:            ${fmt(r.amount)}`);
    console.log(`  interestRate:      ${r.interestRate} bps`);
    console.log(`  duration:          ${(Number(r.duration) / 86400).toFixed(2)} days`);
    console.log(`  thresholdRate:     ${r.thresholdRate} bps`);
    console.log(`  thresholdCollat:   ${fmt(r.thresholdCollateral)}`);
    console.log(`  collateralOffered: ${fmt(r.collateralOffered)}`);
    console.log(`  collateralHeld:    ${fmt(await CU.collateralHeld(id))}`);
    console.log(`  approvalThresh:    ${r.approvalThresholdBps} bps`);
    console.log(`  votesFor:          ${r.votesFor.toString()}`);
    console.log(`  totalWeightSnap:   ${r.totalVotingWeightSnapshot.toString()}`);
    console.log(`  voteDeadline:      ${r.voteDeadline.toString()}`);
    if (r.requiresGuarantor) {
      console.log(`  guarantor:         ${r.guarantor} (approved=${r.guarantorApproved}, required=${fmt(r.guaranteeRequired)})`);
    }

    const a = await CU.getActiveLoan(id);
    if (a.borrower !== ethers.ZeroAddress) {
      console.log(`  -- active record --`);
      console.log(`  principal:     ${fmt(a.principal)}`);
      console.log(`  interest:      ${fmt(a.interest)}`);
      console.log(`  totalDue:      ${fmt(a.totalDue)}`);
      console.log(`  amountRepaid:  ${fmt(a.amountRepaid)}`);
      console.log(`  collatLocked:  ${fmt(a.collateralLocked)}`);
      console.log(`  deadline:      ${a.repaymentDeadline.toString()}`);
      console.log(`  defaulted:     ${a.defaultTriggered}`);
      if (a.requiresGuarantor) {
        console.log(`  guaranteeLocked: ${fmt(a.guaranteeLocked)}`);
        console.log(`  guaranteeAmount: ${fmt(a.guaranteeAmount)}`);
      }
    }
  }

  const block = await ethers.provider.getBlock("latest");
  console.log("\n=== Chain ===");
  console.log("block:     ", block.number);
  console.log("timestamp: ", block.timestamp, `(${new Date(Number(block.timestamp)*1000).toISOString()})`);

  const startingBalance = ethers.parseEther("10000");
  console.log("\n=== System ETH conservation ===");
  let walletSum = 0n;
  for (let i = 0; i < 20; i++) {
    const bal = await ethers.provider.getBalance(signers[i].address);
    walletSum += bal;
  }
  const total = walletSum + contractBalance;
  const expected = startingBalance * 20n;
  console.log(`sum of 20 wallets: ${fmt(walletSum)}`);
  console.log(`contract balance:  ${fmt(contractBalance)}`);
  console.log(`total:             ${fmt(total)}`);
  console.log(`expected:          ${fmt(expected)} (20 × 10000 ETH starting)`);
  console.log(`difference:        ${fmt(total - expected)}  (negative = lost to gas)`);
}

main().catch((e) => { console.error(e); process.exit(1); });
