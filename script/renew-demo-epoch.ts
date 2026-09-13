/**
 * Scheduled testnet epoch renewal.
 *
 * This is deliberately a one-shot command. An external scheduler supplies one exclusive run,
 * persistent encrypted state paths and dedicated testnet role keys. The command skips while the
 * current epoch has enough life remaining, publishes one new source epoch when due, waits for the
 * existing USC worker, and refreshes every current roster witness on CC3.
 */
import 'dotenv/config';
import { appendFileSync, existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { ethers } from 'ethers';

import { loadLists } from '../aml/loader.js';
import { encodeRosterWitness, requireRosterWitness, ROSTER_WITNESS_ABI } from '../pipeline/roster-witness.js';

const SOURCE_ABI = ['function lastEpoch() view returns (uint32)'] as const;
const ASC_ABI = [
  'function latestEpoch() view returns (uint32)',
  'function epochValidUntil() view returns (uint40)',
  'function epochRoots(uint32) view returns (bytes32)',
  'function isRosterFresh() view returns (bool)',
] as const;
const REGISTRY_READ_ABI = [
  ...ROSTER_WITNESS_ABI,
  'function isVerified(address subject,uint256 policyId) view returns (bool)',
] as const;

const required = (name: string): string => {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
};

const positiveInteger = (name: string, fallback: number, maximum: number): number => {
  const raw = process.env[name]?.trim() || String(fallback);
  if (!/^\d+$/.test(raw)) throw new Error(`${name} must be a positive whole number`);
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
    throw new Error(`${name} must be between 1 and ${maximum}`);
  }
  return value;
};

const address = (name: string): string => {
  const value = required(name);
  if (!ethers.isAddress(value) || value === ethers.ZeroAddress) throw new Error(`${name} must be a nonzero address`);
  return ethers.getAddress(value);
};

const rpc = (name: string, fallback: string, chainId: number) => {
  const request = new ethers.FetchRequest(process.env[name]?.trim() || fallback);
  request.timeout = 20_000;
  return new ethers.JsonRpcProvider(request, chainId, { batchMaxCount: 1, cacheTimeout: -1 });
};

const output = (name: string, value: string | number | boolean) => {
  const path = process.env.GITHUB_OUTPUT;
  if (path) appendFileSync(path, `${name}=${String(value)}\n`);
};

async function command(
  file: string,
  args: string[],
  env: NodeJS.ProcessEnv = process.env,
  acceptedExitCodes: readonly number[] = [0],
): Promise<number> {
  await new Promise<void>((accept, reject) => {
    const child = spawn(file, args, { cwd: resolve('.'), env, stdio: 'inherit' });
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      if (code !== null && acceptedExitCodes.includes(code)) accept();
      else reject(new Error(`${file} ${args.join(' ')} failed (${signal ?? `exit ${code}`})`));
    });
  });
  return 0;
}

interface EpochRecord {
  epoch: number;
  root: string;
  rosterFormatVersion: number;
  epochSchemaVersion: number;
  rosterAuthVersion: number;
  validUntil: number;
  entries: Array<{ subject: string; attrs: string; claimsRoot: string; evidenceHash: string; issuer: string }>;
}

const recordPath = (recordDirectory: string, source: string, asc: string, epoch: number) => join(
  recordDirectory,
  `epoch-v2-${source.toLowerCase()}-${asc.toLowerCase()}-${epoch}.json`,
);

function loadRecord(path: string, epoch: number, root: string): EpochRecord {
  const record = JSON.parse(readFileSync(path, 'utf8')) as EpochRecord;
  if (record.epoch !== epoch || record.root.toLowerCase() !== root.toLowerCase() || !Array.isArray(record.entries)) {
    throw new Error('current epoch record is missing or does not match the hub');
  }
  if (record.entries.length < 1 || record.entries.length > positiveInteger('EPOCH_MAX_WITNESSES', 100, 10_000)) {
    throw new Error('current roster exceeds the scheduled witness limit');
  }
  return record;
}

async function cacheWitnesses(
  provider: ethers.JsonRpcProvider,
  registryAddress: string,
  expectedSigner: string,
  record: EpochRecord,
): Promise<string[]> {
  const key = required('WITNESS_PRIVATE_KEY');
  const signer = new ethers.Wallet(key, provider);
  if (signer.address.toLowerCase() !== expectedSigner.toLowerCase()) throw new Error('WITNESS_SIGNER_ROLE_MISMATCH');
  if ((await provider.getNetwork()).chainId !== 102031n) throw new Error('wrong witness chain');
  await requireRosterWitness(provider, registryAddress);
  const registry = new ethers.Contract(registryAddress, REGISTRY_READ_ABI, signer);
  const confirmations = positiveInteger('WITNESS_CONFIRMATIONS', 2, 100);
  const transactions: string[] = [];

  for (const entry of record.entries) {
    const encoded = encodeRosterWitness(record, entry.subject);
    const current = await registry.getRosterWitness(entry.subject);
    if (Number(current[0]) === record.epoch) {
      console.log(`witness already current for ${entry.subject}`);
      continue;
    }
    await registry.cacheRosterWitness.staticCall(...encoded.args);
    const transaction = await registry.cacheRosterWitness(...encoded.args);
    const receipt = await transaction.wait(confirmations);
    if (!receipt || receipt.status !== 1) throw new Error(`witness transaction failed for ${entry.subject}`);
    const observed = await registry.getRosterWitness(entry.subject);
    if (Number(observed[0]) !== record.epoch) throw new Error(`witness confirmation mismatch for ${entry.subject}`);
    transactions.push(transaction.hash);
    console.log(`cached epoch ${record.epoch} witness for ${entry.subject}: ${transaction.hash}`);
  }
  return transactions;
}

async function refreshLists() {
  await command('npx', ['tsx', 'aml/fetch-lists.ts']);
  return (await loadLists('data/raw', 'epoch')).provenance;
}

async function waitForHubEpoch(asc: ethers.Contract, provider: ethers.JsonRpcProvider, expectedEpoch: number): Promise<void> {
  const pollMs = positiveInteger('EPOCH_POLL_SECONDS', 15, 300) * 1000;
  const timeoutMs = positiveInteger('EPOCH_TIMEOUT_MINUTES', 45, 360) * 60_000;
  const confirmations = positiveInteger('EPOCH_HUB_CONFIRMATIONS', 6, 100);
  const deadline = Date.now() + timeoutMs;
  let firstObservedBlock: number | undefined;
  while (Date.now() < deadline) {
    const block = await provider.getBlock('latest');
    if (!block) throw new Error('CC3 head is unavailable while recovering publication');
    const latest = Number(await asc.latestEpoch({ blockTag: block.number }));
    if (latest > expectedEpoch) throw new Error('pending epoch was superseded before recovery');
    if (latest === expectedEpoch) {
      firstObservedBlock ??= block.number;
      if (block.number >= firstObservedBlock + confirmations - 1) return;
    }
    console.log(`waiting for CC3 epoch ${expectedEpoch}: latest ${latest}, block ${block.number}`);
    await new Promise(resolve => setTimeout(resolve, pollMs));
  }
  throw new Error(`CC3 did not materialize epoch ${expectedEpoch} within the configured timeout`);
}

async function main() {
  const force = process.argv.slice(2).includes('--force') || process.env.FORCE_EPOCH_RENEWAL === '1';
  if (process.argv.slice(2).some(value => value !== '--force')) throw new Error('usage: renew-demo-epoch [--force]');
  const renewBefore = positiveInteger('EPOCH_RENEW_BEFORE_SECONDS', 21_600, 86_399);
  const sourceAddress = address('SOURCE_CONTRACT_ADDRESS');
  const ascAddress = address('ASC_CONTRACT_ADDRESS');
  const registryAddress = address('REGISTRY_CONTRACT_ADDRESS');
  const witnessSigner = address('WITNESS_SIGNER_ADDRESS');
  const recordDirectory = resolve(required('EPOCH_RECORD_DIR'));
  const source = rpc('SOURCE_CHAIN_RPC_URL', 'https://ethereum-sepolia-rpc.publicnode.com', 11155111);
  const hub = rpc('CREDITCOIN_RPC_URL', 'https://rpc.cc3-testnet.creditcoin.network', 102031);
  const sourceContract = new ethers.Contract(sourceAddress, SOURCE_ABI, source);
  const asc = new ethers.Contract(ascAddress, ASC_ABI, hub);
  let temporary: string | undefined;

  try {
    const hubBlock = await hub.getBlock('latest');
    if (!hubBlock) throw new Error('latest CC3 block is unavailable');
    let [sourceEpochValue, hubEpochValue, validUntilValue, fresh] = await Promise.all([
      sourceContract.lastEpoch(), asc.latestEpoch({ blockTag: hubBlock.number }),
      asc.epochValidUntil({ blockTag: hubBlock.number }), asc.isRosterFresh({ blockTag: hubBlock.number }),
    ]);
    let sourceEpoch = Number(sourceEpochValue), hubEpoch = Number(hubEpochValue), validUntil = Number(validUntilValue);
    const remaining = validUntil - hubBlock.timestamp;
    console.log(`epoch status: source ${sourceEpoch}, hub ${hubEpoch}, fresh ${fresh}, remaining ${remaining}s`);

    if (sourceEpoch < hubEpoch) throw new Error('hub epoch is ahead of the source epoch');
    if (sourceEpoch > hubEpoch) {
      console.log(`recovering source-confirmed epoch ${sourceEpoch}; no new epoch will be published`);
      await command('npx', ['tsx', 'script/publish-epoch.ts', '--resume-publication'], process.env, [0, 2]);
      await waitForHubEpoch(asc, hub, sourceEpoch);
      const recoveredBlock = await hub.getBlock('latest');
      if (!recoveredBlock) throw new Error('recovered CC3 block is unavailable');
      hubEpoch = Number(await asc.latestEpoch({ blockTag: recoveredBlock.number }));
      const recoveredRoot = await asc.epochRoots(hubEpoch, { blockTag: recoveredBlock.number });
      const record = loadRecord(recordPath(recordDirectory, sourceAddress, ascAddress, hubEpoch), hubEpoch, recoveredRoot);
      const witnessTransactions = await cacheWitnesses(hub, registryAddress, witnessSigner, record);
      const provenance = await refreshLists();
      console.log(`recovered epoch ${hubEpoch}; snapshot ${provenance.snapshotId}; witnesses ${record.entries.length}`);
      output('renewed', true); output('state_changed', true); output('epoch', hubEpoch);
      output('snapshot_id', provenance.snapshotId); output('witness_transactions', witnessTransactions.length);
      return;
    }

    const currentRoot = hubEpoch > 0 ? await asc.epochRoots(hubEpoch, { blockTag: hubBlock.number }) : ethers.ZeroHash;
    const currentPath = hubEpoch > 0 ? recordPath(recordDirectory, sourceAddress, ascAddress, hubEpoch) : '';
    if (hubEpoch > 0 && existsSync(currentPath)) {
      try {
        const record = loadRecord(currentPath, hubEpoch, currentRoot);
        await cacheWitnesses(hub, registryAddress, witnessSigner, record);
      } catch (error) {
        if (remaining <= renewBefore || force) console.log(`current record recovery deferred to renewal: ${(error as Error).message}`);
        else throw error;
      }
    }

    if (!force && fresh && remaining > renewBefore) {
      console.log(`renewal skipped: ${remaining}s remain, threshold is ${renewBefore}s`);
      output('renewed', false); output('state_changed', false); output('epoch', hubEpoch);
      return;
    }

    const provenance = await refreshLists();
    temporary = mkdtempSync(join(tmpdir(), 'proofmark-epoch-renewal-'));
    const plan = join(temporary, 'approval-plan.json');
    const approvals = join(temporary, 'approvals.json');
    const plannedEnvironment = { ...process.env, EPOCH_APPROVAL_PLAN_PATH: plan };
    await command('npx', ['tsx', 'script/publish-epoch.ts', '--dry-run'], plannedEnvironment);
    await command('npx', ['tsx', 'script/sign-epoch-approval.ts', plan, approvals]);
    await command('npx', ['tsx', 'script/publish-epoch.ts', '--publish'], {
      ...process.env,
      EPOCH_APPROVALS_FILE: approvals,
    });

    const afterBlock = await hub.getBlock('latest');
    if (!afterBlock) throw new Error('post-publication CC3 block is unavailable');
    [sourceEpochValue, hubEpochValue, validUntilValue, fresh] = await Promise.all([
      sourceContract.lastEpoch(), asc.latestEpoch({ blockTag: afterBlock.number }),
      asc.epochValidUntil({ blockTag: afterBlock.number }), asc.isRosterFresh({ blockTag: afterBlock.number }),
    ]);
    sourceEpoch = Number(sourceEpochValue); hubEpoch = Number(hubEpochValue); validUntil = Number(validUntilValue);
    if (sourceEpoch !== hubEpoch || !fresh || validUntil <= afterBlock.timestamp) {
      throw new Error('new epoch is not current and fresh on both chains');
    }
    const root = await asc.epochRoots(hubEpoch, { blockTag: afterBlock.number });
    const record = loadRecord(recordPath(recordDirectory, sourceAddress, ascAddress, hubEpoch), hubEpoch, root);
    const witnessTransactions = await cacheWitnesses(hub, registryAddress, witnessSigner, record);

    const finalBlock = await hub.getBlock('latest');
    if (!finalBlock) throw new Error('final CC3 block is unavailable');
    const registry = new ethers.Contract(registryAddress, REGISTRY_READ_ABI, hub);
    for (const entry of record.entries) {
      const witness = await registry.getRosterWitness(entry.subject, { blockTag: finalBlock.number });
      if (Number(witness[0]) !== hubEpoch) throw new Error(`stale final witness for ${entry.subject}`);
    }
    if (!(await asc.isRosterFresh({ blockTag: finalBlock.number }))) throw new Error('final epoch freshness check failed');

    console.log(`renewed epoch ${hubEpoch}; snapshot ${provenance.snapshotId}; witnesses ${record.entries.length}`);
    output('renewed', true); output('state_changed', true); output('epoch', hubEpoch);
    output('snapshot_id', provenance.snapshotId); output('witness_transactions', witnessTransactions.length);
  } finally {
    if (temporary) rmSync(temporary, { recursive: true, force: true });
    source.destroy(); hub.destroy();
  }
}

await main();
