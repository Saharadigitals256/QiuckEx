import { Injectable, Logger } from "@nestjs/common";
import { SupabaseService } from "../supabase/supabase.service";

export interface IndexerCheckpoint {
  lastLedger: number;
  pagingToken: string | null;
}

/**
 * Persists and reads the highest fully-processed ledger per contract.
 * Used by the batch poller to resume without re-scanning indexed ranges.
 */
@Injectable()
export class IndexerCheckpointRepository {
  private readonly logger = new Logger(IndexerCheckpointRepository.name);

  constructor(private readonly supabase: SupabaseService) {}

  async getCheckpoint(contractId: string): Promise<IndexerCheckpoint | null> {
    const { data, error } = await this.supabase.getClient()
      .from("indexer_checkpoints")
      .select("last_ledger, paging_token")
      .eq("contract_id", contractId)
      .maybeSingle();

    if (error) {
      this.logger.error(`Failed to read checkpoint for ${contractId}: ${error.message}`);
      throw error;
    }
    return data
      ? {
          lastLedger: Number(data.last_ledger),
          pagingToken: (data.paging_token as string | null) ?? null,
        }
      : null;
  }

  async getLastLedger(contractId: string): Promise<number | null> {
    const checkpoint = await this.getCheckpoint(contractId);
    return checkpoint?.lastLedger ?? null;
  }

  async saveCheckpoint(
    contractId: string,
    ledger: number,
    pagingToken: string | null,
  ): Promise<void> {
    const { error } = await this.supabase.getClient()
      .from("indexer_checkpoints")
      .upsert(
        {
          contract_id: contractId,
          last_ledger: ledger,
          paging_token: pagingToken,
          updated_at: new Date().toISOString(),
        },
        { onConflict: "contract_id" },
      );

    if (error) {
      this.logger.error(`Failed to save checkpoint for ${contractId}: ${error.message}`);
      throw error;
    }
  }

  async saveLastLedger(contractId: string, ledger: number): Promise<void> {
    await this.saveCheckpoint(contractId, ledger, null);
  }
}
