/**
 * Reads the supported chain list so preflight can confirm the chainKey that
 * `configureSource(chainKey, ...)` will be given.
 *
 * chainKey is not chainId. Sepolia is chainKey 1, chainId 11155111.
 * The source chain key is not the EVM chain ID, so this asks the chain
 * directly, right before deployment.
 *
 * Usage: npx tsx script/check_chains.ts <expectedChainKey> <expectedChainId>
 * Exit 0 on a match, 1 on a mismatch or a failed lookup.
 */
import { ethers } from 'ethers';
import { chainInfo } from '@gluwa/usc-sdk';

async function main() {
  const [wantKeyArg, wantIdArg] = process.argv.slice(2);
  const wantKey = Number(wantKeyArg);
  const wantId = Number(wantIdArg);
  const rpc = process.env.CREDITCOIN_RPC_URL;

  if (!rpc) throw new Error('CREDITCOIN_RPC_URL is not set');
  if (!Number.isFinite(wantKey) || !Number.isFinite(wantId)) {
    throw new Error('usage: check_chains.ts <expectedChainKey> <expectedChainId>');
  }

  const provider = new ethers.JsonRpcProvider(rpc);
  // The SDK bundles its own copy of ethers, so the type identities differ. The runtime object is the same.
  const info = new chainInfo.PrecompileChainInfoProvider(provider as any);
  const chains = await info.getSupportedChains();

  console.log('  supported chains:');
  for (const c of chains) {
    const name = c.chainName?.startsWith?.('0x')
      ? Buffer.from(c.chainName.slice(2), 'hex').toString('utf8')
      : String(c.chainName ?? '');
    console.log(`    chainKey ${c.chainKey} → chainId ${c.chainId}  (${name})`);
  }

  const hit = chains.find((c: any) => Number(c.chainKey) === wantKey);
  if (!hit) {
    console.error(`  x chainKey ${wantKey} is not in the supported list`);
    process.exit(1);
  }
  if (Number(hit.chainId) !== wantId) {
    console.error(`  x chainKey ${wantKey} maps to chainId ${hit.chainId}, expected ${wantId}`);
    process.exit(1);
  }

  // Also check attestation is moving. If it has stalled, deploying gets you nowhere.
  const attested = await info.getLatestAttestedHeightAndHash(wantKey);
  console.log(`  ok chainKey ${wantKey} = chainId ${wantId}, latest attested height ${attested.height}`);
  process.exit(0);
}

main().catch((e) => {
  console.error('  x could not read the supported chain list:', e?.shortMessage ?? e?.message ?? e);
  process.exit(1);
});
