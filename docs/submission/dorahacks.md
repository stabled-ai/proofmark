# DoraHacks BUIDL page — copy to paste

Field-by-field text for the BUIDL CTC 2026 Fall submission form, in the order the form asks. Paste,
do not rewrite at the deadline. Every claim below has a source in this repository; the ones that
need a public URL are marked. Team fields are per person and must be confirmed by each person.

---

## Project name

Proofmark

## Tagline

The compliance gateway for Creditcoin. Verified once on Ethereum, enforced by every Creditcoin asset, revoked everywhere in minutes.

## Sector / track

RWA

## Project description

**Proofmark is a compliance gateway for Creditcoin.** A KYC/AML credential is issued on Ethereum,
proven to Creditcoin through the Attestcoin Protocol, and enforced by a tokenised asset's own
transfer check. No relayer key, no oracle operator, no admin on the hot path.

### The problem

Every tokenised asset carries the same obligation: know who holds it, at issuance and every day
after. On chain that has three bad answers today. Per-app KYC rebuilds the vendor contract, the PII
flow and the evidence retention for every asset and chain. A reusable "KYC passed" boolean hides
what was checked, by whom, under which regime, how long ago, and whether it is still true. A
cross-chain copy makes a relayer's signing key the compliance truth. And when a holder is revoked,
the asset usually finds out never.

### What Proofmark does

- **Verify.** A guided flow runs wallet control (EIP-4361 signature bound to a consent version), an
  ID document check, a bank account check (holder name + ₩1 transfer) and sanctions screening
  against OFAC, UN and EU source lists. Only the checks that ran set a bit. Korean regulatory rails
  are integrated in code (CODEF for Government24 document authenticity and OCR, KFTC Open Banking
  for the bank account); the public sandbox runs labelled demo adapters for those two axes and says
  so on the page, in the evidence, and in the mark's on-chain regime field.
- **Prove.** The issuer emits `MarkIssued` on Ethereum Sepolia: a method bitmap, assurance level,
  regime, jurisdiction and two 32-byte commitments. No name, birth date, document or account number.
  Our Attestcoin Source Contract on Creditcoin CC3 verifies the inclusion proof for that exact source
  transaction through the BlockProver precompile and materialises the mark.
- **Enforce.** `ProofmarkRegistry.isVerified(wallet, policyId)` evaluates a frozen policy: required
  methods, minimum assurance, maximum age, regime, jurisdiction, trusted issuer, optional roster
  freshness. `GatedRwaNote`, a tokenised credit note, calls it on both sender and recipient in every
  transfer and reverts with `RecipientNotVerified` or `SenderNotVerified`.

### What you can see running now

- The same mark, two frozen policies, two answers: Korea's production policy returns `false`
  because the mark honestly says sandbox; the pilot policy returns `true`.
- 40 KPCN moved between two verified wallets on CC3; a transfer to an unissued wallet reverts.
- A revocation sent on Ethereum tombstones the mark on Creditcoin, after which the same holder can
  no longer send or receive the note. Nobody touches Creditcoin to make that happen.
- Epoch roster mode: the whole active set as one Merkle root, published on Sepolia and accepted on
  CC3 8 minutes later, with inclusion and non-inclusion proofs answered by the registry.
- Observed end-to-end propagation across three runs: 7m 55s to 10m 48s. The demo video labels
  the wait; it never claims instant.

Live: [attest-kyc.stabled.ai](https://attest-kyc.stabled.ai) · on-chain state at `/onchain` ·
guided flow at `/verify`. Every verdict in the video is reproducible read-only with
`bash docs/demo-video/commands.sh`.

### Security depth

We attacked the state machine, not just the happy path: same-address-wrong-chain, stale-proof
resurrection, sanctions denial downgrades across all 24 delivery orders, policy mutation under a
live asset, forged roster non-membership, API replay and worker crash recovery. 118 Solidity and
583 TypeScript tests. While integrating we found two high-severity gaps in Attestcoin's `ASCBase`
(the handler cannot see the source chain key or the source ordering), fixed them in our fork
`ASCBaseX` with mutation tests, and documented them for the protocol team
(`docs/09-ascbase-security-findings.md`). Our own September review found two v1 defects in the
deployed contracts (denial ordering, roster non-membership); both are fixed and regression-tested in
the repository, and the v2 redeploy is the first funded milestone.

### Why Creditcoin

Every RWA, lending and stablecoin launch on Creditcoin repeats the same holder-eligibility work.
Proofmark replaces it with one frozen policy and one read, and gives existing credential issuers
one Creditcoin integration that reaches every application. Reads stay free and permissionless;
revenue attaches to issuer SLAs, issuance and rescreening, evidence operations and adapters.

### Team · Validator Inc.

- **Ash Han, CEO.** Founded and ran GDAC, a Korean digital-asset exchange, through VASP
  registration, ISMS certification and FinCEN MSB. Interchain ecosystem background.
- **Youree Lee, Ph.D, Chief Compliance Officer.** Wrote the AML/KYC policy and handled supervisory
  examinations at GDAC's operator. Prior banking roles.
- **Yongku Lee, CTO.** Exchange core, wallet, custody and security systems at production scale.
- **Incheol Yang, Product / protocol.** Exchange core and non-face-to-face KYC integration;
  Solidity across DEX protocols. Proofmark implementation lead.

This team has already done regulated KYC/AML in Korea's non-face-to-face regime: written the
policy, passed the examinations, run the exchange. Proofmark is that operating knowledge encoded as
contracts. The operating history belongs to the prior company and the individuals; Validator Inc.
does not claim those licences.

### What we are not claiming

Not production-ready, not audited, not anonymous (wallet-linked metadata and commitments are
pseudonymous and linkable), no statistical latency SLA, no live institutional vendor contract in the
public sandbox, no revenue or awarded funding. The next 12 weeks are for exactly those proofs.

---

## Attestcoin Protocol integration summary

Proofmark issues KYC/AML marks on Ethereum Sepolia and makes Creditcoin CC3 the chain of record for
them. **Remove Attestcoin and what is left is a relayer we operate**, which is exactly the trust the
product exists to remove. The protocol is what makes an off-chain compliance decision checkable on
another chain without trusting us.

| Without Attestcoin | With Attestcoin |
|---|---|
| A Proofmark-run signer copies marks to Creditcoin; that key is the compliance truth | `ProofmarkASC` verifies the Sepolia transaction's inclusion and continuity through BlockProver; the source event is the truth |
| Revocation depends on our operator noticing and signing | Anyone can submit the proof of a `MarkRevoked` event; the ASC tombstones the subject on its own |
| Policy consumers trust an allowlist admin | Policy consumers read `isVerified` against state that only a proven source event can change |

Where the protocol is used:

1. **`ProofmarkASC` on CC3** (`0x3C6Fe016645CA52952E29C66E435bDa7F611b242`) extends our fork
   `ASCBaseX`. `execute()` verifies the proof through `VERIFIER.verifyAndEmit`, then the handler pins
   `expectedChainKey = 1` (Sepolia) and `sourceContract`, decodes the receipt with `EvmV1Decoder`,
   filters logs by signature, and applies `MarkIssued`, `MarkRevoked`, `SanctionDenied` and
   `RosterEpochPublished` under a per-subject `(blockHeight, txIndex)` cursor. All events of one source
   transaction apply in one Creditcoin block.
2. **The worker** (`worker/`) scans `ComplianceSource` on Sepolia, waits for attested height, fetches
   the inclusion proof, and submits it. Jobs are persisted atomically and requeued on every poll, so a
   crash cannot strand a revocation. The worker holds no compliance authority; a second worker, or a
   judge, can submit the same proof.
3. **Deploy-time preflight** reads chain keys from the ChainInfo precompile rather than hardcoding
   them: Sepolia is chainKey 1, not chainId 11155111. `configureSource` is one-time; the ASC rejects
   every proof before it is set.
4. **Batching.** `ComplianceSource.issueBatch` and `revokeBatch` put N events in one source
   transaction, so one `execute()` applies all N. Epoch rosters put the whole active set behind one
   proven root, with inclusion and non-inclusion answered on chain.

Two protocol findings came out of the integration. Upstream `ASCBase.execute()` receives `chainKey`
and `blockHeight` and forwards neither to `_processAndEmitEvent`, so a derived contract can neither
pin its source chain nor order what it applies; a same-address contract on a second attested chain
passes as the trusted emitter, and a stale issuance proof resurrects a revoked mark. `ASCBaseX`
widens that one internal signature and changes nothing else; mutation tests pin both guards. The
report is `docs/09-ascbase-security-findings.md`, offered to the protocol team under MIT.

Reads are free on Attestcoin, and we claim no ATC demand from them. Testnet evidence: Sepolia
`issueBatch` `0x29049802…8d69f1`, CC3 `execute()` `0x50c30b31…567d8`, epoch 1 accepted in
`0xb011cd6e…532f`. Setup and reproduction: README, `docs/submission/integration-summary.md`,
`npm run verify:submission`.

---

## Links (each needs to open in a private window)

| Field | Value | Status |
|---|---|---|
| GitHub repository | https://github.com/stabled-ai/proofmark | confirm public and pushed |
| Deck (PDF URL) | `docs/deck/proofmark-deck.pdf` — host as a GitHub release asset or in the repo raw URL | needs a public URL |
| Demo video URL | not recorded yet — kit in `docs/demo-video/` | record, upload unlisted, validate with `internal/validate-video-url.sh` |
| Live product | https://attest-kyc.stabled.ai | live |
| On-chain state | https://attest-kyc.stabled.ai/onchain | live |
| Logo (optional) | export the seal-ring mark from `web/components/ui/Logo.tsx` as PNG | optional |

## Team fields, per member

Name · email · short bio (use the four bios above) · role · country of residence · country of
citizenship. Each person confirms their own row; the repository does not establish any of it.
