# DoraHacks BUIDL page: copy to paste

Field-by-field text for the BUIDL CTC 2026 Fall submission form, in the order the form asks. Paste,
do not rewrite at the deadline. Every claim below has a source in this repository; the ones that
need a public URL are marked. Team fields are per person and must be confirmed by each person.

---

## Project name

Proofmark

## Tagline

Verify once. Let every chain READ it. Let every asset enforce it.

## Vision

Proofmark turns KYC/AML into a chain-neutral READ primitive that every chain can reuse and every asset
can enforce.

## Sector / track

RWA

## Details

Use the copy button on this plain-text block. It contains no Markdown tables, links, bullets or inline
code that can break in the DoraHacks editor.

```text
Proofmark makes one KYC/AML state readable by every asset across every chain.

Today, our public deployment proves Ethereum state into Creditcoin CC3. The product direction is chain-neutral: Creditcoin becomes the verification hub, while other chains consume the same verified registry through one standard READ interface as spoke support rolls out. Every chain should be able to ask the same question: is wallet X eligible under policy Y? The answer comes from proven source state, while transport workers hold no compliance authority.

WHY THIS MATTERS

Compliance is a read-heavy problem. A credential changes occasionally, but every asset transfer may need to check it. Rebuilding KYC on each chain multiplies vendor contracts, personal-data handling, evidence storage and rescreening operations. Copying a KYC passed flag across chains creates stale, inconsistent answers and turns the copying relayer into the authority.

Proofmark changes the unit of integration. One issuer and one rescreening pipeline can serve many assets and chains. A single revocation updates the state every reader consumes. Applications read policy-relevant facts and commitments, while names, birth dates, document numbers and bank-account numbers stay off chain.

THE IDEA

A Proofmark credential carries evidence instead of a universal verdict. It records the issuer, checks performed, assurance, regime, jurisdiction, timestamps and cryptographic commitments. Each asset owns a frozen policy that defines what it accepts. The same credential can pass a sandbox product and fail a production RWA because the assets ask different questions of the same facts.

HOW IT WORKS

Verify: The user signs an EIP-4361 message bound to the consent version. The flow runs configured identity, bank-account and sanctions checks. Only completed checks set method bits, and demo checks remain labelled as sandbox.

Prove: ComplianceSource emits the credential on Ethereum Sepolia. A worker fetches the Attestcoin proof and submits it to ProofmarkASC on Creditcoin CC3.

Read: Attestcoin's BlockProver verifies the Ethereum receipt. ProofmarkRegistry exposes one call, isVerified(wallet, policyId), that evaluates the proven state against an asset-owned policy.

Enforce: GatedRwaNote calls that READ for both sender and recipient inside every transfer. A proven revocation or sanctions denial blocks the holder wherever the policy is used.

The ASC accepts state only from the pinned source chain and contract. Proven source ordering prevents an old issuance from resurrecting a revoked credential. For larger holder sets, Proofmark publishes one Merkle root and verifies inclusion or non-inclusion against a fresh roster epoch.

WHY PROOFMARK IS A NATIVE ATTESTCOIN USE CASE

Attestcoin is strongest when an application needs to trust a fact from another chain without trusting the operator who carried it. Proofmark needs exactly that guarantee. Compliance state is high-value, slow-changing and read many times, so authenticity, ordering and revocation matter more than millisecond latency or asset custody.

Attestcoin supplies the trust model. Once a source block is attested, BlockProver verifies the credential inside Creditcoin execution. The worker can disappear or be replaced because it only transports public proof material. One verification supports every later READ, which matches the economics of cross-chain compliance.

As Attestcoin adds supported chains, Proofmark can accept credentials from more origins without rebuilding the compliance product. As Proofmark adds spoke readers, assets on other chains can consume the same verified root and policy semantics. The result is a shared compliance state instead of another chain-specific KYC silo.

WHAT EXISTS TODAY

The live product at https://attest-kyc.stabled.ai proves issuance and revocation from Ethereum Sepolia to Creditcoin CC3 through Attestcoin. A policy-gated credit note accepts eligible holders and rejects unissued or revoked wallets. Direct credentials and Merkle-roster mode are both implemented, with recorded propagation between 7m 55s and 10m 48s. Contracts, transactions and read-only reproduction commands are public.

TEAM

Proofmark is built by Validator Inc., a Korean blockchain financial-infrastructure company focused on stablecoin issuance, distribution and compliance. The core team previously built and operated GDAC, a regulated Korean digital-asset exchange. We know the cost of duplicating KYC, the operational weight of rescreening and the risk of stale eligibility because we have handled them as operators.

CURRENT SCOPE

The public deployment verifies the Ethereum-to-Creditcoin READ path. Production spoke readers on additional chains remain the next deployment step. The public build uses labelled demo adapters for institutional identity and bank rails, and the contracts have not received a production audit.
```

---

## Attestcoin Protocol Integration Summary

Use the copy button on this plain-text block.

```text
Proofmark uses Attestcoin as the trust layer for cross-chain compliance READs.

ComplianceSource issues KYC/AML credentials on Ethereum Sepolia. Our worker waits until the source block is attested, fetches its inclusion proof and submits that proof to ProofmarkASC on Creditcoin CC3. Attestcoin's BlockProver verifies the Ethereum receipt inside Creditcoin execution. ProofmarkASC then materialises issuance, revocation, sanctions-denial and roster events into ProofmarkRegistry.

The worker has no compliance authority. Anyone can submit the same public proof, while the ASC accepts state only from the pinned source chain and contract. Proven source ordering prevents a stale issuance from overwriting a later revocation. We also added these missing chain and ordering inputs to our minimal ASCBaseX fork and regression-tested wrong-chain and stale-proof attacks.

Creditcoin assets consume the verified state through one call: isVerified(wallet, policyId). Each asset owns a frozen policy covering required checks, issuer, regime, jurisdiction and freshness. Our reference RWA calls this READ for both sender and recipient inside every transfer. A revocation proven once from Ethereum changes the answer for every asset using that policy.

This is a strong fit for Attestcoin because compliance is high-value, slow-changing and read many times. It needs proof, source authenticity and lifecycle ordering more than millisecond latency or asset movement. One attested credential can serve many policies and assets without copying personal data or trusting a relayer.

The public deployment proves the Ethereum-to-Creditcoin path today. The product direction is chain-neutral. As Attestcoin expands source-chain support, Proofmark can accept credentials from more origins. Spoke readers will let assets on additional chains consume the same verified root and policy semantics. The core model is to verify once, READ everywhere and enforce locally.
```

---

## Links (each needs to open in a private window)

| Field | Value | Status |
|---|---|---|
| GitHub repository | https://github.com/stabled-ai/proofmark | confirm public and pushed |
| Deck (PDF URL) | `docs/deck/proofmark-deck.pdf` — host as a GitHub release asset or in the repo raw URL | needs a public URL |
| Demo video URL | not recorded yet — kit in `docs/demo-video/` | record, upload unlisted, validate with `internal/validate-video-url.sh` |
| Live product | https://attest-kyc.stabled.ai | live |
| On-chain state | https://attest-kyc.stabled.ai/onchain | live |
| Logo (optional) | `docs/submission/proofmark-dorahacks-profile.png` | ready |

## Team fields, per member

Each member enters their own name, email, role, country of residence and citizenship. Do not copy
personal biographies from the company deck into the public Details field.
