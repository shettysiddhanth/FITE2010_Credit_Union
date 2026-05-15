# Transaction Walkthrough

A concrete end-to-end example of a loan moving through every state in the contract — request → vote → activation → repayment or default — with every ETH movement, share update, and on-chain state change tracked at each step.

This document explores **three contrasting cases** from the same starting pool state:

- **Case 1 — Normal collateral, loan repaid** *(the happy path).* Borrower posts just above the minimum required collateral, uses the principal, repays on time. Demonstrates how interest yield flows to all members.
- **Case 2 — Normal collateral, loan defaulted** *(the strategic-default problem).* Same loan as Case 1, but the borrower walks away. Demonstrates the *socialized-loss* path **and shows that the contract's collateral threshold can be too thin to deter strategic default on its own.**
- **Case 3 — Over-collateralized loan, defaulted** *(the share-burn punitive path).* Borrower posts much more collateral than required, then walks away. Demonstrates the share-burn mechanic that redirects the punitive excess to non-defaulting members.

All three cases share the same setup so the numbers can be compared directly. This is meant as a hands-on companion to [README.md](README.md). The README explains *why* the system works the way it does; this document shows *what actually happens* in numbers.

---

## Shared Setup

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

> Tenure of 31 days is required for non-zero voting weight, since `log2(months+1)` is 0 for the first 30 days.

Approximate voting weights (∝ `sqrt(depositWei) × log2(months+1)`):

```
acct0 ≈ 3.16 × 10^10    (~41% of total)
acct1 ≈ 2.24 × 10^10    (~29% of total)
acct2 ≈ 2.24 × 10^10    (~29% of total)
total ≈ 7.64 × 10^10
```

The exact units don't matter — only the ratios. The cases below use weights as fractions of the total.

Each case is **independent** — they start from the same shared setup and proceed down different paths. The numbers don't compound between cases.

---

# Case 1 — Normal Collateral → Repaid (happy path)

**Borrower:** acct1
**Story:** acct1 needs 100 ETH for 30 days to capture a short-term opportunity (e.g., a payment due before incoming funds settle). They want to borrow as cheaply as possible, so they offer **40 ETH collateral** — just above the contract's minimum of 36.25 ETH for their stake position. They don't qualify for the boost (would need ~47), but the loan is well-priced, and acct1 expects easy approval from acct0 and acct2 who know them.

## 1.1 — `acct1` requests the loan

```solidity
creditUnion.connect(acct1).requestLoan(
    100 ether,      // amount
    1075,           // 10.75% in bps
    30 * 86400,     // 30 days
    40 ether,       // collateralOffered (just above minimum)
    0,              // collateralType = ETH
    0,              // collateralEthValue (ETH collateral uses 0)
    "",             // nftId
    acct0           // proposedGuarantor; required because 40 < 100 principal
);

creditUnion.connect(acct0).approveGuarantee(1);
```

### Tier classification

- Trust requires `amount ≤ 2% of pool` (= 40) AND duration ≤ 30 days. 100 > 40 → fails.
- Standard requires `amount ≤ 10% of pool` (= 200) AND duration ≤ 90 days. 100 ≤ 200 AND 30 ≤ 90 → **Standard tier**.

### Threshold rate

```
loanPoolBps     = 100·10000 / 2000  = 500 bps   (5% of pool)
sizePremium     = 500 / 10          = 50 bps    (0.50%)
durPremium      = 30·2000 / 365     = 164 bps   (1.64%)
threshRate      = 800 + 50 + 164    = 1014 bps  (10.14%)
```

Offered 1075 bps (10.75%) > 1014 bps → **passes**.

### Threshold collateral (Standard base = 4000 bps = 40%)

```
stakePoolBps      = 500·10000/2000   = 2500 bps   (acct1 owns 25%)
stakeDiscount     = 2500 / 4         = 625 bps    (cap = 1000, not hit)
sizePremiumCollat = 500 / 2          = 250 bps
effectiveBps      = 4000 + 250 - 625 = 3625 bps
threshCollateral  = 100·3625/10000   = 36.25 ETH
```

acct1 offers 40 ETH > 36.25 → **passes** (thin margin).

### Approval majority

- Base for 30-day loan: **50%**.
- Rate boost? 130% × 1014 = 1318. Offered 1075 < 1318 → **no rate boost**.
- Collateral boost? 130% × 36.25 = 47.13. Offered 40 < 47.13 → **no collateral boost**.
- Final required majority: **50%** of eligible weight (full base, no discounts).

### Eligible voting weight (borrower excluded)

```
totalWeight    ≈ 7.64 × 10^10
borrowerWeight ≈ 2.24 × 10^10   (acct1)
eligibleWeight ≈ 5.40 × 10^10   (acct0 + acct2)
```

## 1.2 — Voting

acct0 votes **YES**, acct2 abstains.

```
votesFor   ≈ 3.16 × 10^10   (acct0's weight)
           = ~58.5% of eligible weight
required   = 50%
58.5% > 50% → on track to pass
```

## 1.3 — Finalize

After 3 days, anyone calls `finalizeLoan(1)`. Result: **Approved**.

## 1.4 — `activateLoan` — acct1 locks 40 ETH, receives 100 ETH

```solidity
creditUnion.connect(acct1).activateLoan(1, { value: 40 ether });
```

- Interest = `100 × 1075 × 30 / 365 / 10000` ≈ **0.884 ETH** → `totalDue` = 100.884

### State after activation

| State | Before | After | Delta |
|---|---|---|---|
| `totalPoolETH` | 2,000 | **1,900** | −100 |
| `collateralHeld[1]` | 0 | **40** | +40 |
| `acct1` wallet | 9,500 | 9,500 − 40 + 100 = **9,560** | **+60** |
| `acct1` shares | 500 | 500 | 0 |
| Contract ETH balance | 2,000 | **1,940** | −60 |

Member values drop proportionally (100 ETH left the pool):

| Account | Pre-loan value | Post-activation value | Drop |
|---|---|---|---|
| acct0 (50%) | 1,000 | 1,000 × 1,900 / 2,000 = **950** | −50 |
| acct1 (25%) | 500 | 500 × 1,900 / 2,000 = **475** | −25 |
| acct2 (25%) | 500 | 500 × 1,900 / 2,000 = **475** | −25 |

## 1.5 — Day 28 — `acct1` repays in full

acct1 had a profitable 28 days, generated revenue, and now repays before the deadline.

```solidity
creditUnion.connect(acct1).repay(1, { value: 100.884 ether });
```

### What `repay` does on full repayment ([CreditUnion.sol:724-759](contracts/CreditUnion.sol#L724-L759))

1. **Adds the payment to the pool** — `totalPoolETH += 100.884` → pool grows to **2,000.884**.
2. **Returns the collateral** — `collateralHeld[1] = 0`, sends 40 ETH back to acct1.
3. **Flags the loan as repaid** — `loanRequests[1].status = Repaid`.
4. **Clears the active-loan pointer** — `activeLoanIdOf[acct1] = 0`.
5. **Updates reputation** — `successfulRepayments[acct1]++`.

### State after repayment

| Account | Pre-loan value | After repayment | Net change |
|---|---|---|---|
| acct0 (50%) | 1,000 | 1,000 × 2,000.884 / 2,000 = **1,000.442** | **+0.442** |
| acct1 (25%) | 500 | 500 × 2,000.884 / 2,000 = **500.221** | **+0.221** |
| acct2 (25%) | 500 | 500 × 2,000.884 / 2,000 = **500.221** | **+0.221** |

Total interest distributed: 0.442 + 0.221 + 0.221 = **0.884** ✓ (matches the interest acct1 paid).

### Economic outcomes (Case 1)

| Party | Net change vs pre-loan |
|---|---|
| **acct1** (borrower) | wallet: 9,500 → 9,499.116 (interest paid); pool: +0.221 → effectively **−0.663 ETH** (interest cost net of their own pool dividend) |
| **acct0** | pool +0.442 (yield from acct1's interest, 50% share) |
| **acct2** | pool +0.221 (yield, 25% share) |

acct1's net cost of borrowing 100 ETH for 28 days: **0.663 ETH**. They had +60 net spendable cash for the loan period, and their net cost was just the interest minus their own share dividend.

**This is what the contract is built for.** Pool members earn yield, borrower gets working capital, everyone wins.

---

# Case 2 — Normal Collateral + Guarantor → Defaulted

**Borrower:** acct1
**Guarantor:** acct0
**Story:** Same request as Case 1 — 100 ETH, 40 ETH borrower collateral. Because the borrower collateral is below 100% of principal, acct0 must explicitly approve a 60 ETH guarantee during the same 3-day vote window. This time acct1 walks away, so the borrower collateral is seized first and acct0's locked guarantee absorbs most of the remaining shortfall.

Steps 2.1 through 2.4 are identical to Case 1. We pick up at the activation:

### State after activation (same as Case 1)

| State | Value |
|---|---|
| `totalPoolETH` | 1,900 |
| `collateralHeld[1]` | 40 |
| `acct1` wallet | 9,560 |
| Member values | acct0: 950, acct1: 475, acct2: 475 |

## 2.5 — acct1 walks away; loan goes overdue

30+ days pass. acct1 doesn't call `repay`. acct3 calls `triggerDefault(1)` to collect the bounty.

### Math inside `triggerDefault`

```
seized       = collateralHeld[1] = 40
grossBadDebt = totalDue − amountRepaid = 100.884
lossCover    = min(40, 100.884) = 40           ← whole seizure used to cover bad debt
excess       = 40 − 100.884 = 0                ← no excess; share burn does NOT fire
remainingBadDebt = 100.884 − 40 = 60.884       ← socialized across all members
```

**Phase 1 — Add `lossCover` to pool**:
```
totalPoolETH:  1,900 → 1,900 + 40 = 1,940
totalShares:   2,000 (unchanged — no share burn because excess = 0)
acct1 shares:  500 (unchanged)
```

**Phase 2 — Borrower excess share burn skipped** (because excess = 0).

**Phase 3 — Guarantor shares seized**:
```
guaranteeLocked = 60
remainingBadDebt: 60.884 → 0.884
acct0 shares burned: ≈61.856 shares at the current share price
totalShares: 2,000 → 1,938.144
lockedGuarantorValueEth[acct0]: 60 → 0
```

**Phase 4 — Keeper bounty**:
```
bounty = min(100.884 × 0.01, 100 × 0.02) = 1.009 ETH
totalPoolETH: 1,940 → 1,938.991
acct3 wallet: 10,000 → 10,001.01
```

### Final state (Case 2)

| State | After default |
|---|---|
| `totalPoolETH` | **1,938.991** (started 2,000, net loss of 61.009) |
| `totalShares` | **1,938.144** (guarantor shares burned) |
| `acct1` shares | **500** (unchanged) |
| `acct1` wallet | **9,560** (untouched — keeps the 100 they borrowed) |
| `acct0` guarantee locked | **0** (released after seizure) |
| `acct3` wallet | **10,001.01** (keeper bounty) |
| `hasDefaulted[acct1]` | `true` (permanent flag) |
| `totalDefaulted[acct1]` | `100.884` |

### Member values after default

| Account | Pre-loan value | After default | Net change |
|---|---|---|---|
| acct0 (guarantor) | 1,000 | 938.144 × 1,938.991 / 1,938.144 = **938.55** | **−61.45** |
| acct1 (defaulter) | 500 | 500 × 1,938.991 / 1,938.144 = **500.22** | **+0.22** |
| acct2 | 500 | 500 × 1,938.991 / 1,938.144 = **500.22** | **+0.22** |

The pool still paid a bounty and still has a small uncovered interest shortfall, but the guarantor absorbed almost all of the principal shortfall that used to be socialized.

### Economic outcomes (Case 2)

| Party | Net change vs pre-loan |
|---|---|
| **acct1** (defaulter) | wallet **+60** (kept the 100 loan, paid 40 collateral); pool slightly up from guarantor seizure; permanently marked defaulted |
| **acct0** (guarantor) | pool **−61.45** from guarantee seizure |
| **acct2** | pool roughly flat/slightly up because acct0's seized shares are redistributed |
| **acct3** (keeper) | wallet **+1.01** |

### What changed vs the old under-collateralized model

The pool no longer absorbs the full 60.884 ETH shortfall from a 40%-collateral loan. Instead, the nominated guarantor explicitly opted into that liability before approval and their shares are locked at activation. This does not make borrower default impossible, but it moves the risk from passive pool members to a consenting co-signer and makes under-100% ETH loans socially accountable.

---

# Case 3 — Over-Collateralized → Defaulted (share-burn mechanic in action)

**Borrower:** acct0
**Story:** acct0 wants to borrow 100 ETH for 30 days. The minimum collateral the contract would accept is ~32.5 ETH (Standard tier, adjusted by their 50% pool stake). But acct0 deliberately posts **250 ETH** — well above the 130%-of-threshold mark — specifically to qualify for the *approval boost*. With the boost, the required vote majority drops from 50% to 40%, making approval easier on a contentious request.

**Why a borrower might rationally do this:** if you don't trust that other members will approve your loan on price/duration alone, an over-collateralization signal can swing the vote. Of course, if you then default, you forfeit all that extra collateral — so this strategy only makes sense if you *intend* to repay.

acct0 turns out to default anyway. Watch what happens to the excess.

## 3.1 — `acct0` requests the loan

```solidity
creditUnion.connect(acct0).requestLoan(
    100 ether,      // amount
    1075,           // 10.75% in bps
    30 * 86400,     // 30 days
    250 ether,      // collateralOffered (~7.7× minimum)
    0,              // collateralType = ETH
    0,              // collateralEthValue
    "",             // nftId
    address(0)      // no guarantor needed because collateral >= principal
);
```

### Tier classification
Same as before: **Standard tier**.

### Threshold rate
Same as before: **1014 bps**. acct0 offers 1075 → passes.

### Threshold collateral — different because acct0 has a larger stake

```
stakePoolBps      = 1000·10000/2000   = 5000 bps  (acct0 owns 50%)
stakeDiscount     = 5000 / 4          = 1250 bps  (cap = 4000/4 = 1000 → CAPPED)
sizePremiumCollat = 500 / 2           = 250 bps
effectiveBps      = 4000 + 250 - 1000 = 3250 bps
threshCollateral  = 100·3250/10000    = 32.5 ETH
```

acct0 offers 250 ≫ 32.5 → **passes massively**.

### Approval majority

- Base for 30-day loan: **50%**.
- Rate boost? 130% × 1014 = 1318. Offered 1075 < 1318 → **no rate boost**.
- Collateral boost? 130% × 32.5 = 42.25. Offered 250 ≫ 42.25 → **collateral boost applies (−10%)**.
- Final required majority: 50% − 10% = **40%** of eligible weight.

### Eligible voting weight

```
totalWeight    ≈ 7.64 × 10^10
borrowerWeight ≈ 3.16 × 10^10   (acct0)
eligibleWeight ≈ 4.48 × 10^10   (acct1 + acct2)
```

## 3.2 — Voting

acct1 votes **YES**, acct2 abstains.

```
votesFor   ≈ 2.24 × 10^10   (acct1's weight)
           = ~50% of eligible weight
required   = 40%
50% > 40% → passes (and would have been close without the boost)
```

The boost lowered the bar enough that a single supporter could carry the vote. This is the rational reason to over-collateralize.

## 3.3 — Finalize

`finalizeLoan(1)` after 3 days. Result: **Approved**.

## 3.4 — `activateLoan` — acct0 locks 250 ETH, receives 100 ETH

```solidity
creditUnion.connect(acct0).activateLoan(1, { value: 250 ether });
```

### State after activation

| State | Before | After | Delta |
|---|---|---|---|
| `totalPoolETH` | 2,000 | 1,900 | −100 |
| `collateralHeld[1]` | 0 | **250** | +250 |
| `acct0` wallet | 9,000 | 9,000 − 250 + 100 = **8,850** | **−150** |
| `acct0` shares | 1,000 | 1,000 | 0 |

Contrast with Case 1 (acct1 with 40 collateral): acct1's wallet went up 60, acct0's wallet went *down* 150. acct0 has paid 150 ETH out-of-pocket for the use of 100 ETH of pool capital — a deeply over-collateralized position.

Member values drop proportionally (same as Case 1 and 2):

| Account | Pre-loan value | Post-activation value | Drop |
|---|---|---|---|
| acct0 (50%) | 1,000 | **950** | −50 |
| acct1 (25%) | 500 | **475** | −25 |
| acct2 (25%) | 500 | **475** | −25 |

## 3.5 — acct0 fails to repay; loan goes overdue

acct3 calls `triggerDefault(1)`.

### Math inside `triggerDefault`

```
seized       = collateralHeld[1] = 250
grossBadDebt = totalDue − amountRepaid = 100.884
lossCover    = min(250, 100.884) = 100.884
excess       = 250 − 100.884     = 149.116    ← share burn fires
```

**Phase 1 — Add `lossCover` to pool** (all members share):
```
totalPoolETH:  1,900 → 2,000.884
acct0 value:   950   → 1,000 × 2,000.884 / 2,000 = 1,000.442  (+0.442 = their share of interest)
```

**Phase 2 — Share burn on acct0** (calibrated to keep acct0 flat through the excess addition):
```
defShares  = 1,000
nonDef     = 1,000
P          = 2,000.884
E          = 149.116

numerator     = 1,000 × 2,000.884 × 1,000           = 2.000884 × 10⁹
denominator   = 2,000.884 × 1,000 + 2,000 × 149.116 ≈ 2,299,116
newDefShares  = numerator / denominator             ≈ 870.29
sharesBurned  ≈ 129.71

totalPoolETH:  2,000.884 → 2,150
totalShares:   2,000     → 1,870.29
acct0 shares:  1,000     → 870.29
```

**Phase 3 — Keeper bounty**:
```
bounty = min(100.884 × 0.01, 100 × 0.02) = 1.009 ETH
totalPoolETH: 2,150 → 2,148.991
acct3 wallet: 10,000 → 10,001.01
```

### Final state (Case 3)

| State | After default |
|---|---|
| `totalPoolETH` | **2,148.991** (started 2,000, gained 148.99 net) |
| `totalShares` | **1,870.29** (129.71 burned from acct0) |
| `acct0` shares | **870.29** |
| `acct0` wallet | **8,850** (untouched at default — already paid the 150 at activation) |
| `acct3` wallet | **10,001.01** (keeper bounty) |
| `hasDefaulted[acct0]` | `true` |

### Member values after default

Values below are computed at the post-Phase-2, **pre-bounty** pool (2,150 ETH) to demonstrate the share-burn invariant cleanly. The keeper bounty (1.009 ETH) is then deducted proportionally from all members at final settlement.

| Account | Shares | Member value (pre-bounty pool = 2,150) | Net change |
|---|---|---|---|
| acct0 (defaulter) | 870.29 | 870.29 × 2,150 / 1,870.29 = **≈ 1,000.44** | **+0.44** (just the interest dividend) |
| acct1 | 500 | 500 × 2,150 / 1,870.29 = **≈ 574.78** | **+74.78** |
| acct2 | 500 | 500 × 2,150 / 1,870.29 = **≈ 574.78** | **+74.78** |

### Economic outcomes (Case 3)

| Party | Net change vs pre-loan |
|---|---|
| **acct0** (defaulter) | wallet −150 (over-collateralization paid at activation); pool +0.44; **≈ −149.56 ETH total** |
| **acct1** | pool +74.78 (was −25 during loan, recovered then captured excess) |
| **acct2** | pool +74.78 (same) |
| **acct3** (keeper) | wallet +1.01 |

acct0's loss is essentially the 150 over-collateralization premium they posted. The share-burn math made sure that 150 went **to honest members** instead of back to themselves through their own pool stake. Compare to Case 2 where the defaulter went *up* 60.22 (even more under the guarantor-backed scenario; 44.75 in the no-guarantor counterfactual) — here the over-collateralization plus the share-burn redistribution flips the math decisively in the pool's favor.

---

# Side-by-Side Summary

|  | Case 1 (repaid) | Case 2 (just-met-threshold, guarantor-backed, defaulted) | Case 3 (over-collateralized default) |
|---|---|---|---|
| Borrower | acct1 (25% stake) | acct1 (25% stake) | acct0 (50% stake) |
| Principal | 100 | 100 | 100 |
| Min collateral required | 36.25 | 36.25 | 32.5 |
| Collateral posted | **40** (1.1× min) | **40** (1.1× min) | **250** (7.7× min) |
| Approval boost? | No | No | Yes (collateral boost) |
| Required majority | 50% | 50% | 40% |
| Borrower cash flow at activation | **+60** | **+60** | **−150** |
| Outcome | Repaid in full | Defaulted | Defaulted |
| Share burn fires? | n/a | **No** (excess = 0) | **Yes** (excess ≈ 149) |
| Pool change vs pre-loan | +0.884 | **−61.01** (guarantor-absorbed) | +148.99 (excess captured) |
| Borrower's total economic outcome | **−0.66** (interest, net of dividend) | **+60.22 ⚠️** (profitable default) | **−149.56** (premium forfeited) |
| acct0's pool change | +0.442 | **−61.45** (guarantor seizure) | +0.44 (defaulter) |
| acct1's pool change | +0.221 (defaulter, see borrower row) | **+0.22** (defaulter, see borrower row) | +74.78 |
| acct2's pool change | +0.221 | **+0.22** | +74.78 |
| `hasDefaulted[borrower]` | false | true (permanent) | true (permanent) |
| `successfulRepayments[borrower]` | +1 | unchanged | unchanged |

## Key takeaways

**Case 1 vs Case 2 (same loan terms, different outcomes):**
If everyone repays, everyone wins (small but positive). If a borrower defaults at minimum threshold collateral with a guarantor backing the shortfall, the borrower walks away with +60.22 while the guarantor absorbs −61.45 — the passive pool members (acct2) are nearly flat (+0.22). Without the guarantor the full 61.01 ETH loss would have been socialized proportionally (acct0 −30.50, acct2 −15.25, borrower −15.25 + wallet +60 = +44.75 net). **The guarantor mechanic shifts concentrated risk from passive pool members to a consenting co-signer, but the thin collateral threshold still cannot make default unprofitable for the borrower on its own — voting and reputation have to do the work.**

**Case 2 vs Case 3 (both defaults, different collateral):**
The share-burn mechanic only fires when collateral *exceeds* bad debt. Below that threshold, default is profitable for the borrower; above it, default is heavily punitive. The contract's collateral baselines (15% / 40% / 75% by tier) are *under* the level that would make default mathematically unprofitable on its own — Trust at 15% leaves the largest gap, Secured at 75% the smallest.

**Practical implication:**
Borrowers in good standing should request the **lowest tier they qualify for**, post the **minimum collateral**, and **repay on time** — that's Case 1, and it's a clean economic outcome for everyone. The over-collateralization in Case 3 only makes sense as an approval-boost mechanism for contentious requests, and only if the borrower fully intends to repay. From the pool's perspective, the safest defense against Case-2-style strategic defaults is **rejecting suspicious loan requests at the voting stage** — once activated, the contract's math can't recover what was lost.

---

## Summary of the invariants this design enforces

1. **The defaulter never benefits from the *excess* portion of their forfeited collateral** — the share burn is exactly calibrated so their pool value is held flat across the excess addition. They do still receive their pro-rata share of the bad-debt cover (which includes the unpaid principal *and* unpaid interest) — this is consistent with how a normal repayment behaves, where the borrower-member captures their own ownership-fraction of any interest they pay back via share appreciation.
2. **The bad-debt cover is shared by all** — this is not a punishment, it's just undoing the loan loss (principal portion) plus crediting the interest that the borrower nominally owed. All members (including the defaulter, on their remaining shares) participate.
3. **The punitive premium flows to honest members** — non-defaulters' shares appreciate by the full excess amount, distributed pro-rata to their pre-default ownership of the non-defaulter slice.
4. **Successful repayment distributes interest yield to all members pro-rata** — including the borrower's own share. The borrower's net interest cost is `interest_paid × (1 − borrower_ownership_fraction)`.
5. **Below-threshold-coverage defaults socialize loss** — when collateral doesn't cover bad debt (Case 2), all members' shares depreciate proportionally and the defaulter can come out ahead. The contract delegates protection against this scenario to the voting system and reputation flags, not to the collateral math itself.
6. **ETH is conserved** — every wei moves from one place to another (defaulter wallet → pool, pool → keeper, borrower wallet → pool, etc.). The contract never mints or destroys ETH; only redistributes it.
