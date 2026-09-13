# Proofmark

**The compliance gateway for Creditcoin.** A KYC/AML mark is issued on Ethereum, proven to Creditcoin through the Attestcoin Protocol, and enforced by a tokenised asset's own transfer check. Verified once. Enforced by every asset. Revoked everywhere.

- Product: [attest-kyc.stabled.ai](https://attest-kyc.stabled.ai)
- Live Creditcoin state: [attest-kyc.stabled.ai/onchain](https://attest-kyc.stabled.ai/onchain)
- Guided issuance: [attest-kyc.stabled.ai/verify](https://attest-kyc.stabled.ai/verify)
- Pitch deck: [docs/deck/proofmark-deck.pdf](docs/deck/proofmark-deck.pdf) · Demo video kit: [docs/demo-video](docs/demo-video/SHOTLIST.md)
- Submission evidence: [docs/15-submission-evidence.md](docs/15-submission-evidence.md) · Investment memo: [docs/11-investment-memo.md](docs/11-investment-memo.md) · Diligence review: [docs/12-ctc-investment-review.md](docs/12-ctc-investment-review.md)
- Integrate from a Creditcoin application: [examples/consumer/README.md](examples/consumer/README.md)

Built for BUIDL CTC 2026 Fall, RWA track, on Creditcoin CC3 Testnet and Ethereum Sepolia.

## Current development boundary — 2026-09-10

The [winning sprint](docs/88-winning-sprint.md) tracks external-provider onboarding, ongoing AML integration, a real local ZK eligibility prototype, and a wallet-free judge experience. These are development work, not capabilities already deployed at the public addresses below. Provider credentials and approved processing policies are required for real verification; sandbox approval is never production eligibility. The existing `claimsRoot` is a commitment, **not a ZK proof**. Historical chain observations below do not establish the latest source tree's deployment or current eligibility.

New local entry points: `/demo` for the judge walkthrough, `/verify/provider` for hosted Sumsub onboarding; the existing sanctions screen is preserved at `/screening` and the Korean flow remains at `/verify`. See the [provider setup](docs/89-sumsub-onboarding.md) and [real ZK proof reproduction](zk/README.md). Provider approval currently produces a non-issuable evidence candidate (`methods = 0`), pending authenticated per-check mapping and the issuance bridge.

## What it does

Every tokenised asset has to know who holds it, at issuance and every day after. Proofmark separates **what an issuer checked** from **whether that is enough for this asset**, and makes the second question a view function on Creditcoin.

1. **Verify.** A guided flow runs wallet control (an EIP-4361 signature bound to a consent version), an ID document check, a bank account check (holder name plus a ₩1 transfer) and sanctions screening against OFAC, UN and EU source lists. Only the checks that ran set a bit in the mark's method bitmap; a sandbox check leaves an honest regime behind.
2. **Prove.** The issuer emits `MarkIssued` on Ethereum Sepolia: a method bitmap, assurance level, regime, jurisdiction and two 32-byte commitments. `ProofmarkASC` on Creditcoin verifies the inclusion proof for that exact source transaction through Attestcoin's BlockProver and materialises the mark. No Proofmark-operated oracle signs anything.
3. **Enforce.** `ProofmarkRegistry.isVerified(wallet, policyId)` evaluates a frozen policy: required methods, minimum assurance, maximum age, regime, jurisdiction, trusted issuer and optional roster freshness. `GatedRwaNote`, a tokenised credit note, calls it for sender and recipient on every transfer and reverts with `RecipientNotVerified` or `SenderNotVerified`.

A revocation follows the same path: `revoke` on Ethereum, proof to Creditcoin, tombstone on the mark, and the note refuses the holder. Nobody touches Creditcoin to make that happen.

## See it work in sixty seconds

Everything below is read-only against the public deployment. Outputs were captured 2026-09-07.

```sh
export CC3=https://rpc.cc3-testnet.creditcoin.network
REG=0x2F4E5e1270f90E51251651caf08547393e3C0572   # ProofmarkRegistry, Creditcoin CC3
NOTE=0xa74aB3De359a55A729f9185Fe4Afe90526E585CA  # GatedRwaNote, KPCN
A=0x4816B6e3Acb775f65Da888f185f708E2C8D7a3e2     # a verified holder
B=0x77858131d1E0eAaAe2c38c2cce508c358C9b58ee     # another verified holder
C=0x00000000000000000000000000000000DeaDBeef     # never issued

# A listed name is blocked by real sanctions data
curl -s -X POST https://attest-kyc.stabled.ai/api/screen -H 'content-type: application/json' \
  -d '{"fullName":"Kim Jong Un","dateOfBirth":"1984-01-08","nationality":"KP"}' | head -c 120
# {"decision":"BLOCK","riskBand":5,"hits":[{"listId":"OFAC_SDN","entryId":"20157" ...

# One mark, two frozen policies, two answers
cast call $REG 'isVerified(address,uint256)(bool)' $A 1 --rpc-url $CC3   # false  KR production policy
cast call $REG 'isVerified(address,uint256)(bool)' $A 2 --rpc-url $CC3   # true   KR sandbox pilot policy

# The note's own gate
cast call $NOTE 'canTransfer(address,address)(bool)' $A $B --rpc-url $CC3   # true
cast call $NOTE 'canTransfer(address,address)(bool)' $A $C --rpc-url $CC3   # false
cast call $NOTE 'transfer(address,uint256)' $C 1000000000000000000 --from $A --rpc-url $CC3
# reverts with 0x17887111…  RecipientNotVerified(0x…DeaDBeef, 2)
```

The full scene script for the demo video, `bash docs/demo-video/commands.sh`, runs every one of these checks and prints what the chain answers.

## Live deployment

Source of record: [deployments/cc3-testnet.json](deployments/cc3-testnet.json).

| Contract | Network | Address |
|---|---|---|
| `EvmV1Decoder` | Creditcoin CC3 | `0x5eE29aB8845A2AD4BBE1e01c5BD3bCc3AEee47Fd` |
| `ProofmarkASC` | Creditcoin CC3 | `0x3C6Fe016645CA52952E29C66E435bDa7F611b242` |
| `ProofmarkRegistry` | Creditcoin CC3 | `0x2F4E5e1270f90E51251651caf08547393e3C0572` |
| `ComplianceSource` | Ethereum Sepolia | `0xA9A34586303b9fD92e090F9bb1D332DC854c72B9` |
| `GatedRwaNote` (`KPCN`) | Creditcoin CC3 | `0xa74aB3De359a55A729f9185Fe4Afe90526E585CA` |

The ASC accepts proofs from one source chain (`expectedChainKey = 1`, Sepolia) and one source contract, set once at deployment.

### Frozen policies

| ID | Purpose | Required methods | Assurance | Max age | Regime | Jurisdiction | Trusted issuer | Asset binding |
|---|---|---|---:|---:|---:|---:|---|---|
| 1 | KR production | `0x10024` | 2 | 30 days | 1 | 410 | pinned | none |
| 2 | KR sandbox pilot | `0x10024` | 2 | 7 days | 2 | 410 | pinned | `KPCN` |

`0x10024` is `ID_DOC_AUTHENTICITY | BANK_ACCOUNT | SANCTIONS_SCREENED`. Both policies are permanently frozen; the note constructor rejects a mutable policy. The public sandbox issues `regime = 2` marks, which is why the same mark fails policy 1 and passes policy 2.

### Live cross-chain evidence

- Sepolia `issueBatch` [`0x29049802…69f1`](https://sepolia.etherscan.io/tx/0x290498028010e6ce5f75de3d69695091e24863423e01a7981a277db86c8d69f1) issued two marks; the worker's Attestcoin submission [`0x50c30b31…67d8`](https://creditcoin-testnet.blockscout.com/tx/0x50c30b315f74150fecf56b670a5d6c9cf7dc0bc76c815809dbc6af899de567d8) materialised both on CC3.
- Both marks were refreshed on 2026-09-07 in [`0x80140a23…155d`](https://sepolia.etherscan.io/tx/0x80140a23f93c26fdba0de88b53cee2398aaad483d1f5cbdeab155b6fa782155d); `getMark` shows `issuedAt` 2026-09-07 15:11 UTC for both holders, so policy 2 keeps answering `true` until 2026-09-14 15:11 UTC.
- `KPCN` minted 100 to verified holder A in [`0xa1f3b9fa…e77`](https://creditcoin-testnet.blockscout.com/tx/0xa1f3b9fa62419b0352376d633b703442830d95a45179772825e44397342f8e77); A transferred 40 to verified holder B in [`0xefe550ff…aa0d`](https://creditcoin-testnet.blockscout.com/tx/0xefe550ff98e513b8c6cd7fa8541fd1d7d0f33197b149fb674df8acba7aa9aa0d). A transfer to an unissued wallet reverts with `RecipientNotVerified`.
- Epoch 1 root `0xfe6cf3e0…364d` was published on Sepolia in [`0x2adefae2…16df`](https://sepolia.etherscan.io/tx/0x2adefae22bd29e7fc43b9f9161f6c722cc2deb4eae6bc720aca5a2b65e7816df) and accepted on CC3 in [`0xb011cd6e…532f`](https://creditcoin-testnet.blockscout.com/tx/0xb011cd6e5a590b924858262cdfc832a6ef0d71cc4b78c3ac61efaf3d0c2f532f) 8m 00s later by block timestamps. The registry answers roster membership `true` under policy 2, `false` under policy 1, and non-membership `true` for an unissued address.
- Epoch 2 root `0xa347701c…e847`, carrying the refreshed marks, was published on Sepolia in [`0xde9743af…c3b9`](https://sepolia.etherscan.io/tx/0xde9743af4f8895b152b49c0c67d2a0034ed392cd201a3f28d4f1bdbca4a7c3b9) and accepted on CC3 in [`0x519bd88c…a9a1`](https://creditcoin-testnet.blockscout.com/tx/0x519bd88c03b37dd6e0db4defb73c149c394873a01e2d7598697d12b62cc8a9a1) 8m 15s later; the same three verdicts hold against it ([deployments/epoch-2.json](deployments/epoch-2.json)).

| Measured propagation | Time |
|---|---:|
| Mark issuance → `isVerified` true on CC3, run 1 | 7m 55s |
| Mark issuance → `isVerified` true on CC3, run 2 | 10m 48s |
| Mark revocation → tombstone on CC3 | 8m 43s |
| Epoch root published → accepted on CC3, run 1 | 8m 00s |
| Epoch root published → accepted on CC3, run 2 | 8m 15s |

Inputs and timestamps: [deployments/epoch-1.json](deployments/epoch-1.json), [deployments/epoch-2.json](deployments/epoch-2.json), [docs/16-propagation-observations.md](docs/16-propagation-observations.md). Five runs are an observation, not an SLA.

## How Attestcoin is used

Remove Attestcoin and what is left is a relayer we operate, which is exactly the trust the product exists to remove.

| Without Attestcoin | With Attestcoin |
|---|---|
| A Proofmark-run signer copies marks to Creditcoin; that key is the compliance truth | `ProofmarkASC` verifies the Sepolia transaction's inclusion and continuity through BlockProver; the source event is the truth |
| Revocation depends on our operator noticing and signing | Anyone can submit the proof of a `MarkRevoked` event; the ASC tombstones the subject on its own |
| Policy consumers trust an allowlist admin | Policy consumers read `isVerified` against state that only a proven source event can change |

| Where | What |
|---|---|
| `src/ProofmarkASC.sol` | Extends our fork `ASCBaseX`. `execute()` verifies through `VERIFIER.verifyAndEmit`; the handler pins chain key and source contract, decodes the whole receipt, orders ordinary lifecycle and denial/correction decisions by proved source coordinates, and applies every recognized event atomically |
| `src/ASCBaseX.sol` | `ASCBase` with one internal signature widened so the handler receives `chainKey`, `blockHeight` and `txIndex`. See the findings below |
| `worker/` | Scans `ComplianceSource`, waits for attested height, fetches the proof, submits it. Jobs persist atomically and requeue on every poll; the worker holds no compliance authority |
| `script/deploy.sh` | Reads chain keys from the ChainInfo precompile (Sepolia is chainKey 1, not chainId 11155111); `configureSource` is one-time |
| `src/ComplianceSource.sol` | Issuance/revocation/denial/epoch operations plus governed denial correction. N events in one source transaction apply in one `execute()` |

Reads are free on Attestcoin; we claim no ATC demand from them. The submission-form version of this section is [docs/submission/integration-summary.md](docs/submission/integration-summary.md).

## Security

We attacked the state machine, not just the happy path.

| Failure mode | Control | Test |
|---|---|---|
| Same address on a second attested chain | ASC pins `expectedChainKey` and `sourceContract`, set once | `test_RejectsProofFromWrongChain` |
| Stale proof resurrects a revoked mark | Per-subject source block and transaction-index cursor; older proofs are skipped and logged | `test_StaleIssueCannotResurrectRevokedMark` |
| Two opposing events in one source block | Transaction index recovered from the same Merkle proof BlockProver verifies | `test_SameBlockTxIndexPreventsOutOfOrderResurrection` |
| Sanctions denial downgraded | Ordinary issue/revoke cannot clear denial; only an independently approved delayed source correction paired with its exact replacement can supersede it | denial-order and `DenialCorrection` suites |
| Policy changed under a live asset | Permanent freeze; `GatedRwaNote` binds to a frozen policy for life | `FrozenPolicy` |
| Forged roster non-membership | Roster v2: domain-separated leaf and node hashes, committed leaf count, full proof shape, sentinel leaves | `RosterProof.t.sol` |
| API replay | Wallet, flow and consent binding; `issueOnce` consumes its request ID on chain | `IssueOnceReplay` |
| Worker crash mid-send | Signed envelope persisted before send; exact-byte recovery | worker crash suite |
| Unilateral or unsafe asset recovery | Legacy owner-only force selectors are absent; proposal + distinct approval + delay are required and transfer eligibility is checked again at execution | `GatedRwaNote.t.sol` |

`npm test` runs the Foundry suite; `npm run test:ts` includes worker, pipeline, provider, AML, roster and vault tests. Current execution results and limits are recorded in the [winning sprint ledger](docs/88-winning-sprint.md); older test totals are not a claim about new code. The trust-boundary summary is [docs/14-hackathon-threat-model.md](docs/14-hackathon-threat-model.md).

**Two findings in Attestcoin's `ASCBase`.** While integrating we found that `execute()` receives `chainKey` and `blockHeight` and forwards neither to `_processAndEmitEvent`, so a derived contract can neither pin its source chain nor order what it applies. A same-address contract on a second attested chain passes as the trusted emitter; a stale issuance proof resurrects a revoked mark. `ASCBaseX` widens that one internal signature and nothing else; mutation tests pin both guards. The report, offered to the protocol team under MIT, is [docs/09-ascbase-security-findings.md](docs/09-ascbase-security-findings.md).

**Our own review of the deployed build.** In September our review found two defects in the v1 contracts on testnet: a late-arriving permanent denial could be skipped behind a newer issuance cursor, and the v1 roster accepted a malformed non-inclusion proof. Neither touches the direct-mark path shown in the demo. Both are fixed and regression-tested in this tree, together with roster v2, atomic receipt processing and issuer-authorised epochs; the v2 redeploy is the first funded milestone. Details and the migration runbook: [docs/19-security-migration.md](docs/19-security-migration.md).

The testnet deployment shares one key across deployer, issuer, policy owner, epoch publisher and worker payer. Production separates those roles behind managed keys or multisigs; the [key-rotation design](docs/37-issuer-key-rotation.md) keeps the issuer address stable while operating keys change.

## Compliance operations

A credential is a lifecycle, not a mint.

| Capability | Status |
|---|---|
| Sanctions screening: OFAC SDN, UN Consolidated, EU FSF, 26,566 entries and 78,365 names parsed from source XML; stale sources fail closed; FATF June 2026 tables source-verified | live in the public product |
| ID document authenticity: Government24 resident card, driver licence and OCR through CODEF | integrated; the public sandbox runs the labelled `demo:id` adapter |
| Bank account: holder-name inquiry and ₩1 transfer through KFTC Open Banking | integrated; the public sandbox runs the labelled `demo:bank` adapter |
| Consent version bound to the wallet signature and flow; one flow finalises once | live |
| Encrypted evidence vault (AES-256-GCM), rescreen → `revokeBatch` outbox, manual review, hold and approval-gated deletion, erasure records | implemented; pilot deployments on persistent storage |
| PEP and adverse media | unset until a licensed source is connected; the bits stay honest |

Screening regression on the built index: 200 of 200 listed people caught (168 BLOCK, 32 REVIEW), 610 of 610 clean names passed, 7 of 7 normalisation evasions and the listed-wallet case caught. Method and boundaries: [docs/28-aml-identity-comparison.md](docs/28-aml-identity-comparison.md), [docs/29-aml-edit-retrieval.md](docs/29-aml-edit-retrieval.md).

Nothing is silently mocked. An axis is a real vendor, the labelled demo vendor under `KYC_DEMO=1`, or unconfigured, in which case the API answers 503 with the missing variable names. The demo vendors name themselves in the evidence and in the mark's regime, which is why production policy 1 rejects a sandbox mark. Connecting a rail turns the same flow into a production issuance; the per-rail steps are in [docs/07-kyc-vendors.md](docs/07-kyc-vendors.md).

Operator commands:

```sh
npm run vault:admin -- list
npm run vault:admin -- review-snapshot <record-id>
npm run vault:admin -- decide <record-id> cleared <reviewed-revision> <case-reference>
npm run rescreen                 # dry run against the current lists
npm run rescreen -- --publish    # commits decisions and queues revocations; requires RESCREEN_PRIVATE_KEY
npm run rescreen -- --publish --scheduled # one scheduled pass with durable redacted run evidence
npm run monitor:rescreen         # alerts on missing/stalled/failed scheduled passes; read-only
npm run vault:admin -- outbox    # pending source revocations
```

## Privacy boundary

On chain: wallet and issuer addresses; status, origin, kind, assurance, regime, jurisdiction, method bitmap, timestamps and epoch; `claimsRoot` and `evidenceHash`. Off chain: the declared identity and account inputs, the vendor fields, salted claim openings and a recomputable evidence chain, in the encrypted vault.

No name, date of birth, document number or account number is written on chain. Wallet-linked metadata and commitments are pseudonymous and linkable; this is pseudonymisation, not anonymity. The engineering position on Korean non-face-to-face KYC and data protection is [docs/08-regulatory-position.md](docs/08-regulatory-position.md).

## Build and verify

Requirements: Node.js, npm and Foundry.

```sh
git clone --recurse-submodules https://github.com/stabled-ai/proofmark.git
cd proofmark
npm ci
npm test                       # Solidity security/lifecycle and ZK gate tests
npm run test:ts                # TypeScript regression, including native provider modules
npm run test:providers         # Focused provider HTTP/state boundary tests
npm --prefix zk ci
npm run test:zk                # Fresh real proof, generated Solidity verifier and gate tests
npm run typecheck
npm run verify:submission      # read-only check of the hosted demo and deployed contracts

cd web && npm ci && npm run lint && npm run build
```

After the web production build, run `npm run test:winning-ui` from the repository root (Playwright Chromium required). This browser test intercepts provider/chain data as explicit fixtures; it does not establish live provider approval or new onchain issuance.

Refresh, build and evaluate the sanctions lists:

```sh
bash aml/fetch-lists.sh
npx tsx aml/build-index.ts
npx tsx aml/eval.ts
```

## Operate on testnet

```sh
cp .env.example .env
# set PROOFMARK_ISSUER_MODE=single-issuer: the v2 deploy preflight requires an explicit issuer mode
./script/deploy.sh preflight
./script/deploy.sh deploy

npm run worker:init-state                   # once, for a fresh dedicated worker signer
npm run worker                              # start before emitting source events
npx tsx script/demo-gate-issue.ts           # two marks in one Sepolia issueBatch
npx tsx script/publish-epoch.ts --dry-run   # rebuild the active set, self-check proofs
npx tsx script/publish-epoch.ts --publish   # one root on Sepolia, accepted on CC3
```

The contracts on testnet are the v1 build, tagged [`v1-live`](https://github.com/stabled-ai/proofmark/tree/v1-live). The worker and scripts at that tag operate them, and the demo kit targets them:

```sh
git worktree add ../attest-kyc-live v1-live
cd ../attest-kyc-live && npm ci && cp ../proofmark/.env .env
npm run worker
```

`main` carries the v2 contracts ahead of the redeploy: roster v2 hashing, atomic receipt processing, epoch schema 2 with issuer approvals, and fresh-roster witnesses for new assets. `npm run verify:submission` and `docs/demo-video/commands-v2.sh` are the strict checks for that deployment. The runbooks: [epoch and roster operations](docs/10-epoch-roster-runbook.md), [epoch freshness](docs/32-epoch-freshness.md), [issuer authorisation](docs/33-roster-issuer-authorization.md), [fresh-roster consumers](docs/34-fresh-roster-consumers.md), [roster proof availability](docs/39-roster-proof-availability.md).

## Roadmap

The next twelve weeks buy the four things a testnet cannot prove: an independent credential, a real buyer, managed operations and external review.

| Milestone | Delivers |
|---|---|
| Productise | v2 contracts redeployed with role separation; managed vault and KMS; provider adapter specification ([docs/17](docs/17-external-credential-adapter.md)) |
| Integrate | One external credential adapter on testnet; distributed rate limiting; a Creditcoin application in partner staging |
| Pilot | External security review; two design partners or one paid pilot; measured issue → propagate → revoke → gate SLA |

Not yet in place, and not claimed: a signed institutional vendor contract for the public sandbox, licensed PEP and adverse-media sources, a multi-instance managed evidence service, an external audit, Korean legal sign-off, and production key ceremonies. Reads stay free and permissionless; revenue attaches to issuer SLAs, issuance and rescreening, evidence operations and adapters. The CEIP proposal is a 12-week, USD 100k milestone program: [docs/11-investment-memo.md](docs/11-investment-memo.md).

## Repository map

| Path | Purpose |
|---|---|
| `src/` | Solidity: ASC, registry, source events, policy-gated note, roster proofs |
| `test/` | Foundry security and lifecycle tests |
| `worker/` | Source scanner, Attestcoin proof fetcher, durable retry state |
| `pipeline/` | KYC adapters, reconciliation, evidence, commitments, roster, vault |
| `pipeline/providers/` | Signed native provider client, webhook handling and durable session state |
| `zk/` | Isolated experimental circuit/proving toolchain; not provider or Attestcoin root integration |
| `aml/` | Official-list loaders, matcher, FATF table, evaluation corpus |
| `web/` | Next.js product and API journey |
| `script/` | Deployment, epoch, rescreen and vault operations |
| `deployments/` | Machine-readable testnet evidence |
| `docs/` | Protocol reviews, runbooks, regulatory position, deck, demo-video kit |

## License

MIT. See [LICENSE](LICENSE).
