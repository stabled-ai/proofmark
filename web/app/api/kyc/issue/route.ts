import { handleIssuanceRequest } from '@/lib/issuance-route';

export const runtime = 'nodejs';
export const maxDuration = 120;

export async function POST(req: Request) {
  return handleIssuanceRequest(req);
}
