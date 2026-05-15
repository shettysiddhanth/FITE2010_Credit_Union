# Wallet vs Pool — Quick Reference

This short reference explains which values come from your wallet (your EOA) versus which values are stored in the contract pool (`CreditUnion`). Use this when interpreting the frontend UI and tracing ETH flows.

## Wallet (your account)
- `my-wallet` / `provider.getBalance(address)`: your externally-owned account ETH balance. This changes when you send transactions (deposits, loan activation, repayments, gas payments) or when someone sends ETH to your address (e.g., keeper bounty).
- ETH you actively send in transactions: `join()` / `addDeposit()` (deposit → wallet → pool), `activateLoan()` when sending collateral, `repay()` when paying back a loan, `triggerDefault()` (keepers sometimes send ETH).
- Keeper receipts and other transfers to you: pool → wallet transfers (e.g., keeper bounty, withdrawals you initiated).

## Pool (contract state — `CreditUnion`)
- `pool-eth` / `contract.getPool()[0]`: `totalPoolETH` — the ETH physically held by the contract. Changes when wallets send ETH to the contract (deposits, repayments, keeper liquidation funds) or when the contract sends ETH out (withdrawals, loan disbursements, keeper bounties).
- `my-value` / `contract.getMemberValue(addr)`: your share of the pool expressed in ETH (derived from `members[addr].shares`, `totalShares`, and `totalPoolETH`). This is on-chain accounting, not your wallet balance.
- `my-shares` / `members[addr].shares`: your internal share units (burned on withdraw). Shares × (totalPoolETH/totalShares) → on-chain ETH value.
- `lockedGuarantorValueEth[addr]`: reserved ETH-value of a guarantor's stake locked by active guarantees (on-chain reservation, not separate wallet funds).
- Loan-related pool flows:
  - Activation: pool → borrower wallet (principal disbursed), pool's ETH decreases by principal.
  - Repayment: borrower wallet → pool (repayment amount), pool's ETH increases; interest becomes pool income and accrues to members via higher per-share value.
  - Default: seized collateral (ETH or NFT valuation) is added to pool before bad-debt calc; guarantor share burns or socialized loss change `totalShares`/`totalPoolETH`.

## Important notes
- Gas costs are always paid from your wallet and are not part of pool accounting — total wallets + pool will differ by gas burned.
- `lockedGuarantorValueEth` is a pool-side reservation against a member's stake; it reduces the member's available withdrawable value but does not create a separate ETH bucket in wallets.
- The frontend shows a mixture of wallet-derived and pool-derived values. Use `my-wallet` to see your EOA funds and `my-value`/`my-shares` to inspect on-chain stake value.

## Short flow examples
- Deposit: wallet (you) → contract; contract increases `totalPoolETH` and mints `shares` for you.
- Withdraw: contract burns `shares` → contract sends ETH → your wallet increases.
- Loan disbursement: contract sends principal → borrower wallet (pool decreases).
- Repay: borrower wallet sends ETH → pool increases; interest accrues to members via higher `totalPoolETH`.
- Default & keeper bounty: seized collateral → pool increases; keeper bounty → pool decreases and keeper wallet increases.

For a concise UI mapping see the frontend `Overview` card: `pool-eth` and `pool-members` are pool values; `my-wallet` is your EOA balance; `my-value` and `my-shares` are on-chain pool-derived member values.
