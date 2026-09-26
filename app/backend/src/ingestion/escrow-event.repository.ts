import { Injectable, Logger } from "@nestjs/common";
import { SupabaseService } from "../supabase/supabase.service";
import type {
  EscrowEvent,
  EscrowDepositedEvent,
  EscrowDisputedEvent,
  EscrowFinalizedEvent,
  RefundFinalizedEvent,
  PartialPaymentEvent,
  MilestoneCompletedEvent,
  EscrowExtensionAppliedEvent,
  EscrowExtensionFeeChargedEvent,
  EscrowExtensionFeeRefundedEvent,
  EscrowCleanedEvent,
} from "./types/contract-event.types";

/**
 * Persists escrow domain events to Supabase.
 * All inserts use ON CONFLICT DO NOTHING so replaying the same event is safe.
 */
@Injectable()
export class EscrowEventRepository {
  private readonly logger = new Logger(EscrowEventRepository.name);

  constructor(private readonly supabase: SupabaseService) {}

  /**
   * Idempotently insert an escrow event.
   * The unique constraint on (tx_hash, commitment, event_type) ensures
   * that re-processing the same event is a no-op.
   */
  async upsertEvent(event: EscrowEvent): Promise<void> {
    const client = this.supabase.getClient();

    const row: Record<string, unknown> = {
      event_type: event.eventType,
      event_id: event.eventId,
      commitment: event.commitment,
      owner: "owner" in event ? event.owner : null,
      token: "token" in event ? event.token : null,
      amount: "amount" in event ? event.amount.toString() : null,
      contract_timestamp: Number(event.contractTimestamp),
      tx_hash: event.txHash,
      ledger_sequence: event.ledgerSequence,
      paging_token: event.pagingToken,
      expires_at:
        event.eventType === "EscrowDeposited"
          ? new Date(
              Number((event as EscrowDepositedEvent).expiresAt) * 1000,
            ).toISOString()
          : null,
      arbiter: "arbiter" in event ? (event as EscrowDisputedEvent).arbiter : null,
      payer: "payer" in event ? (event as PartialPaymentEvent).payer : null,
      payment_amount: "paymentAmount" in event ? (event as PartialPaymentEvent).paymentAmount.toString() : null,
      amount_paid: "amountPaid" in event ? (event as PartialPaymentEvent).amountPaid.toString() : null,
      amount_due: "amountDue" in event ? (event as PartialPaymentEvent).amountDue.toString() : null,
      total_amount: "totalAmount" in event ? (event as EscrowFinalizedEvent).totalAmount.toString() : null,
      expires_at_finalized: "expiresAt" in event ? new Date(Number((event as RefundFinalizedEvent).expiresAt) * 1000).toISOString() : null,
      milestone_id: "milestoneId" in event ? (event as MilestoneCompletedEvent).milestoneId : null,
      milestone_amount: "milestoneAmount" in event ? (event as MilestoneCompletedEvent).milestoneAmount.toString() : null,
      total_amount_paid: "totalAmountPaid" in event ? (event as MilestoneCompletedEvent).totalAmountPaid.toString() : null,
      extension_count: "extensionCount" in event ? (event as EscrowExtensionAppliedEvent).extensionCount : null,
      extension_secs: "extensionSecs" in event ? (event as EscrowExtensionAppliedEvent).extensionSecs.toString() : null,
      fee: "fee" in event ? (event as EscrowExtensionAppliedEvent | EscrowExtensionFeeChargedEvent | EscrowExtensionFeeRefundedEvent).fee.toString() : null,
      new_expires_at: "newExpiresAt" in event ? (event as EscrowExtensionAppliedEvent).newExpiresAt.toString() : null,
      fee_refunded: "fee" in event && event.eventType === "EscrowExtensionFeeRefunded" ? (event as EscrowExtensionFeeRefundedEvent).fee.toString() : null,
      refund_reason: "reason" in event ? (event as EscrowExtensionFeeRefundedEvent).reason : null,
      status: "status" in event ? (event as EscrowCleanedEvent).status : null,
      evidence_hash: "evidenceHash" in event ? (event as { evidenceHash: string }).evidenceHash : null,
      submitted_by: "submittedBy" in event ? (event as { submittedBy: string }).submittedBy : null,
      resolve_for_owner: "resolveForOwner" in event ? (event as ArbiterVoteCastEvent | DisputeResolvedEvent).resolveForOwner : null,
      vote_count: "voteCount" in event ? (event as ArbiterVoteCastEvent).voteCount : null,
      threshold: "threshold" in event ? (event as ArbiterVoteCastEvent | DisputeResolvedEvent).threshold : null,
      total_votes: "totalVotes" in event ? (event as DisputeResolvedEvent).totalVotes : null,
      amount_disputed: "amount" in event && (event.eventType === "DisputeResolved" || event.eventType === "ArbiterVoteCast") ? (event as DisputeResolvedEvent).amount.toString() : null,
    };

    const { error } = await client
      .from("escrow_events")
      .upsert(row, {
        onConflict: "tx_hash,commitment,event_type",
        ignoreDuplicates: true,
      });

    if (error) {
      this.logger.error(
        `Failed to upsert escrow event ${event.eventType} for commitment ${event.commitment}: ${error.message}`,
      );
      throw error;
    }

    this.logger.debug(
      `Persisted ${event.eventType} commitment=${event.commitment} ledger=${event.ledgerSequence}`,
    );
  }
}
