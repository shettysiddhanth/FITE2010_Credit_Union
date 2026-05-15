/* ─────────────────────────────────────────────────────────────
   CreditUnion frontend — ethers.js v6
   ───────────────────────────────────────────────────────────── */

// ── Global state ──────────────────────────────────────────────

let provider, signer, contract, ABI;
let signerAddress = null;
let contractAddress = null;

// LoanStatus / LoanTier mirrors from Solidity enum
const STATUS = { Pending: 0, Approved: 1, Rejected: 2, Active: 3, Repaid: 4, Defaulted: 5 };
const STATUS_LABEL    = ["Pending", "Approved", "Rejected", "Active", "Repaid", "Defaulted"];
const TIER_LABEL      = ["Trust", "Standard", "Secured"];
const TIER_CLASS      = ["tier-trust", "tier-standard", "tier-secured"];
const GOV_PARAM_LABEL = ["Max Loan Size", "Min Interest Rate", "Keeper Bounty Rate", "Unpause", "Transfer Treasurer"];

// ── Boot ──────────────────────────────────────────────────────

async function boot() {
  try {
    const [addrRes, abiRes] = await Promise.all([
      fetch("contractAddress.json"),
      fetch("contractABI.json"),
    ]);
    const addrJson = await addrRes.json();
    ABI            = await abiRes.json();
    contractAddress = addrJson.address;
  } catch {
    toast("Could not load contractAddress.json / contractABI.json. Run the deploy script first.", "error");
    return;
  }

  setupTabs();
  setupProfileLookup();
  await initProvider();
}

// ── Wallet ────────────────────────────────────────────────────

async function initProvider() {
  try {
    // JsonRpcProvider (not BrowserProvider) — no MetaMask needed.
    // Hardhat exposes all 20 test accounts with unlocked signers over RPC.
    provider = new ethers.JsonRpcProvider("http://127.0.0.1:8545");
    const accounts = await provider.listAccounts();
    if (accounts.length === 0) {
      toast("No accounts found on Hardhat node.", "error");
      return;
    }

    const select = document.getElementById("account-select");
    accounts.forEach((acct, i) => {
      const opt = document.createElement("option");
      opt.value = acct.address;
      opt.textContent = `#${i}  ${acct.address}`;
      select.appendChild(opt);
    });

    select.addEventListener("change", async () => {
      if (!select.value) return;
      await connectAccount(select.value);
    });
  } catch {
    toast("Cannot reach Hardhat node at localhost:8545 — run: npx hardhat node", "error");
  }
}

async function connectAccount(address) {
  try {
    signer        = await provider.getSigner(address);
    signerAddress = address;
    contract      = new ethers.Contract(contractAddress, ABI, signer);

    const addrEl = document.getElementById("wallet-addr");
    addrEl.textContent = truncateAddr(address);
    addrEl.classList.remove("hidden");

    // Always hide first so switching away from treasurer hides the tab.
    document.getElementById("btn-tab-treasurer").classList.add("hidden");
    setupDevTools();
    await maybeShowTreasurerTab();
    await refreshCurrentTab();
  } catch (e) {
    toast(parseError(e), "error");
  }
}

function setupDevTools() {
  updateBlockTime();
  document.getElementById("btn-advance-time").onclick = async () => {
    const days = parseInt(document.getElementById("advance-days").value) || 31;
    // evm_increaseTime shifts the clock; evm_mine seals a new block so the
    // new timestamp is visible to the next contract call.
    await provider.send("evm_increaseTime", [days * 86400]);
    await provider.send("evm_mine",         []);
    await updateBlockTime();
    toast(`Chain time advanced ${days} days.`, "success");
    await refreshCurrentTab();
  };
}

async function updateBlockTime() {
  const block = await provider.getBlock("latest");
  document.getElementById("block-time").textContent =
    new Date(Number(block.timestamp) * 1000).toLocaleString();
}

async function maybeShowTreasurerTab() {
  try {
    const treas = await contract.treasurer();
    const tabBtn = document.getElementById("btn-tab-treasurer");
    if (treas.toLowerCase() === signerAddress.toLowerCase()) {
      tabBtn.classList.remove("hidden");
    } else {
      tabBtn.classList.add("hidden");
      // If we just lost the role and the treasurer tab is currently active,
      // fall back to Pool Overview so we're not stuck on an empty/error pane.
      const activeBtn = document.querySelector("button.tab.active");
      if (activeBtn?.dataset.tab === "treasurer") {
        document.querySelector('button.tab[data-tab="overview"]').click();
      }
    }
  } catch { /* ignore */ }
}

// ── Tabs ──────────────────────────────────────────────────────

function setupTabs() {
  document.querySelectorAll("button.tab").forEach(btn => {
    btn.addEventListener("click", async () => {
      document.querySelectorAll("button.tab").forEach(b => b.classList.remove("active"));
      document.querySelectorAll(".tab-content").forEach(s => {
        s.classList.remove("active");
        s.classList.add("hidden");
      });
      btn.classList.add("active");
      const target = document.getElementById("tab-" + btn.dataset.tab);
      target.classList.remove("hidden");
      target.classList.add("active");
      if (contract) await refreshTab(btn.dataset.tab);
    });
  });
}

function activeTab() {
  const btn = document.querySelector("button.tab.active");
  return btn ? btn.dataset.tab : "overview";
}

async function refreshCurrentTab() {
  // Re-check treasurer role on every refresh so a TransferTreasurer governance
  // execution updates tab visibility for both the old and new treasurer without
  // requiring them to re-select their account from the dropdown.
  if (contract) await maybeShowTreasurerTab();
  await refreshTab(activeTab());
}

async function refreshTab(tab) {
  if (tab === "guide") return;   // static content, nothing to fetch
  if (!contract) return;
  switch (tab) {
    case "overview":    await renderOverview();    break;
    case "requests":    await renderRequests();    break;
    case "active":      await renderActive();      break;
    case "governance":  await renderGovernance();  break;
    case "history":     await renderHistory();     break;
    case "treasurer":   await renderTreasurer();   break;
  }
}

// ── Overview ──────────────────────────────────────────────────

async function renderOverview() {
  try {
    const [pool, memberValue, weight, memberData, paused] = await Promise.all([
      contract.getPool(),
      contract.getMemberValue(signerAddress),
      contract.computeVotingWeight(signerAddress),
      contract.members(signerAddress),
      contract.paused(),
    ]);

    document.getElementById("pool-eth").textContent     = formatEth(pool[0]) + " ETH";
    document.getElementById("pool-members").textContent = pool[2].toString();
    document.getElementById("pool-loans").textContent   = pool[3].toString();
    document.getElementById("my-value").textContent     = formatEth(memberValue) + " ETH";
    document.getElementById("my-weight").textContent    = weight.toString();

    const statusEl = document.getElementById("my-status");
    if (memberData.exists) {
      statusEl.innerHTML = '<span class="chip chip-green">Member</span>';
      document.getElementById("deposit-heading").textContent = "Add Deposit";
      document.getElementById("my-shares").textContent = formatEth(memberValue) + " ETH";
    } else {
      statusEl.innerHTML = '<span class="chip chip-amber">Not a member</span>';
      document.getElementById("my-shares").textContent = "0 ETH";
    }

    if (paused) {
      toast("Contract is paused — deposits and new loan requests are disabled.", "error");
    }

    setupOverviewActions(memberData, paused, pool);
  } catch (e) { toast(parseError(e), "error"); }
}

function setupOverviewActions(memberData, paused, pool) {
  // pool[0] = totalPoolETH, pool[1] = totalShares

  // Deposit
  const btnDeposit = document.getElementById("btn-deposit");
  btnDeposit.onclick = async () => {
    const amt = document.getElementById("deposit-amount").value;
    if (!amt) return;
    await txAction(btnDeposit, () => {
      const opts = { value: ethers.parseEther(amt) };
      return memberData.exists ? contract.addDeposit(opts) : contract.join(opts);
    });
  };

  // Withdraw: input is in ETH; shares are wei-scale (1 ETH ≈ 10^18 shares
  // for the first depositor) so we derive shareAmount from the ETH value.
  const withdrawInput = document.getElementById("withdraw-eth");
  withdrawInput.placeholder = "ETH amount";
  const btnWithdraw = document.getElementById("btn-withdraw");
  btnWithdraw.onclick = async () => {
    const ethInput = withdrawInput.value;
    if (!ethInput) return;
    let shareAmount;
    try {
      const totalPoolETH = pool[0];
      const totalShares  = pool[1];
      if (totalPoolETH === 0n || totalShares === 0n) {
        toast("Pool is empty.", "error");
        return;
      }
      const ethWei  = ethers.parseEther(ethInput);
      shareAmount   = (ethWei * totalShares) / totalPoolETH;
      if (shareAmount === 0n) { toast("Amount too small.", "error"); return; }
      if (shareAmount > memberData.shares) shareAmount = memberData.shares;
    } catch {
      toast("Invalid ETH amount.", "error");
      return;
    }
    await txAction(btnWithdraw, () => contract.withdraw(shareAmount));
  };

  if (paused) {
    btnDeposit.disabled = true;
  }
}

// ── Loan Requests ─────────────────────────────────────────────

async function renderRequests() {
  const list = document.getElementById("loan-requests-list");
  try {
    const [pool, memberData, myActiveLoan, paused, block] = await Promise.all([
      contract.getPool(),
      contract.members(signerAddress),
      contract.activeLoanIdOf(signerAddress),
      contract.paused(),
      provider.getBlock("latest"),
    ]);
    // Use block.timestamp, not Date.now(). After evm_increaseTime the chain
    // clock can be days/months ahead of wall clock; Date.now() would
    // incorrectly show vote windows as open/closed.
    const chainNow = Number(block.timestamp);

    const totalLoans = Number(pool[3]);

    // Show / hide submit form
    const formCard = document.getElementById("request-form-card");
    if (!memberData.exists || myActiveLoan !== 0n || paused) {
      formCard.classList.add("hidden");
    } else {
      formCard.classList.remove("hidden");
      setupRequestForm();
    }

    // Gather Pending and Approved requests (Approved = awaiting borrower activation)
    const requests = [];
    for (let i = 1; i <= totalLoans; i++) {
      const req = await contract.getLoanRequest(i);
      const s = Number(req.status);
      if (s === STATUS.Pending || s === STATUS.Approved) requests.push(req);
    }

    if (requests.length === 0) {
      list.innerHTML = '<p class="empty-msg">No pending loan requests.</p>';
      return;
    }

    list.innerHTML = "";
    for (const req of requests) {
      list.appendChild(await buildRequestCard(req, memberData, chainNow));
    }
  } catch (e) { toast(parseError(e), "error"); }
}

function setupRequestForm() {
  const amtEl     = document.getElementById("req-amount");
  const ratEl     = document.getElementById("req-rate");
  const durEl     = document.getElementById("req-duration");
  const collatEl  = document.getElementById("req-collateral");
  const preview   = document.getElementById("tier-preview");

  const updatePreview = async () => {
    try {
      const amt = parseFloat(amtEl.value);
      const dur = parseInt(durEl.value);
      if (!amt || !dur) { preview.classList.add("hidden"); return; }
      const amtWei  = ethers.parseEther(String(amt));
      const durSecs = BigInt(dur * 86400);
      const tier    = Number(await contract.determineTier(amtWei, durSecs));
      const [threshRate, threshCollat] = await contract.computeThresholds(signerAddress, amtWei, durSecs);

      document.getElementById("tier-badge").textContent = TIER_LABEL[tier];
      document.getElementById("tier-badge").className  = "tier-badge " + TIER_CLASS[tier];
      document.getElementById("tier-thresh-rate").textContent = (Number(threshRate) / 100).toFixed(2) + "%";
      document.getElementById("tier-collateral").textContent  = formatEth(threshCollat) + " ETH";

      // Auto-fill collateral input with threshold if user hasn't changed it
      if (!collatEl.dataset.userEdited) {
        collatEl.value = ethers.formatEther(threshCollat);
      }

      // Compute boost indicators
      const rateInput   = parseFloat(ratEl.value);
      const collatInput = parseFloat(collatEl.value);
      const boostHint   = document.getElementById("tier-boost-hint");
      const rateBps     = rateInput ? BigInt(Math.round(rateInput * 100)) : 0n;
      const collatWei   = collatInput ? ethers.parseEther(String(collatInput)) : 0n;
      const rateBoost   = rateBps >= threshRate * 13000n / 10000n;
      const collatBoost = collatWei >= threshCollat * 13000n / 10000n;
      if (rateBoost || collatBoost) {
        const dims = [];
        if (rateBoost)   dims.push("rate");
        if (collatBoost) dims.push("collateral");
        boostHint.textContent = `Approval boost active (${dims.join(" + ")})`;
        boostHint.className   = "chip chip-green";
        boostHint.classList.remove("hidden");
      } else {
        boostHint.classList.add("hidden");
      }

      preview.classList.remove("hidden");
    } catch { preview.classList.add("hidden"); }
  };

  // .oninput assignment (not addEventListener) prevents listener stacking
  // when setupRequestForm is called again on each tab visit.
  amtEl.oninput    = updatePreview;
  durEl.oninput    = updatePreview;
  ratEl.oninput    = updatePreview;
  collatEl.oninput = () => {
    collatEl.dataset.userEdited = "1";
    updatePreview();
  };

  document.getElementById("btn-request-loan").onclick = async (e) => {
    const amt  = amtEl.value;
    const rate = ratEl.value;
    const dur  = durEl.value;
    if (!amt || !rate || !dur) return;
    await txAction(e.target, () => {
      const rateBps  = BigInt(Math.round(parseFloat(rate) * 100));
      const durSecs  = BigInt(parseInt(dur)) * 86400n;
      const collatInput = collatEl.value;
      const collatWei   = collatInput ? ethers.parseEther(collatInput) : 0n;
      return contract.requestLoan(ethers.parseEther(amt), rateBps, durSecs, collatWei);
    });
  };
}

async function buildRequestCard(req, memberData, chainNow) {
  const card = document.createElement("div");
  card.className = "loan-card";

  const deadline  = Number(req.voteDeadline);
  const now       = chainNow;
  const remaining = deadline - now;
  const timeLeft  = remaining > 0 ? formatDuration(remaining) : "Voting closed";

  const [liveTotalWeight, liveVotesFor] = await contract.getLiveVoteTotals(req.id);
  const pct = liveTotalWeight > 0n
    ? Math.min(100, Math.round(Number(liveVotesFor * 10000n / liveTotalWeight) / 100))
    : 0;

  const myVoted     = await contract.hasVoted(req.id, signerAddress);
  const isBorrower  = req.borrower.toLowerCase() === signerAddress.toLowerCase();
  const myWeight    = await contract.computeVotingWeight(signerAddress);
  const canVote     = memberData.exists && !isBorrower && !myVoted && remaining > 0 && myWeight > 0n;

  const tierLabel = TIER_LABEL[Number(req.tier)];
  const tierCls   = TIER_CLASS[Number(req.tier)];

  const isApproved = Number(req.status) === STATUS.Approved;
  const statusChip = isApproved
    ? '<span class="chip chip-green" style="margin-left:8px">Approved</span>'
    : '<span class="chip chip-amber" style="margin-left:8px">Pending</span>';

  card.innerHTML = `
    <div class="loan-card-header">
      <div>
        <strong>#${req.id}</strong>
        ${statusChip}
        <span class="tier-badge ${tierCls}" style="margin-left:8px">${tierLabel}</span>
      </div>
      <span class="mono" style="font-size:12px;color:var(--muted)">${truncateAddr(req.borrower)}</span>
    </div>
    <div class="loan-card-meta">
      <div class="meta-item">Amount<strong>${formatEth(req.amount)} ETH</strong></div>
      <div class="meta-item">Rate<strong>${Number(req.interestRate)/100}%</strong></div>
      <div class="meta-item">Duration<strong>${formatDuration(Number(req.duration))}</strong></div>
      <div class="meta-item">Min Rate<strong>${(Number(req.thresholdRate)/100).toFixed(2)}%</strong></div>
      <div class="meta-item">Min Collateral<strong>${formatEth(req.thresholdCollateral)} ETH</strong></div>
      <div class="meta-item">Collateral Offered<strong>${formatEth(req.collateralOffered)} ETH</strong></div>
      <div class="meta-item">Time left<strong>${timeLeft}</strong></div>
    </div>
    <div style="margin-bottom:10px">
      <div style="display:flex;justify-content:space-between;font-size:12px;color:var(--muted);margin-bottom:4px">
        <span>Votes For</span><span>${pct}% of weight</span>
      </div>
      <div class="progress-bar"><div class="progress-bar-fill" style="width:${pct}%"></div></div>
    </div>
    <div class="loan-card-actions" id="actions-${req.id}"></div>
  `;

  const actions = card.querySelector(`#actions-${req.id}`);

  if (canVote) {
    const btnFor  = btn("Vote Yes", "btn-sm btn-green");
    const btnAgainst = btn("Vote No", "btn-sm btn-red");
    btnFor.onclick    = async () => txAction(btnFor,     async () => contract.vote(req.id, true));
    btnAgainst.onclick = async () => txAction(btnAgainst, async () => contract.vote(req.id, false));
    actions.append(btnFor, btnAgainst);
  } else if (myVoted) {
    actions.innerHTML = '<span style="color:var(--muted);font-size:12px">Voted</span>';
  }

  if (!isApproved && remaining <= 0) {
    const btnFinalize = btn("Finalize", "btn-sm btn-ghost");
    btnFinalize.onclick = async () => txAction(btnFinalize, async () => contract.finalizeLoan(req.id));
    actions.appendChild(btnFinalize);
  }

  if (isApproved && isBorrower) {
    const activationDeadline = Number(req.approvalTimestamp) + 7 * 86400;
    const timeToActivate     = activationDeadline - now;
    const expired            = timeToActivate <= 0;

    if (expired) {
      const msg = document.createElement("span");
      msg.style.cssText = "color:var(--red);font-size:12px";
      msg.textContent   = "Activation window expired";
      actions.appendChild(msg);
    } else {
      const btnActivate = btn("Activate Loan", "btn-sm btn-green");
      btnActivate.onclick = async () => txAction(btnActivate, async () => {
        // Re-evaluate tier at activation time — pool may have changed since requestLoan,
        // potentially escalating the required collateral. Only escalate, never de-escalate.
        // The contract requires max(collateralOffered, currentThreshCollat).
        const activeTierNum = Number(await contract.determineTier(req.amount, req.duration));
        const activeTier    = activeTierNum > Number(req.tier) ? activeTierNum : Number(req.tier);
        const [, currentThreshCollat] = await contract.computeThresholds(req.borrower, req.amount, req.duration);
        const collat = req.collateralOffered > currentThreshCollat ? req.collateralOffered : currentThreshCollat;
        return contract.activateLoan(req.id, { value: collat });
      });
      const timeHint = document.createElement("span");
      timeHint.style.cssText = "color:var(--muted);font-size:11px;margin-left:8px";
      timeHint.textContent   = formatDuration(timeToActivate) + " to activate";
      actions.append(btnActivate, timeHint);
    }
  }

  return card;
}

// ── Active Loans ──────────────────────────────────────────────

async function renderActive() {
  const list = document.getElementById("active-loans-list");
  try {
    const [pool, block] = await Promise.all([
      contract.getPool(),
      provider.getBlock("latest"),
    ]);
    const chainNow   = Number(block.timestamp);
    const totalLoans = Number(pool[3]);

    const active = [];
    for (let i = 1; i <= totalLoans; i++) {
      const req = await contract.getLoanRequest(i);
      if (Number(req.status) === STATUS.Active) {
        const loan = await contract.getActiveLoan(i);
        active.push({ req, loan });
      }
    }

    if (active.length === 0) {
      list.innerHTML = '<p class="empty-msg">No active loans.</p>';
      return;
    }

    list.innerHTML = "";
    for (const { req, loan } of active) {
      list.appendChild(buildActiveLoanCard(req, loan, chainNow));
    }
  } catch (e) { toast(parseError(e), "error"); }
}

function buildActiveLoanCard(req, loan, chainNow) {
  const card = document.createElement("div");
  card.className = "loan-card";

  const now        = chainNow;
  const deadline   = Number(loan.repaymentDeadline);
  const overdue    = now > deadline;
  const remaining  = loan.totalDue - loan.amountRepaid;
  const paidPct    = loan.totalDue > 0n
    ? Math.min(100, Math.round(Number(loan.amountRepaid * 10000n / loan.totalDue) / 100))
    : 0;
  const isBorrower = loan.borrower.toLowerCase() === signerAddress.toLowerCase();
  const tierLabel  = TIER_LABEL[Number(loan.tier)];
  const tierCls    = TIER_CLASS[Number(loan.tier)];

  card.innerHTML = `
    <div class="loan-card-header">
      <div>
        <strong>#${req.id}</strong>
        <span class="chip chip-amber" style="margin-left:8px">Active</span>
        <span class="tier-badge ${tierCls}" style="margin-left:8px">${tierLabel}</span>
        ${overdue ? '<span class="chip chip-red" style="margin-left:8px">OVERDUE</span>' : ""}
      </div>
      <span class="mono" style="font-size:12px;color:var(--muted)">${truncateAddr(loan.borrower)}</span>
    </div>
    <div class="loan-card-meta">
      <div class="meta-item">Principal<strong>${formatEth(loan.principal)} ETH</strong></div>
      <div class="meta-item">Total Due<strong>${formatEth(loan.totalDue)} ETH</strong></div>
      <div class="meta-item">Repaid<strong>${formatEth(loan.amountRepaid)} ETH</strong></div>
      <div class="meta-item">Remaining<strong>${formatEth(remaining)} ETH</strong></div>
      <div class="meta-item">Collateral Locked<strong>${formatEth(loan.collateralLocked)} ETH</strong></div>
      <div class="meta-item">Deadline<strong>${overdue ? "⚠ " : ""}${new Date(deadline * 1000).toLocaleDateString()}</strong></div>
    </div>
    <div style="margin-bottom:10px">
      <div style="display:flex;justify-content:space-between;font-size:12px;color:var(--muted);margin-bottom:4px">
        <span>Repayment progress</span><span>${paidPct}%</span>
      </div>
      <div class="progress-bar"><div class="progress-bar-fill" style="width:${paidPct}%"></div></div>
    </div>
    <div class="loan-card-actions" id="active-actions-${req.id}"></div>
  `;

  const actions = card.querySelector(`#active-actions-${req.id}`);

  if (isBorrower) {
    const input = document.createElement("input");
    input.type        = "number";
    input.placeholder = "ETH to repay";
    input.step        = "0.001";
    input.style.maxWidth = "160px";
    const btnRepay = btn("Repay", "btn-sm btn-green");
    btnRepay.onclick = async () => {
      if (!input.value) return;
      await txAction(btnRepay, () =>
        contract.repay(req.id, { value: ethers.parseEther(input.value) })
      );
    };
    actions.append(input, btnRepay);

    if (remaining > 0n) {
      const btnRepayAll = btn("Repay Remaining", "btn-sm btn-ghost");
      btnRepayAll.title = ethers.formatEther(remaining) + " ETH";
      btnRepayAll.onclick = async () =>
        txAction(btnRepayAll, () => contract.repay(req.id, { value: remaining }));
      actions.appendChild(btnRepayAll);
    }
  }

  if (overdue) {
    const btnDefault = btn("Trigger Default", "btn-sm btn-red");
    btnDefault.onclick = async () => txAction(btnDefault, async () => contract.triggerDefault(req.id));
    actions.appendChild(btnDefault);
  }

  return card;
}

// ── History ───────────────────────────────────────────────────

async function renderHistory() {
  const list = document.getElementById("history-list");
  try {
    const pool = await contract.getPool();
    const totalLoans = Number(pool[3]);

    const done = [];
    for (let i = 1; i <= totalLoans; i++) {
      const req = await contract.getLoanRequest(i);
      const s   = Number(req.status);
      if (s === STATUS.Repaid || s === STATUS.Defaulted) {
        const loan = await contract.getActiveLoan(i);
        done.push({ req, loan });
      }
    }

    if (done.length === 0) {
      list.innerHTML = '<p class="empty-msg">No completed loans yet.</p>';
      return;
    }

    list.innerHTML = `
      <table class="data-table">
        <thead>
          <tr>
            <th>#</th><th>Borrower</th><th>Principal</th>
            <th>Interest</th><th>Repaid</th><th>Collateral</th>
            <th>Outcome</th><th>Note</th>
          </tr>
        </thead>
        <tbody id="history-tbody"></tbody>
      </table>
    `;
    const tbody = list.querySelector("#history-tbody");

    for (const { req, loan } of done) {
      const isRepaid    = Number(req.status) === STATUS.Repaid;
      const badDebt     = loan.totalDue > loan.amountRepaid ? loan.totalDue - loan.amountRepaid : 0n;
      const seizedNote  = isRepaid ? "" : `Collateral seized; ~${formatEth(loan.collateralLocked)} ETH recovered`;

      const tr = document.createElement("tr");
      tr.innerHTML = `
        <td class="mono">${req.id}</td>
        <td><span class="mono truncate" title="${loan.borrower}">${truncateAddr(loan.borrower)}</span></td>
        <td class="mono">${formatEth(loan.principal)} ETH</td>
        <td class="mono">${formatEth(loan.interest)} ETH</td>
        <td class="mono">${formatEth(loan.amountRepaid)} ETH</td>
        <td class="mono">${formatEth(loan.collateralLocked)} ETH</td>
        <td>
          ${isRepaid
            ? '<span class="chip chip-green">Repaid</span>'
            : '<span class="chip chip-red">Defaulted</span>'}
        </td>
        <td style="font-size:12px;color:var(--muted)">${
          isRepaid
            ? `Full repayment`
            : `Bad debt: ${formatEth(badDebt)} ETH. ${seizedNote}`
        }</td>
      `;
      tbody.appendChild(tr);
    }
  } catch (e) { toast(parseError(e), "error"); }
}

// ── Borrower Profile ──────────────────────────────────────────

function setupProfileLookup() {
  document.getElementById("btn-lookup").addEventListener("click", async () => {
    const addrInput = document.getElementById("profile-addr").value.trim();
    if (!contract) { toast("Connect wallet first.", "error"); return; }
    if (!addrInput) return;
    try {
      const addr    = ethers.getAddress(addrInput);
      const [profile, member, block] = await Promise.all([
        contract.getBorrowerProfile(addr),
        contract.members(addr),
        provider.getBlock("latest"),
      ]);
      const chainNow = Number(block.timestamp);

      // Trust tier eligible?
      const noDefault = !profile[0];
      const repaid    = Number(profile[1]) >= 1;
      const tenure    = member.exists
        ? Math.floor((chainNow - Number(member.joinTimestamp)) / (30 * 86400)) >= 1
        : false;
      const trustEligible = noDefault && (repaid || tenure);

      document.getElementById("p-addr").textContent            = addr;
      document.getElementById("p-defaulted").innerHTML         = profile[0]
        ? '<span class="chip chip-red">Yes</span>'
        : '<span class="chip chip-green">No</span>';
      document.getElementById("p-repayments").textContent      = profile[1].toString();
      document.getElementById("p-total-defaulted").textContent = formatEth(profile[2]) + " ETH";
      document.getElementById("p-trust").innerHTML             = trustEligible
        ? '<span class="chip chip-green">Eligible</span>'
        : '<span class="chip chip-red">Not eligible</span>';

      document.getElementById("profile-result").classList.remove("hidden");
    } catch (e) {
      toast(parseError(e), "error");
    }
  });
}

// ── Treasurer Panel ───────────────────────────────────────────

async function renderTreasurer() {
  try {
    const [maxLoan, minRate, bountyRate, paused, pausedAt, block] = await Promise.all([
      contract.maxLoanSize(),
      contract.minInterestRate(),
      contract.keeperBountyRate(),
      contract.paused(),
      contract.pausedAt(),
      provider.getBlock("latest"),
    ]);
    const chainNow = Number(block.timestamp);

    const pauseEl = document.getElementById("pause-state");
    pauseEl.textContent = paused ? "PAUSED" : "Active";
    pauseEl.style.color = paused ? "var(--red)" : "var(--green)";

    const btnEmPause = document.getElementById("btn-emergency-pause");
    btnEmPause.disabled = paused;
    btnEmPause.onclick = async (e) => {
      await txAction(e.target, () => contract.emergencyPause());
    };

    // Emergency unpause failsafe — only usable after 30 days paused and zero voting weight.
    const btnEmUnpause = document.getElementById("btn-emergency-unpause");
    const unpauseHint  = document.getElementById("emergency-unpause-hint");
    if (paused) {
      btnEmUnpause.classList.remove("hidden");
      unpauseHint.classList.remove("hidden");
      const secsRemaining = Number(pausedAt) + 30 * 86400 - chainNow;
      if (secsRemaining > 0) {
        btnEmUnpause.disabled = true;
        unpauseHint.textContent = `Failsafe available in ${formatDuration(secsRemaining)} (30-day threshold not yet reached).`;
      } else {
        btnEmUnpause.disabled = false;
        unpauseHint.textContent = "30-day threshold reached. Failsafe is available if total member voting weight is zero.";
      }
      btnEmUnpause.onclick = async (e) => {
        await txAction(e.target, () => contract.emergencyUnpause());
      };
    } else {
      btnEmUnpause.classList.add("hidden");
      unpauseHint.classList.add("hidden");
    }

    // Current-value placeholders for the value input
    const placeholders = [
      formatEth(maxLoan) + " ETH (current)",
      Number(minRate) + " bps (current)",
      Number(bountyRate) + " bps (current, max 200)",
      "no value needed",
      "0x… new treasurer address",
    ];
    const paramSelect = document.getElementById("tr-param-type");
    const paramInput  = document.getElementById("tr-param-value");

    // .oninput assignment prevents listener stacking on repeated tab visits
    paramSelect.oninput = () => {
      paramInput.placeholder = placeholders[Number(paramSelect.value)];
      paramInput.disabled    = Number(paramSelect.value) === 3; // Unpause needs no value
    };
    paramInput.placeholder = placeholders[Number(paramSelect.value)];
    paramInput.disabled    = Number(paramSelect.value) === 3;

    document.getElementById("btn-propose-change").onclick = async (e) => {
      const paramType = Number(paramSelect.value);
      const raw = paramInput.value.trim();
      if (paramType !== 3 && !raw) return;
      let newValue;
      try {
        if (paramType === 0) {
          newValue = ethers.parseEther(raw);
        } else if (paramType === 4) {
          newValue = BigInt(ethers.getAddress(raw));
        } else if (paramType === 3) {
          newValue = 0n;
        } else {
          newValue = BigInt(raw);
        }
      } catch {
        toast("Invalid value.", "error");
        return;
      }
      await txAction(e.target, () => contract.proposeChange(paramType, newValue));
    };
  } catch (e) { toast(parseError(e), "error"); }
}

// ── Governance ────────────────────────────────────────────────

async function renderGovernance() {
  const list = document.getElementById("governance-list");
  try {
    const [govCount, memberData, block, treasurerAddr] = await Promise.all([
      contract.govCounter(),
      contract.members(signerAddress),
      provider.getBlock("latest"),
      contract.treasurer(),
    ]);
    const chainNow    = Number(block.timestamp);
    const total       = Number(govCount);
    const isTreasurer = treasurerAddr.toLowerCase() === signerAddress.toLowerCase();

    const active = [];
    for (let i = 1; i <= total; i++) {
      const p = await contract.getGovProposal(i);
      if (Number(p.status) === 0 || Number(p.status) === 1) active.push(p);
    }

    if (active.length === 0) {
      list.innerHTML = '<p class="empty-msg">No active governance proposals.</p>';
      return;
    }

    list.innerHTML = "";
    for (const p of active) {
      list.appendChild(await buildGovCard(p, memberData, chainNow, isTreasurer));
    }
  } catch (e) { toast(parseError(e), "error"); }
}

function formatGovValue(paramType, rawValue) {
  const t = Number(paramType);
  if (t === 0) return formatEth(rawValue) + " ETH";
  if (t === 1 || t === 2) return Number(rawValue) + " bps (" + (Number(rawValue) / 100).toFixed(2) + "%)";
  if (t === 3) return "—";
  try {
    const hex = rawValue.toString(16).padStart(40, "0");
    return truncateAddr(ethers.getAddress("0x" + hex));
  } catch { return rawValue.toString(); }
}

async function buildGovCard(p, memberData, chainNow, isTreasurer) {
  const card = document.createElement("div");
  card.className = "loan-card";

  const isPending  = Number(p.status) === 0;
  const isApproved = Number(p.status) === 1;
  const deadline   = Number(p.voteDeadline);
  const remaining  = deadline - chainNow;
  const timeLeft   = remaining > 0 ? formatDuration(remaining) : "Voting closed";
  const [liveTotalWeight, liveVotesFor] = await contract.getLiveGovVoteTotals(p.id);
  const pct = liveTotalWeight > 0n
    ? Math.min(100, Math.round(Number(liveVotesFor * 10000n / liveTotalWeight) / 100))
    : 0;
  const timelockLeft = isApproved ? Number(p.timelockExpiry) - chainNow : 0;

  const myVoted  = await contract.hasVotedOnGov(p.id, signerAddress);
  const myWeight = await contract.computeVotingWeight(signerAddress);
  const canVote  = memberData.exists && isPending && remaining > 0 && !myVoted && myWeight > 0n;

  const statusChip = isPending
    ? '<span class="chip chip-amber" style="margin-left:8px">Pending Vote</span>'
    : '<span class="chip chip-green" style="margin-left:8px">Approved — In Timelock</span>';

  card.innerHTML = `
    <div class="loan-card-header">
      <div>
        <strong>Proposal #${p.id}</strong>
        ${statusChip}
      </div>
      <span style="font-size:12px;color:var(--muted)">${GOV_PARAM_LABEL[Number(p.paramType)]}</span>
    </div>
    <div class="loan-card-meta">
      <div class="meta-item">Parameter<strong>${GOV_PARAM_LABEL[Number(p.paramType)]}</strong></div>
      <div class="meta-item">Proposed Value<strong>${formatGovValue(p.paramType, p.newValue)}</strong></div>
      <div class="meta-item">${isPending ? "Vote Window" : "Timelock"}<strong>${
        isPending ? timeLeft
          : timelockLeft > 0 ? formatDuration(timelockLeft) + " remaining"
          : "Ready to execute"
      }</strong></div>
    </div>
    ${isPending ? `
    <div style="margin-bottom:10px">
      <div style="display:flex;justify-content:space-between;font-size:12px;color:var(--muted);margin-bottom:4px">
        <span>Votes For</span><span>${pct}% of weight</span>
      </div>
      <div class="progress-bar"><div class="progress-bar-fill" style="width:${pct}%"></div></div>
    </div>` : ""}
    <div class="loan-card-actions" id="gov-actions-${p.id}"></div>
  `;

  const actions = card.querySelector(`#gov-actions-${p.id}`);

  if (canVote) {
    const btnFor     = btn("Vote Yes", "btn-sm btn-green");
    const btnAgainst = btn("Vote No",  "btn-sm btn-red");
    btnFor.onclick     = async () => txAction(btnFor,     () => contract.voteOnProposal(p.id, true));
    btnAgainst.onclick = async () => txAction(btnAgainst, () => contract.voteOnProposal(p.id, false));
    actions.append(btnFor, btnAgainst);
  } else if (myVoted && isPending) {
    actions.innerHTML = '<span style="color:var(--muted);font-size:12px">Voted</span>';
  }

  if (isPending && remaining <= 0) {
    const btnFinalize = btn("Finalize", "btn-sm btn-ghost");
    btnFinalize.onclick = async () => txAction(btnFinalize, () => contract.finalizeProposal(p.id));
    actions.appendChild(btnFinalize);
  }

  if (isApproved && timelockLeft <= 0) {
    const btnExecute = btn("Execute", "btn-sm btn-green");
    btnExecute.onclick = async () => txAction(btnExecute, () => contract.executeProposal(p.id));
    actions.appendChild(btnExecute);
  } else if (isApproved && timelockLeft > 0) {
    const hint = document.createElement("span");
    hint.style.cssText = "color:var(--muted);font-size:12px";
    hint.textContent   = "Executable in " + formatDuration(timelockLeft);
    actions.appendChild(hint);
  }

  if (isTreasurer && isPending && remaining > 0) {
    const btnVeto = btn("Veto", "btn-sm btn-red");
    btnVeto.onclick = async () => txAction(btnVeto, () => contract.vetoProposal(p.id));
    actions.appendChild(btnVeto);
  }

  return card;
}

// ── Transaction helper ────────────────────────────────────────

// fn must RETURN the ContractTransactionResponse (not await it internally).
// Awaiting inside fn yields undefined, so tx.wait() would be unreachable.
async function txAction(btnEl, fn) {
  const original = btnEl.textContent;
  btnEl.disabled   = true;
  btnEl.textContent = "Pending…";
  try {
    const tx = await fn();
    // tx?.wait guard: view helpers called via txAction return without .wait
    if (tx?.wait) await tx.wait();
    toast("Transaction confirmed.", "success");
    await refreshCurrentTab();
  } catch (e) {
    toast(parseError(e), "error");
  } finally {
    btnEl.disabled    = false;
    btnEl.textContent = original;
  }
}

// ── Utilities ─────────────────────────────────────────────────

function formatEth(wei) {
  if (wei === undefined || wei === null) return "0";
  const e = ethers.formatEther(wei);
  return parseFloat(e).toFixed(4);
}

function truncateAddr(addr) {
  if (!addr) return "";
  return addr.slice(0, 6) + "…" + addr.slice(-4);
}

function formatDuration(secs) {
  const d = Math.floor(secs / 86400);
  const h = Math.floor((secs % 86400) / 3600);
  if (d > 0) return `${d}d ${h}h`;
  const m = Math.floor(secs / 60);
  return `${m}m`;
}

function parseError(e) {
  // ethers v6: e.reason is the clean decoded revert string
  // e.shortMessage strips action/data noise; e.message may have full context appended
  const raw = e?.reason ?? e?.shortMessage ?? e?.data?.message ?? e?.message ?? String(e);
  const m = raw
    .replace(/^execution reverted:\s*/i, "")
    .replace(/\s*\(action=["'].*$/s, "")   // strip trailing ethers context dump
    .trim();
  return m.length > 200 ? m.slice(0, 197) + "…" : m;
}

function btn(label, cls = "") {
  const b = document.createElement("button");
  b.textContent = label;
  b.className   = cls;
  return b;
}

let toastTimer;
function toast(msg, type = "") {
  const el = document.getElementById("toast");
  el.textContent = msg;
  el.className   = "toast " + type;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.add("hidden"), 5000);
}

// ── Init ──────────────────────────────────────────────────────

window.addEventListener("DOMContentLoaded", boot);
