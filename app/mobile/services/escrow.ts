import { API_URL } from '../src/config/build';

export interface EscrowSummary {
  id: string;
  depositor: string;
  beneficiary: string;
  amount: string;
  assetCode: string;
  released: boolean;
  refunded: boolean;
  expiryLedger: number;
  expired: boolean;
}

export async function fetchEscrowSummary(escrowId: string): Promise<EscrowSummary> {
  const baseUrl = API_URL.replace(/\/$/, '');
  let response: Response;

  try {
    response = await fetch(
      `${baseUrl}/v1/contracts/views/escrow/${encodeURIComponent(escrowId)}`,
      { headers: { Accept: 'application/json' } },
    );
  } catch {
    throw new Error('Network request failed. Check your connection and try again.');
  }

  if (!response.ok) {
    let message = `Server error (${response.status})`;
    try {
      const body = (await response.json()) as { message?: string };
      if (body.message) message = body.message;
    } catch {}
    throw new Error(message);
  }

  return response.json() as Promise<EscrowSummary>;
}