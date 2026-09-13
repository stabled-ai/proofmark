import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readOnchainState } from './onchain-state.js';
import { StatusFixture } from '../test/fixtures/onchain-state.js';

test('all verdict, policy, version, provenance, issuer and witness reads use one rechecked block', async () => {
  const f = new StatusFixture(); const result = await readOnchainState(f.provider(), f.config());
  assert.ok(f.reads.length > 25); assert.ok(f.reads.every(r => r.blockTag === 100));
  assert.deepEqual(f.blockReads, ['latest', 100]); assert.equal(result.observation.blockHash, f.hash);
  assert.equal(result.registry.proofMode, true); assert.equal(result.mark.methods, 0);
  assert.equal(result.policies[0].decisionMark?.methods, 1 << 16, 'policy diagnostic must use witnessed leaf, not Direct mark');
  assert.equal(result.policies[0].diagnosis, 'consistent'); assert.deepEqual(result.policies[0].reasonCodes, []);
  assert.equal(result.propagation.hubTransaction, null);
});

test('reorg, chain/binding mismatch and required read failure return no verdict', async () => {
  for (const field of ['reorg', 'wrongBinding', 'chainId', 'failMethod'] as const) {
    const f = new StatusFixture();
    if (field === 'chainId') f.chainId = 1n; else if (field === 'failMethod') f.failMethod = 'getRosterWitness'; else f[field] = true;
    await assert.rejects(readOnchainState(f.provider(), f.config()));
  }
});

test('legacy boolean remains a raw chain response, never a current-schema safety explanation', async () => {
  const f = new StatusFixture(); f.legacy = true;
  const result = await readOnchainState(f.provider(), f.config());
  assert.equal(result.policies[0].verified, true); assert.equal(result.registry.proofMode, false);
  assert.equal(result.mark.issuerKeyUsable, false); assert.equal(result.mark.issuerKeyEpoch, 0);
  assert.equal(result.policies[0].diagnosis, 'unavailable'); assert.equal(result.witness, null);
  assert.deepEqual(result.policies[0].reasonCodes, ['LEGACY_OR_UNCONFIRMED_SCHEMA']);
});

test('missing/stale witness, approval, expiry, wrong kind and tombstone are explicit diagnostics', async () => {
  const scenarios: [string, (f: StatusFixture) => void][] = [
    ['AWAITING_ROSTER_WITNESS', f => { f.witnessEpoch = 0; }], ['STALE_ROSTER_WITNESS', f => { f.witnessEpoch = 2; }],
    ['ROSTER_NOT_FRESH', f => { f.fresh = false; }], ['ISSUER_ROOT_NOT_APPROVED', f => { f.approved = false; }],
    ['SUBJECT_TOMBSTONED', f => { f.tombstone = true; }], ['CREDENTIAL_EXPIRED', f => { f.attrs.expiry = f.now; }],
    ['WRONG_CREDENTIAL_KIND', f => { f.attrs.kind = 2; }], ['CREDENTIAL_TOO_OLD', f => { f.attrs.issuedAt = f.now - 3601; }],
  ];
  for (const [reason, change] of scenarios) {
    const f = new StatusFixture(); f.verified = false; change(f);
    const p = (await readOnchainState(f.provider(), f.config())).policies[0];
    assert.ok(p.reasonCodes.includes(reason), reason); assert.equal(p.verified, false); assert.equal(p.diagnosis, 'consistent');
  }
});

test('local diagnostic disagreement never overwrites the Registry verdict', async () => {
  const f = new StatusFixture(); f.verified = false;
  const p = (await readOnchainState(f.provider(), f.config())).policies[0];
  assert.equal(p.verified, false); assert.equal(p.diagnosis, 'unexplained');
  const g = new StatusFixture(); g.tombstone = true;
  const q = (await readOnchainState(g.provider(), g.config())).policies[0];
  assert.equal(q.verified, true); assert.equal(q.diagnosis, 'unexplained');
});
