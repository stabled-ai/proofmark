# Proofmark submission evidence

> Reconciled 2026-09-07. The public deployment is the v1 build, tagged `v1-live`; every row below was re-read against it on that date. The v2 contracts in this tree (roster v2, atomic receipts, issuer-authorised epochs) are scheduled for redeploy and are not part of these claims.

> Use this page to prepare the submission form and judge demo. It
> separates what is live, what is sandboxed and what is roadmap so no capability inherits a claim
> from a neighbouring component.

## One sentence

Proofmark normalizes external KYC/AML credentials, proves their Ethereum source transaction
through Attestcoin, and lets each Creditcoin application enforce its own frozen policy.

## Live on public testnets

| Claim | Evidence | Read-only reproduction |
|---|---|---|
| One Sepolia source chain and source contract are pinned in the CC3 verifier | `ProofmarkASC` `0x3C6Fe016…b242`; source `0xA9A34586…72B9` | `npm run verify:submission` reads `expectedChainKey = 1` and `sourceContract` |
| Two sandbox marks were emitted in one Sepolia transaction | [Sepolia issueBatch](https://sepolia.etherscan.io/tx/0x290498028010e6ce5f75de3d69695091e24863423e01a7981a277db86c8d69f1) | Open the receipt and `MarkIssued` logs |
| Both demo marks were refreshed in one Sepolia transaction on 2026-09-07 | [Sepolia issueBatch](https://sepolia.etherscan.io/tx/0x80140a23f93c26fdba0de88b53cee2398aaad483d1f5cbdeab155b6fa782155d), block 11654962 | `getMark` on `ProofmarkASC` returns `issuedAt` 2026-09-07 15:11 UTC for both holders; step 3 of `npm run verify:submission` prints the remaining policy-2 window |
| Attestcoin proof materialized those marks on CC3 | [CC3 execute](https://creditcoin-testnet.blockscout.com/tx/0x50c30b315f74150fecf56b670a5d6c9cf7dc0bc76c815809dbc6af899de567d8) | Read `/onchain` or run the submission verifier |
| The same mark fails production policy 1 and passes sandbox policy 2 | Frozen policies on `ProofmarkRegistry` `0x2F4E5e12…0572` | `SCENES=5 bash docs/demo-video/commands.sh` |
| The token refuses an unverified recipient | `RecipientNotVerified` selector `0x17887111` | `SCENES=6 bash docs/demo-video/commands.sh` reproduces the revert with `eth_call` |
| Verified A transferred 40 KPCN to verified B | [CC3 transfer](https://creditcoin-testnet.blockscout.com/tx/0xefe550ff98e513b8c6cd7fa8541fd1d7d0f33197b149fb674df8acba7aa9aa0d) | Inspect the receipt and current balances |
| Epoch 1 was published on Sepolia and accepted on CC3 | [Sepolia publish](https://sepolia.etherscan.io/tx/0x2adefae22bd29e7fc43b9f9161f6c722cc2deb4eae6bc720aca5a2b65e7816df), [CC3 accept](https://creditcoin-testnet.blockscout.com/tx/0xb011cd6e5a590b924858262cdfc832a6ef0d71cc4b78c3ac61efaf3d0c2f532f) | Historical record in `deployments/epoch-1.json`; superseded by epoch 2 |
| Epoch 2 carries the refreshed marks and is the current roster on CC3 | [Sepolia publish](https://sepolia.etherscan.io/tx/0xde9743af4f8895b152b49c0c67d2a0034ed392cd201a3f28d4f1bdbca4a7c3b9), [CC3 accept](https://creditcoin-testnet.blockscout.com/tx/0x519bd88c03b37dd6e0db4defb73c149c394873a01e2d7598697d12b62cc8a9a1), 8m 15s by block timestamps | `npm run verify:epoch -- deployments/epoch-2.json` rebuilds root `0xa347701c…e847` with roster format 1 and calls the inclusion/non-inclusion views |
| Sanctions screening reads official OFAC, UN and EU source data | 26,566 entries and 78,365 names in the current built index | `bash aml/fetch-lists.sh && npx tsx aml/build-index.ts && npx tsx aml/eval.ts` |
| Core security and lifecycle paths are regression tested | 118 Solidity tests and 600 TypeScript/ABI tests in the source-bound evidence run | `npm run test:evidence && npm run check:submission` prints the exact counts |
| Public product and APIs answer | [product](https://attest-kyc.stabled.ai), [on-chain state](https://attest-kyc.stabled.ai/onchain), [guided flow](https://attest-kyc.stabled.ai/verify) | `bash scripts/check-demo-urls.sh` |
| Public CI is reproducible | [GitHub Actions](https://github.com/stabled-ai/proofmark/actions) | Clone recursively and run the commands above |

Contract addresses and policy IDs are machine-readable in
[`deployments/cc3-testnet.json`](../deployments/cc3-testnet.json). Epoch inputs and measured
timestamps are in [`deployments/epoch-1.json`](../deployments/epoch-1.json).

## Live logic behind a sandbox credential

These parts execute for real in the public `/verify` flow:

- wallet ownership signature and consent/flow binding;
- reconciliation and request replay protection;
- sanctions screening against the loaded public lists;
- claims and evidence commitments;
- Sepolia issuance, worker proof submission and CC3 policy evaluation.

The ID and bank answers feeding that flow are labelled demo inputs. The distinction survives in
the on-chain `regime = 2` value.

## Sandbox only

| Capability | Exact boundary |
|---|---|
| ID document adapter | `demo:id`; no institution is contacted |
| Bank and one-won adapter | `demo:bank`; no bank is contacted and the code is displayed in the UI |
| Sandbox method bits | May be set only under the demo switch; the mark remains regime 2 |
| Policy outcome | May pass frozen sandbox policy 2; cannot pass frozen production policy 1 |
| Evidence retention | Public Vercel flow keeps no persistent server-side evidence record |
| Keys and roles | One testnet key holds several demo roles |

## Roadmap, not submission claims

- Signed external credential-provider or institutional vendor integration
- Production ID and bank credential
- Licensed PEP and adverse-media checks
- Managed database/KMS evidence service
- Distributed rate limiting and worker HA
- External audit, penetration test and Korean legal sign-off
- Production key separation and emergency governance
- Selective-disclosure ZK, new jurisdictions and spoke chains

## Freshness gate before recording and judging

Policy 2 imposes a seven-day maximum mark age on top of the credential expiry. Two clocks matter:

| Evidence | Issued | Policy 2 stops accepting it | What renews it |
|---|---|---|---|
| Current Direct marks for holders A and B | 2026-09-07 15:11 UTC ([refresh](https://sepolia.etherscan.io/tx/0x80140a23f93c26fdba0de88b53cee2398aaad483d1f5cbdeab155b6fa782155d)) | 2026-09-14 15:11 UTC | `bash docs/demo-video/reissue-ab.sh all` from the `v1-live` checkout |
| Epoch 2 roster, which carries the 2026-09-07 marks ([published 2026-09-08 13:33 UTC](https://sepolia.etherscan.io/tx/0xde9743af4f8895b152b49c0c67d2a0034ed392cd201a3f28d4f1bdbca4a7c3b9)) | 2026-09-07 15:11 UTC | 2026-09-14 15:11 UTC (the root itself stays fresh until 2026-11-07) | `npx tsx script/publish-epoch.ts --publish` from the `v1-live` checkout, then copy the new `deployments/epoch-N.json` |

`npm run verify:submission` runs both gates read-only: step 3 requires at least 24 hours of
Direct-mark freshness (`MIN_FRESH_HOURS`) and step 4 requires at least one hour of roster
freshness for the newest checked-in epoch record. An expired demonstration therefore fails the
verifier instead of shipping silently. HACK-13 still requires one more refresh of both, within
seven days of judging; both clocks currently end on 2026-09-14 15:11 UTC.

## Claims we do not make

- Production-ready, regulated or audited
- Anonymous or zero-data KYC
- A statistical latency SLA
- A live Sumsub, CCID, zkMe, CODEF bank or KFTC production integration
- Revenue, a paid pilot, awarded CEIP funding or signed customer traction
