import { NextResponse } from 'next/server';
import { ethers } from 'ethers';
import { readOnchainState } from '@pipeline/onchain-state.js';
import { guardError, guardRequest } from '@/lib/request-guard';

export const runtime = 'nodejs';
export const revalidate = 0;

export async function GET(req: Request) {
  try {
    guardRequest(req, { bucket: 'onchain-status', limit: 60, windowMs: 60_000 });
    const subject = new URL(req.url).searchParams.get('subject')
      ?? process.env.NEXT_PUBLIC_DEMO_SUBJECT
      ?? '0x4816B6e3Acb775f65Da888f185f708E2C8D7a3e2';
    if (!ethers.isAddress(subject)) return NextResponse.json({ error: 'Invalid subject address' }, { status: 400, headers: { 'Cache-Control': 'no-store' } });
    const rpc = process.env.NEXT_PUBLIC_CC3_RPC;
    if (!rpc) throw new Error('hub RPC not configured');
    const request = new ethers.FetchRequest(rpc); request.timeout = 10_000;
    const provider = new ethers.JsonRpcProvider(request, undefined, { cacheTimeout: -1, batchMaxCount: 1 });
    try {
      const state = await readOnchainState(provider, { asc: process.env.NEXT_PUBLIC_ASC ?? '', registry: process.env.NEXT_PUBLIC_REGISTRY ?? '', subject });
      return NextResponse.json(state, { headers: { 'Cache-Control': 'no-store' } });
    } finally { provider.destroy(); }
  } catch (error) {
    const response = guardError(error) ?? NextResponse.json({ error: 'on-chain status unavailable; no verdict confirmed' }, { status: 503 });
    response.headers.set('Cache-Control', 'no-store');
    return response;
  }
}
