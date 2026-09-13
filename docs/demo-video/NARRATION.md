# Demo video — narration

English voiceover keyed to the scene numbers in [SHOTLIST.md](SHOTLIST.md). Two minutes at a calm
150 words per minute is 300 words; the lines below total about 290. Read them slowly. The
numbers are the product's numbers, each with its provenance in this repository, and the wait is
never described as quick.

The narration body is every blockquoted line below. To check the budget:

```sh
grep '^> ' docs/demo-video/NARRATION.md | sed 's/^> //' | wc -w      # budget 300
```

---

## 1 · Cold open — 8s

> A tokenised credit note on Creditcoin just refused a transfer. No admin, no allowlist. It read a
> fact from Ethereum.

*On screen: the revert, then the title card.*

## 2 · Live sanctions screening — 14s

> Proofmark starts with screening, and this part is real. Three sanctions lists, 26,566 entries,
> parsed from source. A listed name, corroborated by date of birth: block, risk band five.

*On screen: the Kim Jong Un preset, BLOCK, the OFAC SDN entry, the unset PEP and adverse-media bits.*

## 3 · Guided issuance — 22s

> Onboarding: wallet signature, ID document, bank account, then screening. Only the checks that ran
> set a bit. In this public sandbox the ID and bank vendors are labelled demo adapters, and the mark
> says so on chain. The mark lands on Ethereum Sepolia as a bitmap and two commitments. No name, no
> birth date, no account number.

*On screen: the four steps, the `demo:id` / `demo:bank` rows, ISSUED, the Sepolia transaction.*

## 4 · The crossing — 12s

> Attestcoin proves that Ethereum block to Creditcoin. Our contract verifies the inclusion proof
> itself; no relayer signs anything. Take Attestcoin away and this becomes a bridge you would have to
> trust.

*On screen: the worker log, the caption "edited — cross-chain propagation took about 9 minutes",
then `/onchain` showing the mark ACTIVE and the verifier's pins.*

## 5 · One mark, two policies — 16s

> Now the point. One mark, two policies, two answers. Korea's production policy says no, because the
> mark honestly says sandbox. The pilot policy says yes. Both policies are frozen on chain. Nobody can
> loosen an asset's rules after the fact.

*On screen: `isVerified(A, 1)` false, `isVerified(A, 2)` true, `policyFrozen` true and true.*

## 6 · The gate — 16s

> The gate. Verified wallet to verified wallet: the notes move. To an unverified wallet, the token's
> own check says no and the transfer reverts: recipient not verified. Not an allowlist. A credential
> that crossed a chain boundary.

*On screen: `canTransfer` true then false, `0x17887111`, the live transfer at status 1.*

## 7 · Revocation travels — 22s

> Then the part a regulator cares about. The issuer revokes holder A on Ethereum. A rescreen hit, an
> expired document, whatever the reason: it is a code on the event. About nine minutes later, with
> nobody touching Creditcoin, the same wallet can no longer move the note. Sender not verified.
> Revocation travels too.

*On screen: the Sepolia `revoke` receipt, the caption with the measured wait, `tombstone` true,
`canTransfer` false, `0x8677c1af`, then `/onchain` showing REVOKED.*

## 8 · Close — 10s

> Proofmark. Verified once. Enforced by every asset. Revoked everywhere. Live on Creditcoin and
> Ethereum testnets. Run it yourself at attest-kyc dot stabled dot ai.

*On screen: the title card and the URL.*

---

## Numbers this narration may use

| Number | Provenance |
|---|---|
| 26,566 entries | OFAC SDN 19,321 + UN 1,011 + EU 6,234, the built index the hosted deployment serves |
| risk band five | `POST /api/screen` for the preset, verified 2026-09-07 |
| "about nine minutes" | historical v1 deployment records: issuance 7m 55s to 10m 48s, one revocation 8m 43s, and epoch 1 in 8m 00s |
| "N minutes" in the scene-7 caption | the elapsed time `commands.sh` prints when the tombstone lands in that take |

If a scene needs a figure that is not in this table, cut the claim, not the provenance.

## Things not to say

- **Never "anonymous"** or "zero data". Wallet and issuer addresses plus commitments are linkable.
  The accurate claim is that no cleartext identity or bank field is written on chain.
- **Never "instant"**, "real-time" or "under nine minutes".
- **Never "sanctioned"** for scene 7 unless a `deny` was sent. The scene sends a `revoke`.
- **Never describe the demo vendors as anything but demo vendors.** Scene 3 says the word on camera.
- **Never a second product name.** The product is Proofmark.
