# Experimental private eligibility proof

A real Groth16 proof of membership in an authorized four-leaf credential set, with private country, birth day, expiry and credential opening. The statement checks allowed country and age, binds the holder and current epoch, and derives a presentation nullifier. This is a local prototype, not production KYC/AML or an Attestcoin integration.

From the repository root, after installing the root dependencies and Foundry:

```sh
npm --prefix zk ci
npm run test:zk
```

This compiles the circuit, creates a **local test-only** setup, generates a proof, verifies it with snarkjs, rejects four invalid witnesses, and executes the freshly generated verifier/proof pair in an isolated Foundry project under ignored `build/`. It then runs the checked-in gate's adversarial tests. Ordinary tests do not overwrite the reviewed Solidity verifier or proof fixture; circuit changes require updating that pair together.

## Public statement

| Index | Value |
|---|---|
| 0 | Context-specific nullifier |
| 1 | Active credential root |
| 2 | Frozen policy ID |
| 3, 4 | Allowed country alternatives |
| 5 | Maximum birth day (integer days since Unix epoch) |
| 6 | Holder wallet address |
| 7 | Application context |
| 8 | Current epoch |
| 9 | Presentation deadline (Unix seconds) |

The application context is `keccak256(abi.encode(block.chainid, address(gate), actionDomain)) % Fr`. A proof builder must query the gate's `expectedApplicationId()`; the fixture's hard-coded address/context must not be reused for deployment. Holder, application and timing remain public and linkable. The nullifier prevents reuse of the same context; a new deadline creates another context, so this is not a general one-person/one-action system.

`ZkKycPolicyGate` validates proof, caller, policy, current epoch, root revocation/freshness, deadline and nullifier. Its root authority is a local authenticated fixture boundary. It does not authenticate a real provider decision or receive Attestcoin proofs, and it does not by itself perform an RWA transaction. The current circuit proves country/age/expiry, not sanctions matching, PEP, media or transaction exposure.

Production work remains: approved credential issuance/root pipeline, provider step evidence,
ongoing revocation propagation, audited ceremony and circuit, scalable membership tree, holder
witness custody, measured proving cost and target-chain compatibility. See the
[toolchain security limitations](SECURITY.md).
