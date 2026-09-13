/**
 * Signs one frozen roster publication plan with the dedicated source issuer key.
 * The private key is loaded from the environment and is never written or printed.
 */
import 'dotenv/config';
import { closeSync, fsyncSync, openSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { ethers } from 'ethers';

import { readRootApprovals, rosterApprovalData } from '../pipeline/roster-authorization.js';

const [planArg, outputArg] = process.argv.slice(2);
if (!planArg || !outputArg) throw new Error('usage: sign-epoch-approval.ts PLAN_JSON OUTPUT_JSON');

const key = process.env.ISSUER_PRIVATE_KEY;
if (!key) throw new Error('ISSUER_PRIVATE_KEY is required');
const signer = new ethers.Wallet(key);
const planPath = resolve(planArg), outputPath = resolve(outputArg);
if (planPath === outputPath) throw new Error('approval output must differ from the unsigned plan');
if (statSync(planPath).size > 256 * 1024) throw new Error('approval plan exceeds 256 KiB');

const plan = JSON.parse(readFileSync(planPath, 'utf8')) as {
  version?: unknown;
  digest?: unknown;
  domain?: { chainId?: unknown; verifyingContract?: unknown };
  value?: Record<string, unknown>;
  requiredIssuers?: unknown;
  approvals?: unknown;
};
if (plan.version !== 1 || typeof plan.digest !== 'string' || !plan.domain || !plan.value ||
    !Array.isArray(plan.requiredIssuers) || plan.requiredIssuers.length !== 1 ||
    !Array.isArray(plan.approvals) || plan.approvals.length !== 0) {
  throw new Error('invalid unsigned approval plan');
}
const requiredIssuer = ethers.getAddress(String(plan.requiredIssuers[0]));
if (requiredIssuer.toLowerCase() !== signer.address.toLowerCase()) throw new Error('issuer key does not cover this roster');
const typed = rosterApprovalData(BigInt(String(plan.domain.chainId)), String(plan.domain.verifyingContract), plan.value as any);
if (typed.digest.toLowerCase() !== plan.digest.toLowerCase()) throw new Error('approval plan digest mismatch');
const signature = await signer.signTypedData(typed.domain, typed.types, typed.value);
const signed = { ...plan, approvals: [{ issuer: signer.address, signature }] };
readRootApprovals(signed, typed.digest, [signer.address]);

const tmp = `${outputPath}.${randomUUID()}.tmp`;
let fd: number | undefined;
try {
  fd = openSync(tmp, 'wx', 0o600);
  writeFileSync(fd, `${JSON.stringify(signed, null, 2)}\n`);
  fsyncSync(fd); closeSync(fd); fd = undefined;
  renameSync(tmp, outputPath);
  const dir = openSync(dirname(outputPath), 'r');
  try { fsyncSync(dir); } finally { closeSync(dir); }
} finally {
  if (fd !== undefined) closeSync(fd);
}
console.log(`signed epoch approval for ${signer.address}; private key not printed`);
