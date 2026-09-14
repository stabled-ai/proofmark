# Proofmark

> Verify once. Let every chain READ it. Let every asset enforce it.

**Vision:** Proofmark turns KYC/AML into a chain-neutral READ primitive that every chain can reuse and every asset can enforce.

**Track:** RWA

Proofmark is the compliance READ layer for onchain finance. It lets one verified holder state serve many assets and chains while each asset keeps control of its own eligibility policy.

![Proofmark multi-chain READ architecture](https://raw.githubusercontent.com/stabled-ai/proofmark/main/docs/submission/proofmark-read-architecture.png)

## The problem

Every RWA, stablecoin and lending market must decide whether a wallet may hold or receive an asset at that moment.

App-specific KYC does not scale. Each issuer must rebuild vendor contracts, personal-data flows, evidence retention and rescreening. A reusable `KYC passed` flag is too weak because it omits who performed the checks, which checks ran, which regime applied, how old the result is and whether the holder was later revoked. Copying that flag across chains adds a relayer whose signing key becomes the compliance authority.

Compliance is read-heavy. Credentials change occasionally, but an asset may check eligibility on every transfer. Proofmark turns one verified compliance state into a shared READ surface, so one issuer and one rescreening pipeline can serve many assets and chains.

## The protocol

Proofmark separates evidence from policy and policy from enforcement.

The **credential layer** records what an issuer verified. A mark contains the issuer, method bitmap, assurance level, regime, jurisdiction, timestamps and two cryptographic commitments. Names, birth dates, document numbers and bank-account numbers stay offchain. The mark does not pretend that one definition of KYC fits every jurisdiction.

The **policy layer** lets each asset decide what those facts mean. A frozen policy specifies required checks, minimum assurance, trusted issuer, accepted regime and jurisdiction, maximum age and optional roster freshness. The same credential can pass a sandbox pilot and fail a production RWA because each asset applies its own rules to the same source facts.

The **enforcement layer** puts the decision inside the asset. `ProofmarkRegistry` exposes one READ:

`isVerified(wallet, policyId)`

Our reference tokenised credit note calls it for both sender and recipient inside every transfer. An ineligible, expired, sanctioned or revoked holder cannot send or receive the asset.

## How it works

1. **Verify.** The holder signs an EIP-4361 wallet message bound to the consent version and verification flow. Proofmark runs the configured identity, bank-account and sanctions checks. Only completed checks set method bits. Demo checks remain labelled as sandbox, so a production policy rejects them automatically.

2. **Issue.** `ComplianceSource` publishes `MarkIssued`, `MarkRevoked`, `SanctionDenied` and roster-epoch events on Ethereum Sepolia. Direct credentials carry policy facts and commitments without placing defined cleartext identity fields onchain. Batch issuance and revocation spread source and proof costs across multiple holders.

3. **Prove.** A durable worker observes the Ethereum event, waits until Attestcoin has attested the source block and fetches the inclusion proof. It submits public proof material to `ProofmarkASC` on Creditcoin CC3. The worker holds no compliance authority and can be replaced by any other submitter.

4. **Read.** Attestcoin's `BlockProver` verifies the Ethereum receipt inside Creditcoin execution. `ProofmarkASC` pins the source chain key and source contract, decodes the full receipt and orders lifecycle events by proven source coordinates. An old issuance proof cannot restore a credential after a later revocation.

5. **Enforce.** `ProofmarkRegistry` evaluates the verified state against the asset's frozen policy. `GatedRwaNote` calls that result during transfer. A source-chain revocation changes the answer for every asset that reads the policy without requiring an administrator to update each asset.

6. **Scale.** Direct marks work for individual credentials. Merkle roster epochs compress an active holder set into one proven root, with onchain inclusion and non-inclusion checks. Issuers can move from individual issuance to large, continuously screened populations without changing the READ interface.

## One READ for every chain

The product is designed around one stable question with shared semantics: `is wallet X eligible under policy Y?`

The public deployment currently proves Ethereum state into Creditcoin CC3. Creditcoin is the first verification hub, and the working consumer is a Creditcoin RWA. The next distribution step is a set of spoke readers that exposes the same verified root and policy semantics to assets on additional chains. As Attestcoin supports more source chains, Proofmark can also accept credentials from more origins without rebuilding its compliance model.

This creates an asymmetric network. One issuer integration can serve many applications. One application can accept multiple approved issuers. One revocation can update every downstream reader. Adding a chain requires the same READ interface against verified state, not another KYC stack.

Cross-chain READ is Proofmark's core product. KYC becomes reusable infrastructure when every chain can consume the same verified facts while every asset continues to enforce its own policy locally.

## Attestcoin Protocol Integration Summary

Proofmark uses Attestcoin as the trust layer for cross-chain compliance READs. It turns a KYC/AML event created on Ethereum into state that a Creditcoin smart contract can verify and enforce without trusting a Proofmark-operated oracle.

`ComplianceSource` first issues the holder's lifecycle event on Ethereum Sepolia. A worker waits for Attestcoin to attest that block, obtains the inclusion and continuity proof and submits the public proof material to `ProofmarkASC` on Creditcoin CC3. The worker only transports proof, so another submitter can replace it without changing the Ethereum event that remains the source of truth.

Attestcoin's `BlockProver` verifies the Ethereum receipt during Creditcoin execution. `ProofmarkASC` accepts events only from the configured source chain key and source contract, then materialises issuance, revocation, sanctions-denial and roster state into `ProofmarkRegistry`. Creditcoin applications consume the result through `isVerified(wallet, policyId)`.

Compliance is a strong use case for Attestcoin because the state is high-value, changes relatively slowly and may be read on every asset transfer. Source authenticity, lifecycle ordering and reliable revocation matter more than millisecond latency or cross-chain asset custody. One attested credential can therefore support many policy checks without copying personal data, wrapping assets or trusting a relayer.

The integration also tested Attestcoin at its security boundary. We found that the upstream `ASCBase` event handler did not pass enough source-chain and ordering context to the application handler. Our minimal `ASCBaseX` fork forwards the chain key, block height and transaction index. Regression tests cover wrong-chain proofs, stale-proof restoration and lifecycle ordering. Batch issuance and revocation apply multiple holder events through one source transaction and one Creditcoin execution, while Merkle roster epochs compress a large active set into one proven root.

The live path is Ethereum to Creditcoin today. Additional source chains and spoke readers are the next distribution layer. The model remains the same across every chain: verify once, READ everywhere and enforce locally.

## What is live

The [public product](https://attest-kyc.stabled.ai) runs on Ethereum Sepolia and Creditcoin CC3. A [batched issuance on Sepolia](https://sepolia.etherscan.io/tx/0xcad8aa328fdefb00fd0a07c30b9d34264c21ada2bf270c1fd5b5a1552940ac40) was materialised through Attestcoin in [Creditcoin transaction `0xb490…2392`](https://creditcoin-testnet.blockscout.com/tx/0xb490b654f9b829169cd6c32c46d02b556422ef99f42ebbe301a3d41fbca62392). An issuer-approved roster epoch then crossed in [Creditcoin transaction `0xf2bd…7741`](https://creditcoin-testnet.blockscout.com/tx/0xf2bda1c6faeb881885f3f6f91851a1bb72f9db41ea7b3d3b5cf2de8cb2e37741). With current holder witnesses, the note [transferred 40 KPCN](https://creditcoin-testnet.blockscout.com/tx/0x9a93786c134f38364ece73589d1d739e946ac93441bc08ae6d8e0ef1a0a49f29) between two verified holders and rejected a never-issued wallet with `RecipientNotVerified`.

Direct credentials and Merkle-roster mode are live in the v2 deployment. The repository contains public contracts, runtime hashes, transaction records, read-only reproduction commands and source-bound regression evidence. The current suite passes 133 Solidity tests and 687 TypeScript/API tests.

Security tests cover wrong-chain proofs, stale lifecycle delivery, denial ordering, policy mutation, malformed non-inclusion, request replay and worker crash recovery. Our September review found two defects in the retired v1 testnet build. Both are fixed, regression-tested and deployed in the current v2 contract set.

## Why this can become a business

The first buyers are RWA issuers, stablecoin operators and lending markets that need wallet eligibility without operating a complete KYC stack on every chain. Credential providers gain one route into many applications. Applications gain one policy interface across approved providers.

Reads remain open and permissionless. Revenue sits around the regulated work: issuer platform contracts, credential issuance, continuous rescreening, evidence operations, provider and jurisdiction adapters, policy integration and service-level agreements. Every new issuer expands the evidence supply, while every new asset adds another consumer.

![Proofmark compliance network effect](https://raw.githubusercontent.com/stabled-ai/proofmark/main/docs/submission/proofmark-network-effect.png)

Creditcoin is the initial market because Attestcoin already provides the foreign-state proof path and RWA applications need compliance infrastructure. Expansion is chain-neutral: standardise the READ, distribute the verified root and keep policy enforcement local to each asset.

## Why our team

Proofmark is built by Validator Inc., a Korean blockchain financial-infrastructure company developing stablecoin issuance, distribution, Proof of Reserve and AML/KYC systems.

The core team comes from GDAC and brings seven years of direct experience operating a regulated Korean digital-asset exchange. As a team, we built exchange core systems, wallets, custody, non-face-to-face KYC, AML and fraud controls, evidence operations and institutional APIs. We completed Korea's fourth VASP registration, exchange-and-custody ISMS certification, FinCEN MSB registration, bank due diligence and regulatory examinations. GDAC served more than 400 corporate members, so the team learned these requirements under production volume and institutional scrutiny.

Validator has continued that work at the infrastructure layer. The company has built token issuance and redemption contracts, real-time reserve reconciliation, wallet and administrator products, an AML command center, travel-rule processing, freeze and burn controls, gasless transaction flows and post-quantum dual-signature integration. In 2026, Validator completed a QSSN Sepolia proof of concept with iM Bank, Finger and MCC covering issuance, bank-reserve reconciliation, bank-system integration, governance circuit breakers and post-quantum signature consistency.

Compliance policy, exchange operations, bank integration and smart-contract engineering sit inside one team. Proofmark comes from problems we have already operated: duplicated KYC, stale screening results, fragmented evidence and eligibility rules that must survive beyond onboarding.

The registrations and certifications above belonged to GDAC's prior operator and remain separate from Validator. Validator carries the team's operating experience and engineering record.

## Current scope and next milestones

Proofmark is a testnet product. The public flow uses labelled demo adapters for institutional identity and bank rails. The current v2 contracts are deployed on Ethereum Sepolia and Creditcoin CC3, while production spoke readers on additional chains remain a deployment milestone.

The next milestones are specific: connect an external credential provider, move keys and evidence storage into managed infrastructure, complete an independent security review and integrate the first external asset and issuer. These milestones turn the working protocol into a regulated pilot with measurable issuance, revocation and rescreening service levels.

## Links

- [Live product](https://attest-kyc.stabled.ai)
- [Onchain state](https://attest-kyc.stabled.ai/onchain)
- [Global identity verification](https://attest-kyc.stabled.ai/verify/provider)
- [GitHub repository](https://github.com/stabled-ai/proofmark)
- [Attestcoin Protocol](https://attestcoin.org)
