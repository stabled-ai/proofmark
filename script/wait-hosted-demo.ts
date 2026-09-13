import { setTimeout as delay } from 'node:timers/promises';

const [originArg, snapshotId, epochArg] = process.argv.slice(2);
if (!originArg || !snapshotId || !epochArg || !/^[0-9a-f]{64}$/.test(snapshotId) || !/^[1-9]\d*$/.test(epochArg)) {
  throw new Error('usage: wait-hosted-demo HTTPS_ORIGIN SNAPSHOT_ID EPOCH');
}
const origin = new URL(originArg);
if (origin.protocol !== 'https:' || origin.username || origin.password || origin.pathname !== '/' || origin.search || origin.hash) {
  throw new Error('hosted demo must be an HTTPS origin');
}
const expectedEpoch = Number(epochArg), timeoutMs = 20 * 60_000, started = Date.now();
let last = 'no response';

while (Date.now() - started < timeoutMs) {
  try {
    const [screenResponse, onchainResponse] = await Promise.all([
      fetch(new URL('/api/screen', origin), { signal: AbortSignal.timeout(30_000), cache: 'no-store' }),
      fetch(new URL('/api/onchain', origin), { signal: AbortSignal.timeout(30_000), cache: 'no-store' }),
    ]);
    const screen = await screenResponse.json(), onchain = await onchainResponse.json();
    const hostedSnapshot = screen?.sourceSnapshot?.snapshotId;
    const hostedEpoch = onchain?.epoch?.latestEpoch;
    const witnessEpoch = onchain?.witness?.epoch;
    const pilot = onchain?.policies?.find((policy: { id?: number }) => policy.id === 2);
    if (screenResponse.ok && onchainResponse.ok && hostedSnapshot === snapshotId && hostedEpoch === expectedEpoch &&
        onchain?.epoch?.fresh === true && witnessEpoch === expectedEpoch && pilot?.verified === true && pilot?.diagnosis === 'consistent') {
      console.log(`hosted demo is current: snapshot ${snapshotId}, epoch ${expectedEpoch}, pilot PASS`);
      process.exit(0);
    }
    last = `screen ${screenResponse.status}/${hostedSnapshot ?? 'none'}, onchain ${onchainResponse.status}/epoch ${hostedEpoch ?? 'none'}/witness ${witnessEpoch ?? 'none'}`;
  } catch (error) { last = (error as Error).message; }
  console.log(`waiting for hosted deployment: ${last}`);
  await delay(15_000);
}
throw new Error(`hosted demo did not converge within 20 minutes: ${last}`);
