# Consume Proofmark from a Creditcoin application

The application-side integration is one read:

```solidity
if (!registry.isVerified(subject, POLICY_ID)) revert SubjectNotVerified();
```

Use [`src/examples/ProofmarkConsumer.sol`](../../src/examples/ProofmarkConsumer.sol) as the copyable
contract example. It also refuses to bind to a mutable policy, preventing the policy owner from
changing an asset's rules after deployment.

Read an independently reviewed compatible deployment without a wallet or private key. First
export `CREDITCOIN_RPC_URL`, `REGISTRY_CONTRACT_ADDRESS`, `ASC_CONTRACT_ADDRESS`,
`SOURCE_CONTRACT_ADDRESS`, `DEMO_REGISTRY_CODEHASH` and `DEMO_ASC_CODEHASH` from the application's
approved release configuration. The two `DEMO_*` names reuse the existing runtime-pin settings;
they are required even outside the demo. Do not obtain pins by copying the checked RPC's code
hash just to pass this check. No `.env` or historical deployment fallback is loaded.

```sh
npx tsx examples/consumer/check.ts \
  0x4816B6e3Acb775f65Da888f185f708E2C8D7a3e2 2
```

Both subject and positive decimal policy ID are required; policy IDs retain full uint256 precision.
The reader verifies the actual hub chain, approved runtime hashes, supported schemas, Registry/ASC/
source binding, policy existence, typed kind and frozen status at one block. It returns the full
policy and observation block/hash/time with the actual Registry boolean, then rechecks the block
and chain before returning. It supports explicitly selected frozen Direct or roster policies,
with a warning about their different freshness guarantees. It does not infer which policy a
customer should approve or whether the entire policy is legally suitable.

`verdict: accepted` / `verified: true` and `verdict: rejected` / `verified: false` both exit 0:
the read completed, not the eventual asset transaction. Unknown subject, revocation, expiry,
missing methods/issuer/regime/jurisdiction or absent/stale witness can produce a genuine false.
No particular rejection reason is invented from that boolean. A configuration, RPC, runtime,
schema, binding, mutable/unknown policy or observation failure exits 2 with `verdict: unavailable`,
`verified: null` and a fixed error code; it must not be treated as a cached prior success or an
ordinary negative credential. Remote diagnostics are not printed. The executable boundary cases
live in [`pipeline/consumer-verdict.test.ts`](../../pipeline/consumer-verdict.test.ts).

The working-tree [`GatedRwaNote`](../../src/GatedRwaNote.sol) applies the check to both sender and recipient, with explicit owner recovery paths. **New deployments require a frozen `requireRoster=true` policy and `ROSTER_WITNESS_VERSION=1`.** The historical public token is an older Direct-mode build and has not acquired this protection.

For a new high-risk consumer, deliver each holder's current issuer-approved roster inclusion before calling a storage-only gate:

```ts
import { ethers } from 'ethers';
import { encodeRosterWitness, requireRosterWitness, ROSTER_WITNESS_ABI } from '../../pipeline/roster-witness.js';

// provider, registryAddress, subject and the approved epochRecord are explicit integration inputs.
await requireRosterWitness(provider, registryAddress);
const prepared = encodeRosterWitness(epochRecord, subject);
const registry = new ethers.Contract(registryAddress, ROSTER_WITNESS_ABI, provider);
await registry.cacheRosterWitness.staticCall(...prepared.args); // read-only simulation
const transactionRequest = { to: registryAddress, data: prepared.data };
// Submit transactionRequest only through an explicitly authorized caller/wallet workflow.
// Encoding/simulation alone writes no witness and cannot open the gate.
```

No issuer private key is needed to deliver an already-approved membership proof. At execution the Registry validates the current root, issuer authorization, freshness and tombstone again. On every `isVerified` call it applies the consumer policy to the cached mark. A new epoch invalidates the old witness even if the root repeats; expiry cannot be extended by recaching. Direct ASC provenance is not rewritten. Both sender and recipient need witnesses for the same current epoch.

An issuer process is also unnecessary for **reconstructing a previously distributed proof**. Use
the [content-addressed bundle tooling](../../pipeline/roster-bundle.ts): export a current epoch
record to a reviewed destination, copy the hash-named file before any outage, and reconstruct
proofs locally or from the local HTTP replica. These files expose wallet-linked credential fields;
do not upload real rosters without distribution approval.

```ts
import { readFileSync } from 'node:fs';
import { loadRosterBundle } from '../../pipeline/roster-bundle.js';
import { checkBundleProof } from '../../pipeline/roster-bundle-chain.js';

const proof = loadRosterBundle(readFileSync(bundlePath), expectedContentHash).proof(subject);
// trustedScope is independent application configuration, not copied from the fetched proof.
const checked = await checkBundleProof(provider, trustedScope, proof, policyId);
if (checked.eligible && checked.transaction) {
  // Present checked.transaction to the authorized wallet; this example does NOT submit it.
  // Re-evaluate the consumer gate in the eventual asset transaction.
}
```

An accepted non-inclusion proof returns `eligible: false`. A successful inclusion simulation is not a stored witness. RPC failure, schema mismatch, expiration or a newer epoch is not permission to fall back to an older bundle or Direct credential.

The [connected local bundle test](../../pipeline/roster-bundle-chain.test.ts)
executes the exported bundle → current-chain check → explicitly authorized local wallet witness
transaction → token gate path. It also sends an old request after an epoch change and checks the
actual reverted receipt. That demonstrates why a successful earlier simulation must not be
treated as execution authorization. The wallet and both chains are synthetic local fixtures,
not a browser integration or public deployment; the library never signs or sends for the caller.

The generic `ProofmarkConsumer.sol` remains an example for arbitrary frozen policies, including
weaker Direct policies; it is not automatically suitable for high-risk assets. Choosing a
permissive policy does not establish continued screening freshness. High-risk consumers should
require the current issuer-approved roster and fail closed when the witness is missing or stale.

[`deployments/cc3-testnet.json`](../../deployments/cc3-testnet.json) documents a historical release.
It is not automatically trusted by this reader and has not acquired the working-tree schema fixes.
