# Transaction Walkthrough

A concrete end-to-end example of a loan moving through every state in the contract — request → vote → activation → default — with every ETH movement, share update, and on-chain state change tracked at each step.

This is meant as a hands-on companion to [README.md](README.md). The README explains *why* the system works the way it does; this document shows *what actually happens* in numbers.

---

## Setup

A fresh pool with three members. All balances in ETH.

| Account | Role | Initial wallet | Pool deposit | Shares (1:1 at first deposit) | Tenure |
|---|---|---|---|---|---|
| `acct0` | Treasurer + Member | 10,000 | 1,000 | 1,000 | 31 days |
| `acct1` | Member | 10,000 | 500 | 500 | 31 days |
| `acct2` | Member | 10,000 | 500 | 500 | 31 days |
| `acct3` | Outsider (becomes keeper later) | 10,000 | — | — | — |

After all three deposits:

| State | Value |
|---|---|
| `totalPoolETH` | 2,000 |
| `totalShares` | 2,000 |
| `members[acct0].shares` | 1,000 (50% of pool) |
| `members[acct1].shares` | 500  (25% of pool) |
| `members[acct2].shares` | 500  (25% of pool) |
| `acct0` member value | 1,000 |
| `acct1` member value | 500 |
| `acct2` member value | 500 |

> Tenure of 31 days is required for non-zero voting weight, since `log2(months+1)` is 0 for the first 30 days.

---

## Step 1 — `acct0` requests a 100 ETH loan

`acct0` wants to borrow 100 ETH for 30 days, offering 10.75% interest and 250 ETH of collateral.

```solidity
creditUnion.connect(acct0).requestLoan(
    100 ether,      // amount
    1075,           // 10.75% in bps
    30 * 86400,     // 30 days in seconds
    250 ether       // collateralOffered
);
```

### What the contract computes

**Tier classification** ([CreditUnion.sol:_determineTier](contracts/CreditUnion.sol)):

- Trust requires `amount ≤ 2% of pool` (= 40) AND duration ≤ 30 days. 100 > 40 → fails.
- Standard requires `amount ≤ 10% of pool` (= 200) AND duration ≤ 90 days. 100 ≤ 200 AND 30 ≤ 90 → **Standard tier**.

**Threshold rate**:

```
loanPoolBps     = 100·10000 / 2000  = 500 bps   (5% of pool)
sizePremium     = 500 / 10          = 50 bps    (0.50%)
durPremium      = 30·2000 / 365     = 164 bps   (1.64%)
threshRate      = 800 + 50 + 164    = 1014 bps  (10.14%)
```

Offered 1075 bps (10.75%) > 1014 bps → **passes**.

**Threshold collateral** (Standard tier base = 4000 bps = 40%):

```
stakePoolBps      = 1000·10000/2000   = 5000 bps  (acct0 owns 50%)
stakeDiscount     = 5000 / 4          = 1250 bps   (cap = 4000/4 = 1000 → CAPPED to 1000)
sizePremiumCollat = 500 / 2           = 250 bps    (cap 1500, not hit)
effectiveBps      = 4000 + 250 - 1000 = 3250 bps
threshCollateral  = 100·3250/10000    = 32.5 ETH
```

Offered 250 ETH ≫ 32.5 → **passes**.

**Approval majority** (30-day loan → base 50%):

- Rate boost? Needs offered ≥ 130% × 1014 = 1318 bps. Offered 1075 < 1318 → **no rate boost**.
- Collateral boost? Needs offered ≥ 130% × 32.5 = 42.25. Offered 250 ≫ 42.25 → **collateral boost applies (−10%)**.
- Final required: 50% − 10% = **40%**.

**Voting denominator**:

```
totalVotingWeight  = sum over all members of computeVotingWeight()
                   ≈ sqrt(1000e18)·1 + sqrt(500e18)·1 + sqrt(500e18)·1
                   ≈ 3.16e10 + 2.24e10 + 2.24e10
                   ≈ 7.64e10
```

Then the **borrower's weight is subtracted** ([CreditUnion.sol requestLoan](contracts/CreditUnion.sol)):

```
borrowerWeight  ≈ 3.16e10
snapshot        ≈ 7.64e10 − 3.16e10 = 4.48e10
```

The 40% threshold is computed against this 4.48e10 — not the full 7.64e10. acct1 and acct2 between them control 100% of the eligible voting weight.

### State changes

- `loanCounter` → 1
- `loanRequests[1]` populated with all the above
- `loanRequests[1].status` = `Pending`
- `voteDeadline` = `block.timestamp + 3 days`
- No ETH moves.

---

## Step 2 — Voting

acct1 votes **YES**, acct2 abstains.

```solidity
creditUnion.connect(acct1).vote(1, true);
// acct2 never calls vote()
```

- `loanVoterList[1]` = `[acct1]`
- `loanVoteSupport[1][acct1]` = `true`
- No ETH moves.

### Live tally during voting (acct1 votes yes, acct2 silent)

```
currentTotal  (excl. borrower) ≈ 4.48e10
votesFor                       ≈ 2.24e10   (acct1's weight)
                               = 50% of eligible
required                       = 40%
```

Currently passing. Abstentions from acct2 act against (they're in the denominator but not in the numerator) but acct1 alone gets it across the 40% line.

---

## Step 3 — Time passes; `finalizeLoan` called

After the 3-day window elapses, **anyone** can call:

```solidity
creditUnion.finalizeLoan(1);
```

The contract recomputes weights at *current* tenure/deposit (not the snapshot taken at request), subtracts the borrower again, then compares votesFor to the threshold.

Assuming nothing changed:

```
dynVotesFor / currentTotal  ≈ 2.24e10 / 4.48e10 ≈ 50%
50% > 40% required  →  Approved
```

- `loanRequests[1].status` = `Approved`
- `loanRequests[1].approvalTimestamp` = `block.timestamp`
- emits `LoanApproved(1, acct0, 100 ether)`
- No ETH moves.

---

## Step 4 — `activateLoan` (acct0 locks collateral, receives principal)

```solidity
creditUnion.connect(acct0).activateLoan(1, { value: 250 ether });
```

### Re-checks at activation

- Pool cap (20%): 100 ≤ 0.2 × 2000 = 400 → passes
- Reserve check: pool after disbursement (1900) ≥ 10% of totalDepositsEver (200) → passes
- Tier re-evaluated against current pool — still Standard
- Collateral required = max(original 250, current threshold ≈ 32.5) = 250
- `msg.value == 250` → matches → passes
- Interest = `100 × 1075 × 2,592,000 / (31,536,000 × 10,000)` ≈ **0.884 ETH**

### State after activateLoan

| State | Before | After | Delta |
|---|---|---|---|
| `totalPoolETH` | 2,000 | 1,900 | −100 |
| `collateralHeld[1]` | 0 | 250 | +250 |
| `acct0` wallet | 10,000 − 1,000 = 9,000 | 9,000 − 250 + 100 = **8,850** | −150 |
| `acct0` shares | 1,000 | 1,000 | 0 |
| `totalShares` | 2,000 | 2,000 | 0 |
| Contract ETH balance | 2,000 | 1,900 + 250 = **2,150** | +150 |

### Member values *drop* proportionally (loan went out of the pool)

| Account | Pre-loan value | Post-activation value | Drop |
|---|---|---|---|
| acct0 (50%) | 1,000 | 1,000 × 1,900 / 2,000 = **950** | −50 |
| acct1 (25%) | 500 | 500 × 1,900 / 2,000 = **475** | −25 |
| acct2 (25%) | 500 | 500 × 1,900 / 2,000 = **475** | −25 |

acct0's *total* worth: 8,850 (wallet) + 950 (shares) = **9,800**. Compared to pre-loan 10,000 wallet, they're down 200: 100 of that is "they're holding the loan principal in their wallet so it's still theirs", and the 100 actual loss is split as 50 inside their shares dropping + 150 in over-collateralization. Recombining: −150 wallet net + (+100 of which is their share's worth of the loan they took) = effectively −250 they paid for collateral, +100 loan in hand. Their *liquid* loss is 150 ETH (the over-collateral); the 100 loan will be repaid back to the pool later.

---

## Step 5 — Time passes past deadline; loan goes overdue

acct0 doesn't call `repay`. After `block.timestamp > repaymentDeadline` (30 days after activation), anyone can trigger default.

```solidity
creditUnion.connect(acct3).triggerDefault(1);
```

### What happens, in order

1. **Compute components**:
   ```
   grossBadDebt = totalDue − amountRepaid = 100.884 − 0 = 100.884
   seized       = 250
   lossCover    = min(250, 100.884) = 100.884
   excess       = 250 − 100.884     = 149.116
   ```

2. **Bad-debt cover added to pool** (all members participate proportionally — this is just undoing the loan loss):
   ```
   totalPoolETH: 1,900 → 1,900 + 100.884 = 2,000.884
   ```

3. **Excess flows only to non-defaulters via proportional share burn on acct0**:
   ```
   defShares  = 1,000
   nonDef     = 2,000 − 1,000 = 1,000
   P          = 2,000.884   (pool after lossCover)
   E          = 149.116
   numerator   = 1,000 × 2,000.884 × 1,000           = 2.000884e9
   denominator = 2,000.884 × 1,000 + 2,000 × 149.116 = 2,299.116e3
   newDefShares = numerator / denominator             ≈ 870.29
   sharesBurned = 1,000 − 870.29                      ≈ 129.71
   ```

   Then add excess to the pool:
   ```
   totalPoolETH: 2,000.884 → 2,150  (back to the contract's actual ETH balance, minus bounty)
   totalShares:  2,000     → 1,870.29
   acct0 shares: 1,000     → 870.29
   ```

4. **Keeper bounty** (smaller of 1% of bad debt or 2% of principal):
   ```
   keeperBountyRate = 100 bps (default 1%)
   bounty           = min(100.884 × 0.01, 100 × 0.02) = min(1.009, 2) = 1.009 ETH
   totalPoolETH     → 2,150 − 1.009 = 2,148.99
   ```

5. **Status flags and transfer**:
   - `loan.defaultTriggered` = `true`
   - `loanRequests[1].status` = `Defaulted`
   - `hasDefaulted[acct0]` = `true`
   - `totalDefaulted[acct0]` += 100.884
   - 1.009 ETH transferred to `acct3` (keeper)

### State after default

| State | Before default | After default |
|---|---|---|
| `totalPoolETH` | 1,900 | **2,148.99** (+248.99) |
| `totalShares` | 2,000 | **1,870.29** |
| `acct0` shares | 1,000 | **870.29** (−129.71 burned) |
| `acct1` shares | 500 | 500 |
| `acct2` shares | 500 | 500 |
| `acct0` wallet | 8,850 | 8,850 (untouched) |
| `acct3` wallet | 10,000 | **10,001.01** (keeper bounty) |
| `collateralHeld[1]` | 250 | 0 |

### Member values after default — the punchline

| Account | Shares | Total share fraction | Member value (= shares × 2148.99 / 1870.29) | Change vs pre-loan |
|---|---|---|---|---|
| acct0 (defaulter) | 870.29 | 46.5% | **≈ 1,000.44** | **+0.44** (their 50% share of the recovered interest) |
| acct1 | 500 | 26.7% | **≈ 574.72** | **+74.72** |
| acct2 | 500 | 26.7% | **≈ 574.72** | **+74.72** |

**The defaulter's pool value is held flat through the *excess* addition** — that's what the share burn is calibrated for. They end up at the post-lossCover value (≈ pre-loan + their share of the recovered interest), not at zero change from pre-loan. That tiny uplift is structurally identical to what would happen on a normal repayment: when a borrower-member repays interest, that interest is distributed to all members through share appreciation, and the borrower captures their own ownership-fraction back. The default flow mirrors this — the interest portion of `lossCover` is the same dividend whether it came from a wallet repayment or from collateral.

**The non-defaulters captured the entire excess plus their share of the interest** — ~74.72 each ≈ 149.44 total = 149.116 excess + 0.328 (their combined 50% of the 0.884 interest, since the other half went to the defaulter's shares). (Tiny rounding from integer division.)

### acct0's total economic outcome

| Bucket | Change |
|---|---|
| Wallet: paid 250 collateral | −250 |
| Wallet: received 100 loan principal | +100 |
| Pool share value | 1,000 → ≈ 1,000.44 (their share of the interest dividend) |
| **Total loss to defaulter** | **≈ −149.56 ETH** |

That ≈ 149.56 is essentially the 150 over-collateralization premium they posted as a forfeiture bond, minus the small interest dividend they captured on their remaining shares (same dividend any borrower-member captures from interest they themselves pay). The bulk of the premium went to honest members — not back to themselves.

### acct1 and acct2's outcome

Each was −25 during the active loan, then +74.72 at default. Net **≈ +49.72** each — they took on real risk (a member was about to walk) and got paid the over-collateralization premium plus their share of the interest as compensation.

---

## Step 6 — Loan history view

The frontend (and any caller of `getLoanRequest(1)` + `getActiveLoan(1)`) sees:

- `loanRequests[1].status` = `Defaulted`
- `loan.principal` = 100
- `loan.interest` = 0.884
- `loan.amountRepaid` = 0
- `loan.collateralLocked` = 250
- `hasDefaulted[acct0]` = `true`

`acct0` is now permanently excluded from the Trust tier and flagged for borrower-profile lookups.

---

## What if collateral had been *under* the bad debt?

Suppose acct0 had only posted 80 ETH collateral on a loan that ended up owing 100.884:

```
seized    = 80
lossCover = 80          (the whole seizure goes to covering bad debt)
excess    = 0           (no excess, no share burn)
remainingBadDebt = 100.884 − 80 = 20.884
```

- No share burn — acct0 keeps all their shares.
- `totalPoolETH` only gains 80, but the pool was 100 lighter from the loan disbursement.
- Net: `totalPoolETH` ends 20.884 below pre-loan, plus the bounty.
- All members' share values **drop** — this is the socialized loss case described in the README.
- acct0 still loses their 80 ETH collateral.

The share burn mechanism is *only* triggered when collateral genuinely over-secured the loan. Under-collateralized defaults distribute the pain to everyone, as before.

---

## Summary of the invariants this design enforces

1. **The defaulter never benefits from the *excess* portion of their forfeited collateral** — the share burn is exactly calibrated so their pool value is held flat across the excess addition. They do still receive their pro-rata share of the bad-debt cover (which includes the unpaid principal *and* unpaid interest) — this is consistent with how a normal repayment behaves, where the borrower-member captures their own ownership-fraction of any interest they pay back via share appreciation.
2. **The bad-debt cover is shared by all** — this is not a punishment, it's just undoing the loan loss (principal portion) plus crediting the interest that the borrower nominally owed. All members (including the defaulter, on their remaining shares) participate.
3. **The punitive premium flows to honest members** — non-defaulters' shares appreciate by the full excess amount, distributed pro-rata to their pre-default ownership of the non-defaulter slice.
4. **ETH is conserved** — every wei moves from one place to another (defaulter wallet → pool, pool → keeper, etc.). The contract never mints or destroys ETH; only redistributes it.
