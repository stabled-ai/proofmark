# Demo video — shot list, the two-minute cut

Two minutes, eight scenes, one wallet's life: verified, admitted, refused, revoked. Everything on
screen is the hosted deployment `https://attest-kyc.stabled.ai` and the two public testnets. The
narration is [NARRATION.md](NARRATION.md), and the public read-only checks are in
[commands-v2.sh](commands-v2.sh). Run `npm run verify:submission` before recording.

## What the two minutes have to make an investor feel

The competition scores Attestcoin depth. The CEIP judges score whether this is a company. The cut
has to do both without a slide, so each scene carries one of these five points and nothing else:

| # | The point | Where it lands | Why it is a "wow" and not a feature |
|---|---|---|---|
| 1 | **The asset itself says no.** A tokenised note reverts a transfer to a wallet nobody checked | Scene 1 cold open, scene 6 | Compliance is usually a form and a promise. Here it is a revert selector anyone can reproduce with `eth_call` |
| 2 | **One mark, two policies, two answers.** The same credential fails Korea's production policy and passes the pilot policy, and both policies are frozen | Scene 5 | Every competitor ships "KYC passed: yes". Proofmark ships "here is what was checked; your asset decides". Portability becomes a return value |
| 3 | **Nobody in the middle.** The mark was issued on Ethereum and Creditcoin verified the Ethereum block itself | Scene 4 | Remove Attestcoin and the product is a bridge the team operates. That sentence is the integration-depth score |
| 4 | **Revocation travels.** The issuer revokes on Ethereum; nine minutes later the note refuses the same holder on Creditcoin, and no one touched Creditcoin | Scene 7 | Onboarding KYC is table stakes. An asset that learns a holder was revoked, on another chain, without an admin key, is the thing regulated issuers actually pay for |
| 5 | **It is live. Run it.** | Scene 8 | The URL is the proof. Judges can reproduce every verdict in the video with the read-only script |

Screening (scene 2) is the on-ramp: a name everybody recognises gets blocked by real OFAC data in
one click. It buys the credibility the next six scenes spend.

Team, market and the ask stay out of the video. They live in the deck and the DoraHacks text.

## Scenes

Total 120 seconds. Narration is budgeted at 150 words per minute.

| # | Scene | Sec | On screen | Source |
|---|---|---|---|---|
| 1 | Cold open | 8 | The scene-6 refusal footage, cut to the front: `canTransfer` false, then the revert `0x17887111 RecipientNotVerified`. Title card "Proofmark" fades over it | `SCENES=1` (free call) |
| 2 | Live sanctions screening | 14 | `$DEMO_URL/` in the browser. Click "Kim Jong Un · KP", run. Hold on BLOCK, risk band 5, `OFAC_SDN` entry `20157`, `corroborated: dob`. One scroll to "Checks performed" so the unset PEP and adverse-media bits are visible | browser, `SCENES=2` |
| 3 | Guided issuance | 22 | `$DEMO_URL/verify` with a throwaway wallet: 0 Wallet control (sign), 1 ID document (`demo:id`), 2 Bank account (bank list, `demo:bank`, the one-won code), 3 Screen and issue → ISSUED with the Sepolia tx. Speed-ramp typing; hold two seconds each on the `demo:` vendor rows, the regime line and the tx hash. Cut to Etherscan: status Success, `MarkIssued` | browser, `SCENES=3` |
| 4 | The crossing | 12 | Worker log scrolling. Full-frame caption **"edited — cross-chain propagation took about 9 minutes"**. Cut to `$DEMO_URL/onchain` for holder A: ACTIVE, "Same mark, two policies", then the Verifier panel (chain key 1, source contract) | worker terminal, browser, `SCENES=4` |
| 5 | One mark, two policies | 16 | Terminal: `isVerified(A, 1)` false, `isVerified(A, 2)` true, `policyFrozen` true / true, `policies(1)` fields. Split-screen with the /onchain FAIL / PASS cards if the editor allows | `SCENES=5` |
| 6 | The gate | 16 | Terminal: `canTransfer(A, B)` true, `canTransfer(A, control)` false, the free call reverting with `0x17887111`, then the live `transfer` of 10 KPCN landing status 1. Cut to Blockscout for the receipt | `SCENES=6`, `RECORD=1` |
| 7 | Revocation travels | 22 | Terminal: `revoke(A, 2 RESCREEN_HIT, epoch)` sent on Sepolia, status 1. Etherscan `MarkRevoked`. Caption **"edited — propagation took about N minutes"** with N from the take. Then `tombstone(A)` true, `canTransfer(A, B)` false, the same transfer reverting `0x8677c1af SenderNotVerified`. Cut to `/onchain`: REVOKED · tombstone | `SCENES=7`, `RECORD=1` |
| 8 | Close | 10 | Title card: "Proofmark — Verified once. Enforced by every asset. Revoked everywhere." Under it `attest-kyc.stabled.ai` and "Live on Creditcoin CC3 Testnet · Ethereum Sepolia" | `SCENES=8` |
| | **Total** | **120** | | |

## Two takes and one wallet

- **Holder A** (`0x4816B6e3…`) is the wallet of the film from scene 4 on. Its mark must have crossed
  to CC3 before recording starts (PREFLIGHT h). It holds KPCN, passes policy 2, fails policy 1.
- **Scene 3 is filmed live with a throwaway wallet.** Its mark will not have crossed by the time
  scene 4 rolls; the caption says so, and scene 4 shows holder A. Do not imply the on-camera wallet
  and holder A are the same wallet; the narration never does.
- **Scene 6 before scene 7, always.** Scene 7 revokes holder A. After it, A cannot send or receive
  KPCN until a fresh issuance crosses. Re-recording either scene means re-issuing (PREFLIGHT h).
- The revocation wait is real. Start `RECORD=1 SCENES=7` and keep the terminal recording while it
  polls; the script prints the elapsed time when the tombstone lands. That number goes into the
  caption. Never shorten the caption to sound faster than the take.

## What each scene must not do

- **Scene 2.** Do not call the screening "AML compliance". It is list screening against three
  official lists; PEP and adverse media are unset and the screen shows that.
- **Scene 3.** The `demo:id` and `demo:bank` rows must be legible and the narration says the word
  "demo". The mark discloses the same thing on chain in its regime field.
- **Scene 4.** No speed ramp without the caption. Never "instant", never "real-time".
- **Scene 5.** `isVerified` is on `ProofmarkRegistry`; `getMark` and `tombstone` are on `ProofmarkASC`.
  Calling one on the other's address is the mistake that looks like a bug on camera.
- **Scene 6 and 7.** Keep `--from` on every gated call. Without it `msg.sender` is zero, `onlyOwner`
  fires first and the frame shows `0x118cdaa7 OwnableUnauthorizedAccount`: the wrong error.
- **Scene 7.** Say "revokes"; do not say "sanctioned" unless a `deny` was actually sent. Reason code 2
  is a rescreen hit, which is a decision the issuer took, not a list match shown on camera.
- **Scene 8.** Do not say anonymous or zero data. Wallet, issuer, method metadata and commitments are
  public and linkable; the accurate claim is no cleartext personal fields on chain.

## If a live transaction fails on camera

Scenes 6 and 7 send real transactions. Every transaction the video needs has already happened once;
cut to the explorer rather than retrying on camera, and narrate it as an earlier run.

| What | Chain | Transaction | Status |
|---|---|---|---|
| `issueBatch`, the two current marks | Sepolia | `0x290498028010e6ce5f75de3d69695091e24863423e01a7981a277db86c8d69f1` | 1 |
| Worker `execute()` materialising them | CC3 | `0x50c30b315f74150fecf56b670a5d6c9cf7dc0bc76c815809dbc6af899de567d8` | 1 |
| Mint 100 KPCN to verified A | CC3 | `0xa1f3b9fa62419b0352376d633b703442830d95a45179772825e44397342f8e77` | 1 |
| Transfer 40 KPCN from A to verified B | CC3 | `0xefe550ff98e513b8c6cd7fa8541fd1d7d0f33197b149fb674df8acba7aa9aa0d` | 1 |
| Epoch 1 published | Sepolia | `0x2adefae22bd29e7fc43b9f9161f6c722cc2deb4eae6bc720aca5a2b65e7816df` | 1 |
| Epoch 1 accepted, 8m 00s later | CC3 | `0xb011cd6e5a590b924858262cdfc832a6ef0d71cc4b78c3ac61efaf3d0c2f532f` | 1 |

There is no prior on-chain revocation for holder A. If scene 7's transaction fails, the fallback is
the 2026-08-30 revocation observation retained in the v1 deployment history (8m 43s), narrated as
a measurement, not as footage.

## Cast

| Address | Role |
|---|---|
| `0x4816B6e3Acb775f65Da888f185f708E2C8D7a3e2` | Holder A. Passes policy 2, fails policy 1, holds KPCN. Revoked in scene 7 |
| `0x77858131d1E0eAaAe2c38c2cce508c358C9b58ee` | Recipient B. Passes policy 2, holds KPCN |
| `0x00000000000000000000000000000000DeaDBeef` | Unissued control. The gate refuses it; both policies fail |
| throwaway wallet | Scene 3 only. Any address you do not mind publishing |

## Frame notes

- 1920×1080, 30 fps. Terminal font large enough for a laptop: about 24 visible lines, not 50.
- Browser in a clean profile: no bookmarks bar, no extensions, no other tabs, no autofill.
- The `/verify` flow has a resident registration number field. Use the synthetic sample preset and
  keep keystroke overlays off.
- Cut the RPC latency between `cast` calls. It changes no claim and buys the seconds scene 7 needs.
- Captions in the product's type: Inter, white on black, lower third, held for the whole cut.
- Music under, never over: the narration carries every number.
