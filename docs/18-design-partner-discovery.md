# Creditcoin design-partner discovery kit

> Updated 2026-09-07. Unsent outreach draft and blank interview kit, not partner evidence.
> Obtain a concrete application conversation with permission; do not claim an LOI or paid pilot.
> Record facts and objections exactly; silence is not interest. Public links below are historical
> reference locations, not a newly verified live demo or an authorization to contact anyone.

## Target profile

Prioritise a Creditcoin RWA, lending or stablecoin application that has all of these:

- wallet eligibility affects mint, transfer, borrow or redemption;
- the team expects more than one issuer, jurisdiction or screening refresh;
- an app-specific allowlist is already painful or becoming risky;
- a non-instant, failure-prone cross-chain update may fit at least one workflow, subject to measurement;
- a technical decision-maker can review a testnet integration.

Ask for the maximum acceptable revocation delay before proposing this architecture. Historical
single-run timings are not a current latency range or SLA. Compare a direct issuer or simple
allowlist when those meet the need; a more complex cross-chain path is not automatically better.

## Short outreach

> We are building a Creditcoin policy gateway for wallet eligibility. Our reference KYC flow is
> synthetic, and external issuer/customer integration is still a hypothesis. We have historical
> testnet evidence and newer local lifecycle tests; the local fixes are not deployed, and
> multi-issuer isolation remains unresolved. Could we discuss how you handle eligibility,
> revocation delays and evidence today, and whether reusable source credentials would help?
> We are asking for problem feedback, not production use or an endorsement.

Reference links to review before any authorized outreach:

- `https://attest-kyc.stabled.ai/onchain`
- `https://github.com/stabled-ai/proofmark`
- `docs/15-submission-evidence.md`

Include [current limitations](19-security-migration.md) and the [issuer-isolation decision](69-issuer-isolation-decision.md).
Do not invite real identity-document upload or asset movement. If offering a demonstration, first
verify its current safe scope and availability; do not copy the old “live” claim from a prior pitch.
The current deck is an internal diligence draft and still needs team/public-use approval.

## Twenty-minute interview

1. Which action needs eligibility: mint, receive, transfer, borrow, redeem or all of them?
2. Who is legally or operationally responsible for the allow/deny decision?
3. Which checks, issuer types and jurisdictions are required today?
4. What is the maximum acceptable age of a credential?
5. How quickly must a sanctions hit or revocation block the next action?
6. What happens when the KYC provider, RPC or policy service is unavailable?
7. How do you update policy without unexpectedly changing rules for existing assets?
8. Would you accept a reusable external credential, or must your institution run KYC itself?
9. Is source-event publication on Ethereum acceptable to your provider and privacy counsel?
10. What would make one registry call preferable to your current allowlist or vendor API?
11. Who would operate evidence retention, appeals and audit export?
12. What testnet result would justify a second integration meeting?

Do not lead with pricing. After the workflow is concrete, test the charging surface: integration
fee, annual SLA, issuance, active wallet/rescreen or evidence operations.

## Note template

```md
# Discovery note — <organisation or anonymised label>

- Date/time:
- Participants and roles:
- Permission to name publicly: yes / no
- Application and chain:
- Gated action:
- Current eligibility mechanism:
- Required checks / issuers / jurisdictions:
- Credential freshness requirement:
- Revocation deadline:
- Attestcoin latency acceptable for this workflow: yes / no / conditional
- Credential reuse and source publication acceptable: yes / no / unknown
- Evidence/controller owner:
- Integration blocker:
- Commercial owner and likely charging unit:
- Agreed next step, owner and date:
- Exact quote approved for public use, if any:
```

## Evidence threshold

| Evidence | What may be claimed |
|---|---|
| Message sent | Outreach started |
| Meeting held with completed note | One design-partner discovery interview |
| Staging scope and named owners agreed | Design partner identified |
| Signed LOI | LOI |
| Customer pilot payment with matching agreement, service scope and payment record | Paid pilot; accounting treatment requires review |

Grants, investment proceeds, team transfers and testnet activity are not customer revenue.
An invoice alone is not payment, and payment alone does not prove completed delivery or renewal.

Anything below the corresponding row must not be promoted to the stronger claim.
