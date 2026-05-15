# On-Chain Credit Union

A production-grade decentralized credit union implemented as a single Solidity smart contract. Members deposit ETH into a shared pool, vote on loan requests using a stake-and-tenure-weighted voting formula, earn yield from interest repayments, and absorb any uncovered losses from defaults proportionally through share accounting. When a default is collateralized, the punitive excess (seized collateral above bad debt) is redirected exclusively to non-defaulting members via a targeted share burn on the defaulter — defaulters can never benefit from their own seized collateral. No external oracles, no governance tokens, just pure ETH.

---

## Architecture Overview

### Contract Roles

| Role | Capabilities |
|------|-------------|
| **Member** | Deposit ETH, earn yield, vote on loan requests, borrow |
| **Borrower** | A member with an active loan — must repay or face default |
| **Treasurer** | Single address set at deployment; can emergency-pause the contract and propose parameter changes. All proposals require a member vote and a 2-day timelock before taking effect. The treasurer role itself can be transferred via a governance vote. |
| **Keeper** | Anyone who calls `triggerDefault()` on an overdue loan; earns a bounty (≤2% of loan) |

### Share Accounting

Pool shares track each member's proportional ownership of `totalPoolETH`:

- **First depositor**: shares = depositAmount (1:1 wei)
- **Subsequent deposits**: `shares = depositAmount × totalShares / totalPoolETH`
- **Interest repaid** → `totalPoolETH` increases → existing shares appreciate
- **Default — bad-debt cover** → seized collateral up to the unpaid amount is added to `totalPoolETH`; every member's shares (including the defaulter's) appreciate, since this part is just restoring the loss
- **Default — punitive excess** → any seized collateral above the bad debt is added to `totalPoolETH`, but a proportional slice of the defaulter's shares is burned so their per-share value stays flat through this addition. The excess flows entirely to non-defaulting members.
- **Default — uncovered loss** → if collateral was insufficient, the shortfall stays as a permanent dent in `totalPoolETH` → all members' shares depreciate proportionally
- **Default — keeper bounty** → small ETH transfer out of `totalPoolETH` → minor share depreciation across remaining members

A member's current ETH value = `memberShares × totalPoolETH / totalShares`.

### Voting Weight Formula

```
weight = sqrt(depositAmount_wei) × floor_log2(months_as_member + 1)
```

Both components use integer approximations:

- **sqrt**: Babylonian method applied directly to the wei value. At the minimum deposit of 0.01 ETH (= 1×10¹⁶ wei), `sqrt = 10⁸` — always non-zero.
- **log2**: O(1) unrolled MSB bit-length lookup; no loops.
- New members (<30 days) have `months=0`, so `log2(1)=0` → weight zero. This prevents flash-deposit governance attacks.

Approval thresholds are dynamic and depend on loan duration: ≤30 days requires 50%, 31–90 days requires 55%, >90 days requires 60% of the **eligible** voting weight. Offering ≥130% of the threshold rate or threshold collateral each reduces the required majority by 10% (combined floor 35%). Voting weights are **recomputed at finalization** from each voter's current deposit and tenure — not snapshotted at cast time — so a member who tops up or withdraws between casting and finalization sees their vote weight change accordingly. The borrower is **excluded from the denominator** (they can't vote on their own loan, so counting their weight would be a forced "no" against themselves). Abstentions by *other* members still count against — the denominator is every eligible voter, not just those who cast.

### Loan Tiers & Collateral

| Tier | Condition | Base Collateral |
|------|-----------|-----------------|
| **Trust** | amount ≤ 2% pool AND duration ≤ 30 days | 15% of principal |
| **Standard** | amount ≤ 10% pool AND duration ≤ 90 days | 40% of principal |
| **Secured** | everything else | 75% of principal |

Trust tier additionally requires no prior default AND (≥1 prior successful repayment OR membership ≥30 days).

Collateral is locked by the borrower at `activateLoan` time and returned in full on successful repayment. On default it is seized into the pool: the portion up to the unpaid principal+interest covers the bad debt, and any **excess** (over-collateralization above what was owed) is redirected exclusively to non-defaulting members through a targeted share burn on the defaulter — so the defaulter cannot benefit from their own forfeited collateral via their pool stake. These are *base* rates — the effective minimum collateral for any specific request is then adjusted dynamically by loan size and borrower stake (see formulas below).

### Risk-Adjusted Rates & Collateral

**Why higher baselines?** Because this is an anonymous, pseudonymous environment anyone can take funds and vanish. Traditional credit unions rely on social trust and legal enforcement; this contract has neither. Collateral baselines and interest rates must compensate for the absence of those mechanisms.

**Dynamic threshold rate formula:**

```
thresholdRate = minInterestRate + sizeRiskPremium + durationRiskPremium
```

- `sizeRiskPremium = (loanAmount / poolSize) / 10` — borrowing a larger fraction of the pool adds proportionally more rate risk, reflecting the pool's concentration exposure.
- `durationRiskPremium = (duration / 1 year) × 20%` — longer loans give more time for a borrower to disappear, capped at 20% additional rate.

**Dynamic threshold collateral formula:** Starts from the tier base, then adjusted:

- **Loan-size premium:** borrowing a larger fraction of the pool increases required collateral (up to +15% of principal).
- **Member stake discount:** owning a larger fraction of the pool reduces your threshold (skin-in-the-game). Maximum discount is 25% of the base, keeping the floor meaningful.

**Borrower trade-off:** Both threshold rate and collateral are minimums. Offering at least 130% of the threshold on either dimension earns an **approval boost** — each qualifying dimension reduces the required approval majority by 10% (floor 35%).

**Duration-based approval difficulty:**

| Duration | Required Majority | Notes |
|----------|------------------|-------|
| ≤ 30 days | 50% of total weight | Short-term, lower risk |
| 31–90 days | 55% of total weight | Medium-term |
| > 90 days | 60% of total weight | Long-term, higher scrutiny |

Each boost dimension (generous rate OR generous collateral) subtracts 10% from the required threshold, with a floor of 35%. Example: a 90-day loan at 130% of threshold rate qualifies for 45% threshold, floored to 35%.

### Loan Lifecycle

```
requestLoan() → [3-day vote window] → finalizeLoan()
→ Approved → activateLoan() [borrower locks collateral, ≤7 days]
→ Active → repay() [partial ok] → Repaid (collateral returned)
                              → triggerDefault() → Defaulted (collateral seized)
```

**Tier re-evaluation at activation:** when `activateLoan` is called, the tier is re-determined against the *current* pool size. If the pool has shrunk since `requestLoan`, the loan may escalate to a higher-risk tier requiring more collateral. Tier only escalates — it never de-escalates to a lower tier.

### One Active Loan Per Member

A member can hold **at most one active loan at a time**. This is enforced by `activeLoanIdOf[member]` — a per-address pointer that's set to the loan ID at `activateLoan`, cleared to `0` on full repayment or default, and checked at every borrowing-relevant entry point.

| Action | What's blocked while you have an active loan |
|---|---|
| `requestLoan` | Reverts with `"Active loan outstanding"` — you can't even submit a second request |
| `withdraw` | Reverts — you can't pull your pool stake out while you owe the pool |
| `repay` | Allowed (this is how you close out) |

Sequential borrowing is fine — repay your current loan and you can immediately request a new one with no cooldown. But **stacking** is impossible: no portfolio borrowing, no concurrent loans across tiers, no single member holding multiple outstanding obligations. Each member has one open exposure to the pool at a time, and the risk model (tier classification, threshold collateral, voting weight) assumes that single-loan view throughout.

A pending request that hasn't been activated yet does *not* block a new request — the gate is on `Active` status specifically. But once you activate, the lock is in place until the loan resolves.

### Reserve Requirement

The pool must always hold ≥10% of `totalDepositsEver` after any voluntary outflow (withdrawal or loan disbursement). Forced losses (default bounty, socialized bad debt) bypass this check.

**Long-term implication:** `totalDepositsEver` is monotonically increasing — it is never decremented, not even when losses shrink the pool. After enough defaults the reserve floor (10% of cumulative-ever deposits) can exceed the current `totalPoolETH`, at which point withdrawals and new loan disbursements are blocked until interest income rebuilds the pool back above the floor. This is intentional — it forces a healthy pool to recover before more capital can leave — but pool operators should monitor `totalPoolETH` vs `totalDepositsEver × 10%` and add deposits or wait for repayments if outflows start reverting.

---

## Prerequisites

- [Docker Desktop](https://www.docker.com/products/docker-desktop/)
- Git

No MetaMask or browser wallet required. The frontend connects directly to the Hardhat node using a built-in account selector.

> **Note on toolchain versions:** the project pins `hardhat@^2.26.0` to match `@nomicfoundation/hardhat-toolbox@^5.0.0`'s peer range. Hardhat 3 is a major rewrite with a different plugin model and is not compatible with this config.

---

## Quickstart

### 1. Build the image and start the Hardhat node

```bash
git clone https://github.com/shettysiddhanth/FITE2010_Credit_Union.git
cd FITE2010_Credit_Union
docker compose up -d
```

This builds the image (installing dependencies with `npm ci` using the committed `package-lock.json`) and starts a single long-running container whose default command is `npx hardhat node --hostname 0.0.0.0`. The chain is now reachable on `localhost:8545` with 20 funded test accounts (10 000 ETH each).

To stream chain logs:

```bash
docker compose logs -f hardhat
```

If you change `package.json`, rebuild with `docker compose build hardhat`.

### 2. Deploy the contract

Open a shell **inside the running container** with `exec` (not `run` — that would spawn a second container and collide on ports):

```bash
docker compose exec hardhat bash
```

Then **inside the container** run:

```bash
npx hardhat run scripts/deploy.js --network localhost
```

The deploy script:
1. Deploys `CreditUnion.sol`
2. Writes `frontend/contractAddress.json`
3. Copies the ABI to `frontend/contractABI.json`

### 3. Start the frontend server

Stay in the same `exec` shell (or open another with `docker compose exec hardhat bash`), then run **inside the container**:

```bash
npm run serve
```

Open [http://localhost:3000](http://localhost:3000)

### 4. Select an account

The header shows an **Account** dropdown pre-populated with all 20 Hardhat test accounts. Pick any account — the frontend connects immediately via `JsonRpcProvider` with no wallet extension needed.

### Stopping and resetting

```bash
docker compose down                    # stop the container (chain state is lost — Hardhat node is in-memory)
docker compose down --remove-orphans   # also clean up any leftover containers from older workflows
```

To start over with a fresh chain, run `docker compose up -d` again — then **re-run Step 2 (Deploy the contract)**. The chain is in-memory and is wiped on every restart, but `frontend/contractAddress.json` still points at the previous deployment, so the frontend will fail silently on every contract call until you redeploy.

---

## Using the Frontend

### Tabs

| Tab | Purpose |
|-----|---------|
| **Pool Overview** | Pool stats, join/deposit, withdraw, your share value |
| **Loan Requests** | Submit requests, vote, finalize, activate approved loans |
| **Active Loans** | Repay or trigger default on overdue loans |
| **Governance** | Vote on and execute treasurer-proposed parameter changes |
| **History** | Completed loans (repaid and defaulted) |
| **Profile** | Look up any address's borrower reputation |
| **Treasurer** | Emergency pause + propose parameter changes (treasurer only) |
| **Guide** | Full in-app documentation for every feature |

### Dev Tools (on the Pool Overview tab)

A **Dev Tools** panel lets you advance the local chain clock without leaving the browser:

- **Advance days** — enter a number and click **Advance Time**
- The current block timestamp is displayed and updates after each advance

> **Why this matters:** New members have zero voting weight for the first 30 days (`log2(1) = 0`). On a fresh Hardhat node you must advance ≥31 days before any loan request can receive votes. The Dev Tools panel makes this one click.

### Typical walkthrough

1. Select account **#0** — this is the Treasurer
2. **Pool Overview → Join** with 1 ETH (or more) as account #0
3. Select account **#1**, join with 1 ETH
4. Advance chain time **31 days** using Dev Tools
5. **Loan Requests → Request Loan** (e.g. 0.1 ETH, 5% rate, 30 days)
6. Switch between accounts and **Vote Yes/No**
7. After the 3-day vote window (advance time again if needed), click **Finalize**
8. Borrower clicks **Activate Loan** and locks any required collateral
9. Repay from the **Active Loans** tab; verify share value increases on Pool Overview

---

## Running Tests

```bash
npx hardhat test
```

Output: **77 tests, all passing**. Test coverage includes:

- Deployment & configuration
- Membership (join, addDeposit, withdraw)
- Voting weight math
- Loan tier classification (Trust / Standard / Secured)
- Trust tier eligibility enforcement
- Full loan lifecycle (request → vote → finalize → activate → repay)
- Partial repayments
- Default triggering, collateral seizure, and bounty enforcement
- Tier escalation at activation when pool shrinks
- Share appreciation from interest
- Pause mechanics and governance-based unpause
- Emergency unpause deadlock failsafe
- Treasurer control functions
- Member cap enforcement
- Edge cases and revert conditions

---

## Contract Function Reference

### Member Management

| Function | Description |
|----------|-------------|
| `join()` | Join the union with initial ETH deposit (min 0.01 ETH) |
| `addDeposit()` | Add more ETH to existing membership |
| `withdraw(shareAmount)` | Redeem shares for ETH; blocked while loan is active |
| `getMemberValue(address)` | Current ETH value of a member's shares |

### Loan Lifecycle

| Function | Description |
|----------|-------------|
| `requestLoan(amount, interestRate, duration, collateralOffered)` | Submit a loan request with a collateral commitment; tier and min thresholds auto-determined |
| `vote(requestId, support)` | Cast a weighted vote on a pending loan request |
| `finalizeLoan(requestId)` | Finalize after 3-day voting window; sets Approved or Rejected |
| `activateLoan(requestId)` | Borrower locks collateral and receives principal (≤7 days after approval) |
| `repay(loanId)` | Repay part or all of an active loan (partial repayments accepted) |
| `triggerDefault(loanId)` | Trigger default on an overdue loan; caller earns keeper bounty |

### Treasurer Controls

| Function | Description |
|----------|-------------|
| `emergencyPause()` | Immediately pause the contract (treasurer only); unpausing requires a governance vote |
| `emergencyUnpause()` | Failsafe unilateral unpause: only callable after ≥30 days paused AND total voting weight = 0 (true governance deadlock) |
| `proposeChange(paramType, newValue)` | Propose a parameter change; enters the 3-day member vote queue |

### Governance

| Function | Description |
|----------|-------------|
| `voteOnProposal(proposalId, support)` | Cast a weighted vote on a governance proposal; callable even when paused |
| `finalizeProposal(proposalId)` | Finalize the vote after 3 days; approved proposals enter a 2-day timelock |
| `executeProposal(proposalId)` | Execute an approved proposal after the timelock expires; callable by anyone |
| `vetoProposal(proposalId)` | Treasurer withdraws a pending proposal before voting closes |
| `getGovProposal(id)` | Returns the full `GovernanceProposal` struct |

### View Helpers

| Function | Returns |
|----------|---------|
| `getPool()` | `(totalPoolETH, totalShares, memberCount, loanCount)` |
| `getLoanRequest(id)` | Full `LoanRequest` struct |
| `getActiveLoan(id)` | Full `ActiveLoan` struct |
| `computeVotingWeight(address)` | Member's current voting weight |
| `getTotalVotingWeight()` | Sum of voting weights across all current members (frontends divide by this to render % weight) |
| `determineTier(amount, duration)` | `LoanTier` enum for given params |
| `computeThresholds(borrower, amount, duration)` | `(thresholdRate, thresholdCollateral)` — dynamic min rate and collateral for the loan |
| `getLiveVoteTotals(requestId)` | `(currentTotalWeight, currentVotesFor, currentVotesAgainst)` using each voter's live weight |
| `getLiveGovVoteTotals(proposalId)` | Same as above for governance proposals |
| `getBorrowerProfile(address)` | `(hasDefaulted, successfulRepayments, totalDefaulted)` |

---

## Known Limitations & Future Improvements

- **Voting weight snapshot is O(N)** over members. Bounded by `MAX_MEMBERS = 500` — `join()` reverts beyond this cap. Raise the constant for larger pools, noting the gas impact on `requestLoan` and governance proposals.
- **30-day month approximation** in voting weight — a member who joined 29 days ago has zero weight.
- **Treasurer is still a single EOA at deployment** — all parameter changes now require a member vote and a 2-day timelock, but the key itself could be a single address. Deploying with a Gnosis Safe multi-sig as the treasurer is strongly recommended for production use.
- **Interest is simple, not compound** — `principal × rate × duration / (365 days × BPS_DENOMINATOR)`.
- **No loan renegotiation** — a borrower cannot extend or restructure a loan once active.
- **No partial default resolution** — once `triggerDefault` is called the loan is fully closed; there's no workout mechanism.
- **Frontend polls on demand** (refresh on each tab switch / transaction). Event-based subscriptions would reduce RPC load.
- **No Sepolia / mainnet deployment script** — the deploy script targets localhost. Adding a `--network sepolia` path and constructor parameter for a separate treasurer address is straightforward.

---

## AI Use Declaration

AI was used to assist with bug fixing during development. All design decisions and project direction were made by the team.
