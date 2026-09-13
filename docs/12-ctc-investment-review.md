# Proofmark CTC ecosystem, hackathon, and investment diligence review

> Review date: 2026-09-02
>
> Perspective: Creditcoin ecosystem business development, hackathon judging, and early-stage investment
>
> Conclusion: **75/100 — award contender; recommend a conditional USD 100,000 milestone pilot**
>
> Disclaimer: This is product, technical, and commercial diligence. It is not legal advice or a certification of regulatory compliance.

## 1. Executive summary

Proofmark is a compliance gateway that makes external KYC and AML results reusable on Creditcoin
and lets each application evaluate those results against its own frozen policy.

The project is not yet compelling as a stand-alone South Korean KYC provider: it has no independent
regulated-provider contract, paying customer, licensed data, or external security audit. Its stronger
and more defensible definition is:

> Infrastructure that proves facts checked by an existing credential issuer through Attestcoin,
> carries them to Creditcoin, and consistently enforces RWA, lending, and stablecoin policies on-chain.

The current product goes beyond a UI mock-up and demonstrates that it can:

- verify Sepolia issuance events through Attestcoin and materialize them on Creditcoin CC3;
- transfer `KPCN` only between addresses that pass the frozen sandbox policy;
- reject a transfer to an unissued address with `RecipientNotVerified`;
- reject the same mark under a production policy that requires a different regime;
- verify both inclusion and non-inclusion against an epoch roster through live contract calls; and
- provide a public application, public repository, reproducible CI, investment memo, and pitch deck.

For a hackathon, this is an **award-level submission in chain integration, security depth, and demo
completeness**. For investment, commercial and operational risk exceeds technical risk. The right
next step is therefore a 12-week validation of an external credential and a real buyer, not funding
the entire roadmap at once.

## 2. Final assessment

### 2.1 Investment score

| Category | Weight | Score | Assessment |
|---|---:|---:|---|
| Creditcoin and Attestcoin necessity | 20 | 19 | BlockProver verifies the source transaction, removing reliance on a separate operator oracle |
| Technical completeness | 20 | 18 | Contracts, worker, policy-gated asset, roster, web product, and testnet evidence form one path |
| Security and correctness | 20 | 16 | Ordering, replay, sanctions precedence, policy freezing, and forged non-inclusion are addressed; no external audit yet |
| Product clarity | 15 | 12 | Verify -> Prove -> Enforce is clear, but the public demo must be explicitly labeled as sandbox |
| Go-to-market evidence | 15 | 5 | Buyer and pricing hypotheses exist, but there is no LOI, paid pilot, or revenue |
| Regulatory and operational readiness | 10 | 5 | Consent, retention, erasure, and rescreening are designed; managed operations and legal review remain open |
| **Total** | **100** | **75** | **Recommend a narrow, staged pilot investment** |

### 2.2 Hackathon judgment

**Recommend advancing Proofmark to the shortlist and treating it as an award candidate.** Three
qualities distinguish it from a typical hackathon submission:

1. Attestcoin source proofs are essential to the product, rather than Creditcoin serving only as a deployment network.
2. The demo proves failure paths for the wrong policy, an unissued recipient, stale state, and forged non-inclusion, not just a success screen.
3. Live testnet transactions, a policy-gated asset, epoch operations, a public web app, and reproducible CI form one submission.

The project must not claim that it is production-ready compliance infrastructure. The public flow
creates a `regime = 2` sandbox mark through demo adapters, and production policy 1 deliberately
rejects that mark.

## 3. Product definition and ecosystem fit

### 3.1 Problem addressed

A credential provider answers what it checked. A Creditcoin application must still decide:

- whether it trusts the issuer;
- whether every method required by the asset was performed;
- whether the result is production or sandbox;
- whether jurisdiction, assurance, and issuance age satisfy its policy;
- whether the result remains valid after sanctions or revocation; and
- whether the subject belongs to the current roster.

Proofmark owns this **normalization, proof, and policy-enforcement layer**, rather than the underlying
credential issuance itself.

```text
External credential issuers
  |-- South Korean reference issuer — implemented
  |-- Sumsub / CCID adapter — target
  |-- zkMe adapter — target
  `-- Regulated institution / financial provider adapter — target
          |
Normalize method + assurance + regime + jurisdiction + issuer
          |
Ethereum source event -> Attestcoin proof -> Creditcoin ASC
          |
Frozen application policy
          |
RWA / lending / stablecoin mint and transfer gate
```

On-chain reads should remain free and permissionless. Revenue should come from issuer SLAs,
issuance and rescreening, evidence-vault operations, adapters, and policy operations. This aligns
with [Attestcoin's public read model](https://attestcoin.org/).

### 3.2 Competitive position

| Alternative | Strength | Where Proofmark can win | Current Proofmark disadvantage |
|---|---|---|---|
| [Sumsub + Chainlink CCID/ACE](https://sumsub.com/newsroom/sumsub-partners-with-chainlink-to-power-cross-chain-identity-for-on-chain-compliance/) | Global verification operations, enterprise distribution, reusable credentials | Creditcoin- and Attestcoin-native provenance, asset-specific frozen policies, and roster semantics | Vendor coverage, customers, and production credentials |
| [zkMe zkKYC](https://www.zk.me/credentials/zkkyc/) | Zero-knowledge credentials, selective disclosure, broad attribute product | Creditcoin source-transaction proofs and a concrete asset-enforcement path | ZK privacy, country coverage, and adoption |
| Direct KYC or bank integration | Authoritative source checks and existing contracts | One normalization layer reused by multiple Creditcoin applications | Proofmark ultimately needs the same integrations and permissions |
| Per-application allowlist | Simple and fast | Portability, freshness, issuer and regime controls, revocation, and auditability | More complexity for a small, single application |

The method bitmap alone is not a moat. The durable defense must be the combination of **issuer
normalization, proven provenance, policy semantics, lifecycle operations, and Creditcoin application
integrations**.

## 4. Technical diligence

### 4.1 Live deployment

[`deployments/cc3-testnet.json`](../deployments/cc3-testnet.json) is the deployment source of truth.

| Component | Network | Address |
|---|---|---|
| `EvmV1Decoder` | Creditcoin CC3 | `0x5eE29aB8845A2AD4BBE1e01c5BD3bCc3AEee47Fd` |
| `ProofmarkASC` | Creditcoin CC3 | `0x3C6Fe016645CA52952E29C66E435bDa7F611b242` |
| `ProofmarkRegistry` | Creditcoin CC3 | `0x2F4E5e1270f90E51251651caf08547393e3C0572` |
| `ComplianceSource` | Ethereum Sepolia | `0xA9A34586303b9fD92e090F9bb1D332DC854c72B9` |
| `GatedRwaNote` (`KPCN`) | Creditcoin CC3 | `0xa74aB3De359a55A729f9185Fe4Afe90526E585CA` |

### 4.2 Live cross-chain and asset-gate evidence

- The [Sepolia issuance transaction](https://sepolia.etherscan.io/tx/0x290498028010e6ce5f75de3d69695091e24863423e01a7981a277db86c8d69f1) issued two sandbox marks.
- The worker's [CC3 materialization transaction](https://creditcoin-testnet.blockscout.com/tx/0x50c30b315f74150fecf56b670a5d6c9cf7dc0bc76c815809dbc6af899de567d8) succeeded.
- After minting 100 `KPCN` to verified holder A, holder A [transferred 40 `KPCN` to verified holder B](https://creditcoin-testnet.blockscout.com/tx/0xefe550ff98e513b8c6cd7fa8541fd1d7d0f33197b149fb674df8acba7aa9aa0d).
- A transfer simulation to an unissued control address reverted with `RecipientNotVerified` selector `0x17887111`.
- Epoch 1 was [published on Sepolia](https://sepolia.etherscan.io/tx/0x2adefae22bd29e7fc43b9f9161f6c722cc2deb4eae6bc720aca5a2b65e7816df) and [accepted on CC3](https://creditcoin-testnet.blockscout.com/tx/0xb011cd6e5a590b924858262cdfc832a6ef0d71cc4b78c3ac61efaf3d0c2f532f).
- Observed propagation between source and destination block timestamps was 8 minutes 00 seconds.
- Sandbox policy 2 membership returned `true`, production policy 1 returned `false`, and non-membership for an unissued address returned `true`.

The epoch root, input marks, validity period, and verdicts remain reproducible from
[`deployments/epoch-1.json`](../deployments/epoch-1.json).

### 4.3 Core security properties

| Risk | Implemented defense |
|---|---|
| Wrong source or emitter | Set the source chain key and source contract once, then prohibit changes |
| Proof replay | Permanently consume query IDs and source request IDs |
| Reversed order within one block | Use a `(source block height, transaction index)` cursor |
| Revival by an older issuance | Reject state older than the subject's source cursor |
| Downgrading a sanctions denial | Prevent ordinary issuance or revocation from clearing sanctions denial |
| Irrecoverable ordinary revocation | Permit only a newer full issuance to reactivate a non-sanctions revocation |
| Policy rug | Permit production consumers to bind only to frozen policies |
| Wrong regime, jurisdiction, or issuer | Explicit policy checks for all three fields |
| Forged roster gap | Re-hash boundary keys with their marks and verify adjacency |
| Unilateral recovery or recovery to an unverified address | Require proposal, distinct approval and delay; recheck transfer recipient at execution |
| Lost state after worker restart or failure | Atomic storage and pending-retry scheduling |

These controls are not a production-funds guarantee before an external audit. One testnet key
currently performs deployer, issuer, and multiple operational roles. Production must separate
deployer, issuer, policy owner, epoch publisher, worker payer, and asset-recovery roles through
managed keys or multisigs.

## 5. AML, privacy, and operational diligence

### 5.1 AML data and measurements

The system uses 26,566 entries and 78,365 names from official OFAC, UN, and EU source files. The
European Commission maintains the consolidated financial sanctions list and describes the dataset
as updated daily on the [EU Data Portal](https://data.europa.eu/data/datasets/consolidated-list-of-persons-groups-and-entities-subject-to-eu-financial-sanctions?locale=en).

Current regression results:

| Test | Result |
|---|---:|
| Listed-person recall | 200/200 |
| Clean-name specificity | 610/610, 0 false positives |
| Invisible-character, homoglyph, diacritic, and related evasions | 7/7 blocked |
| Ethereum wallet present on an official list | Blocked |

This is an engineering regression corpus, not regulatory certification. No licensed PEP or adverse-
media source is connected, so the corresponding method bits correctly remain unset.

The FATF jurisdiction table was checked against the official June 2026 publications: [plenary
outcomes](https://www.fatf-gafi.org/en/publications/Fatfgeneral/outcomes-fatf-plenary-june-2026.html),
[jurisdictions under increased monitoring](https://www.fatf-gafi.org/en/publications/High-risk-and-other-monitored-jurisdictions/increased-monitoring-june-2026.html),
and [high-risk jurisdictions subject to a call for action](https://www.fatf-gafi.org/en/publications/High-risk-and-other-monitored-jurisdictions/call-for-action-june-2026.html).

### 5.2 Privacy boundary

The on-chain record contains:

- wallet and issuer addresses;
- status, assurance, regime, jurisdiction, method bitmap, timestamps, and epoch; and
- `claimsRoot` and `evidenceHash`.

It does not contain names, dates of birth, document numbers, or account numbers. Wallet and
metadata remain linkable pseudonymous data, however, and must not be described as anonymous data.

The off-chain pilot vault supports AES-256-GCM encryption, keyed pseudonymization, retention purge,
erasure audit events, rescreening, and manual-appeal state. The vault is disabled on Vercel's
ephemeral filesystem, and non-demo issuance fails closed when no persistent vault is available.

Production requires a managed database and KMS, backup and recovery, access controls, data-controller
agreements, a retention policy, and South Korean legal review. See
[`docs/08-regulatory-position.md`](08-regulatory-position.md) for the detailed position.

## 6. Product and demo diligence

### 6.1 Public surfaces

- Product: [attest-kyc.stabled.ai](https://attest-kyc.stabled.ai)
- On-chain status: [attest-kyc.stabled.ai/onchain](https://attest-kyc.stabled.ai/onchain)
- Verification flow: [attest-kyc.stabled.ai/verify](https://attest-kyc.stabled.ai/verify)
- Public code: [github.com/stabled-ai/proofmark](https://github.com/stabled-ai/proofmark)
- CI evidence: [GitHub Actions](https://github.com/stabled-ai/proofmark/actions)

The production web deployment was Ready and its API function was observed in Seoul region `icn1`.
Vercel also identifies `icn1` as Seoul in its [regions documentation](https://vercel.com/docs/regions).

### 6.2 Honest limits of the public demo

- The ID and bank adapters are demos and do not connect to an institution.
- Demo results can create only `regime = 2`.
- Production policy 1 requires `regime = 1`, so it rejects demo marks.
- Production issuance does not proceed without a persistent evidence vault.
- A successful public flow proves the UX and protocol path, not completion of a real customer's KYC.

This distinction is both a limitation and a source of credibility: the system records only checks
that actually ran in its method and regime fields.

## 7. Verification results

The technical baseline for this review was commit `c12db5eaf7b7c7db1a6cd65c6dc4ad1054c3e80c`.

| Verification | Result |
|---|---:|
| Foundry Solidity tests | 57/57 |
| TypeScript worker, pipeline, AML, and vault tests | 123/123, 0 skipped |
| TypeScript typecheck | Passed |
| Web lint and production build | Passed |
| npm production vulnerability audit | 0 |
| URL smoke test | 12/12 |
| Malicious cross-origin POST | HTTP 403 |
| Git-history secret scan | Passed, 0 leaks |
| Clean clone with recursive submodules | Passed |
| Public GitHub CI | Solidity, TypeScript/AML, and web jobs passed |

## 8. Business model and go-to-market

### 8.1 Charging surfaces

| Product | Charging unit | Buyer |
|---|---|---|
| Issuer platform and SLA | Annual contract | Regulated issuer, RWA platform, or lender |
| Credential issuance | Per completion, with vendor cost passed through | Issuer or application |
| Continuous compliance | Active wallet per month or rescreen event | Issuer or asset operator |
| Evidence vault and audit export | Annual tier plus storage | Obligated entity |
| Provider or jurisdiction adapter | Implementation fee plus maintenance | Provider or ecosystem project |
| Policy integration and governance | Project fee plus support | Creditcoin application |

The first market should be measured through two integrations, not an inflated global TAM:

1. a Creditcoin RWA, lending, or stablecoin application that consumes a policy; and
2. an independent issuer or provider that supplies an external credential.

Success means a live end-to-end pilot, a signed operating model, measured SLA data, and a priced
renewal proposal.

### 8.2 Business-development priorities

1. Secure one Creditcoin application that needs mint or transfer eligibility as a design partner.
2. Connect one external credential from Sumsub, CCID, zkKYC, or a regulated institution through an adapter.
3. Measure issue -> propagate -> consume -> rescreen -> revoke/reactivate in partner staging.
4. Keep on-chain reads free and monetize operations, evidence, and SLAs.

## 9. Investment proposal

The proposal is a **USD 100,000, 12-week milestone pilot**. It falls within the [USD 25,000 to
500,000 range published by CEIP](https://creditcoin.org/Fund). This is an application proposal, not
an award or funding already raised.

| Tranche | Amount | Release condition |
|---|---:|---|
| 1. Productize | $25k | Managed vault/KMS design, role separation, adapter specification, threat model, and one design-partner discovery memo |
| 2. Integrate | $35k | External credential adapter, distributed API controls, rescreening and appeal runbook, and partner sandbox integration |
| 3. Pilot | $40k | Remediation from external security review, two design partners or one paid pilot, SLA measurement, and production launch decision |

Recommended use of funds is engineering 55%, security review 15%, compliance, legal, and vendor
work 15%, partner integration 10%, and operations and reporting 5%. Token liquidity and broad paid
marketing should not be funded at this stage.

## 10. Investment gates and kill criteria

### Tranche gates

- Release tranche 2 only after documenting a credible external issuer or provider path and an application design partner.
- Release tranche 3 only after an external credential, rather than Proofmark's reference issuer, completes the live testnet path.
- Approve production launch only after resolving every critical and high finding from an external contract review.

### Stop or pivot conditions

Stop follow-on investment or pivot to an adapter SDK and integration business if any of the
following remains true by week 8:

- no Creditcoin application integrates even with funded support;
- credential providers prohibit credential reuse or source-event publication;
- legal review identifies operational or privacy duties that target customers cannot accept;
- managed evidence operations are structurally more expensive than direct vendor integration; or
- Attestcoin propagation or credential freshness cannot meet the selected asset's risk window.

## 11. Final investment-committee view

Proofmark is a technically strong Creditcoin-native infrastructure experiment. Code and live
evidence have reduced much of the protocol risk, but commercial proof does not yet exist.

The right investment does not pay a premium for traction that is already present. It is a limited
investment in four unproven hypotheses: **an independent credential, a real buyer, managed
operations, and external review**.

If those hypotheses are validated within 12 weeks, Proofmark can absorb repetitive KYC integration
and allowlist operations across Creditcoin applications into shared infrastructure. If they are not,
the technical assets may remain valuable, but follow-on investment in an independent compliance
company should pause.

## 12. Diligence materials

- Product and deployment status: [`README.md`](../README.md)
- Investment memo: [`docs/11-investment-memo.md`](11-investment-memo.md)
- Pitch deck: [`docs/deck/proofmark-deck.pdf`](deck/proofmark-deck.pdf)
- Regulatory and privacy position: [`docs/08-regulatory-position.md`](08-regulatory-position.md)
- ASC security review: [`docs/09-ascbase-security-findings.md`](09-ascbase-security-findings.md)
- Epoch operations runbook: [`docs/10-epoch-roster-runbook.md`](10-epoch-roster-runbook.md)
- Current deployment: [`deployments/cc3-testnet.json`](../deployments/cc3-testnet.json)
- Epoch 1 evidence: [`deployments/epoch-1.json`](../deployments/epoch-1.json)
