/**
 * Bakes a slim index holding only what screening needs.
 * Parsing 57MB of XML per request is not something a serverless function can do.
 */
import { atomicFile } from './snapshot-store.js';
import { readIndex } from './index-format.js';
import { currentGeneration, loadLists } from './loader.js';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const { entries, provenance } = await loadLists();
const gz = readFileSync(join(currentGeneration(), 'sanctions-index.json.gz'));
const activated = readIndex(gz);
if (activated.meta.provenance.snapshotId !== provenance.snapshotId || activated.entries.length !== entries.length) {
  throw new Error('activated sanctions index does not match its validated source generation');
}
atomicFile('web/data/sanctions-index.json.gz', gz);
console.log(`copied activated v3 snapshot ${provenance.snapshotId}: ${entries.length} entries, ${(gz.length / 1e6).toFixed(2)} MB gzip`);
console.log('This switches only the local web artifact, not deployed/other runtime instances.');
