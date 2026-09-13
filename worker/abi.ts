import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const outDir = join(here, '..', 'out');

function abiOf(file: string, name: string): any[] {
  const p = join(outDir, file, `${name}.json`);
  try {
    return JSON.parse(readFileSync(p, 'utf8')).abi;
  } catch {
    throw new Error(`ABI not found: ${p}. Run 'forge build' first.`);
  }
}

/** Read ABIs from the build output. Hand-copied ABIs drift. */
export const COMPLIANCE_SOURCE_ABI = abiOf('ComplianceSource.sol', 'ComplianceSource');
export const PROOFMARK_ASC_ABI     = abiOf('ProofmarkASC.sol', 'ProofmarkASC');

/** Event name to the action code consumed by ProofmarkASC. */
export { EVENT_TO_ACTION, WATCHED_EVENTS, requireIssuerKeyProvenance, requireDenialCorrection } from './source-events.js';
