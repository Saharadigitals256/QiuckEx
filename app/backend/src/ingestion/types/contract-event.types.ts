/**
 * Domain types for QuickEx Soroban contract events.
 * These mirror the Rust event structs defined in contracts/quickex/src/events.rs
 */

export type SorobanEventType =
  | "EscrowDeposited"
  | "EscrowWithdrawn"
  | "EscrowRefunded"
  | "EscrowDisputed"
  | "EscrowFinalized"
  | "RefundFinalized"
  | "PartialPayment"
  | "MilestoneCompleted"
  | "EscrowExtensionApplied"
  | "EscrowExtensionFeeCharged"
  | "EscrowExtensionFeeRefunded"
  | "EscrowCleaned"
  | "PrivacyToggled"
  | "ContractPaused"
  | "AdminChanged"
  | "ContractUpgraded"
  | "EphemeralKeyRegistered"
  | "StealthWithdrawn"
  | "DisputeEvidenceSubmitted"
  | "ArbiterVoteCast"
  | "DisputeResolved";

export interface BaseContractEvent {
  eventType: SorobanEventType;
  /** Deterministic SHA-256 hex id computed from the event's identity fields. */
  eventId: string;
  /** Schema version read from the event payload (1 = legacy, 2+ = versioned). */
  schemaVersion: number;
  topicNamespace?: string;
  txHash: string;
  ledgerSequence: number;
  pagingToken: string;
  contractTimestamp: bigint;
}

export interface EscrowDepositedEvent extends BaseContractEvent {
  eventType: "EscrowDeposited";
  commitment: string; // hex
  owner: string;
  token: string;
  amount: bigint;
  amountPaid?: bigint;
  expiresAt: bigint;
}

export interface EscrowWithdrawnEvent extends BaseContractEvent {
  eventType: "EscrowWithdrawn";
  commitment: string;
  owner: string;
  token: string;
  amount: bigint;
}

export interface EscrowRefundedEvent extends BaseContractEvent {
  eventType: "EscrowRefunded";
  commitment: string;
  owner: string;
  token: string;
  amount: bigint;
}

export interface EscrowDisputedEvent extends BaseContractEvent {
  eventType: "EscrowDisputed";
  commitment: string;
  arbiter: string;
}

export interface EscrowFinalizedEvent extends BaseContractEvent {
  eventType: "EscrowFinalized";
  commitment: string;
  owner: string;
  token: string;
  totalAmount: bigint;
}

export interface RefundFinalizedEvent extends BaseContractEvent {
  eventType: "RefundFinalized";
  commitment: string;
  owner: string;
  token: string;
  amount: bigint;
  expiresAt: bigint;
}

export interface PartialPaymentEvent extends BaseContractEvent {
  eventType: "PartialPayment";
  commitment: string;
  payer: string;
  token: string;
  paymentAmount: bigint;
  amountPaid: bigint;
  amountDue: bigint;
}

export interface MilestoneCompletedEvent extends BaseContractEvent {
  eventType: "MilestoneCompleted";
  commitment: string;
  milestoneId: number;
  milestoneAmount: bigint;
  totalAmountPaid: bigint;
}

export interface EscrowExtensionAppliedEvent extends BaseContractEvent {
  eventType: "EscrowExtensionApplied";
  commitment: string;
  extensionCount: number;
  extensionSecs: bigint;
  fee: bigint;
  newExpiresAt: bigint;
}

export interface EscrowExtensionFeeChargedEvent extends BaseContractEvent {
  eventType: "EscrowExtensionFeeCharged";
  commitment: string;
  extensionSecs: bigint;
  fee: bigint;
}

export interface EscrowExtensionFeeRefundedEvent extends BaseContractEvent {
  eventType: "EscrowExtensionFeeRefunded";
  commitment: string;
  fee: bigint;
  reason: string;
}

export interface EscrowCleanedEvent extends BaseContractEvent {
  eventType: "EscrowCleaned";
  commitment: string;
  status: number;
}

export interface DisputeEvidenceSubmittedEvent extends BaseContractEvent {
  eventType: "DisputeEvidenceSubmitted";
  commitment: string;
  evidenceHash: string;
  submittedBy: string;
}

export interface ArbiterVoteCastEvent extends BaseContractEvent {
  eventType: "ArbiterVoteCast";
  commitment: string;
  arbiter: string;
  resolveForOwner: boolean;
  voteCount: number;
  threshold: number;
}

export interface DisputeResolvedEvent extends BaseContractEvent {
  eventType: "DisputeResolved";
  commitment: string;
  resolvedForOwner: boolean;
  totalVotes: number;
  threshold: number;
  amount: bigint;
}

export interface PrivacyToggledEvent extends BaseContractEvent {
  eventType: "PrivacyToggled";
  owner: string;
  enabled: boolean;
}

export interface ContractPausedEvent extends BaseContractEvent {
  eventType: "ContractPaused";
  admin: string;
  paused: boolean;
}

export interface AdminChangedEvent extends BaseContractEvent {
  eventType: "AdminChanged";
  oldAdmin: string;
  newAdmin: string;
}

export interface ContractUpgradedEvent extends BaseContractEvent {
  eventType: "ContractUpgraded";
  newWasmHash: string;
  admin: string;
}

/** Emitted when a sender registers an ephemeral public key and locks funds for a stealth recipient. */
export interface EphemeralKeyRegisteredEvent extends BaseContractEvent {
  eventType: "EphemeralKeyRegistered";
  /** One-time stealth address (hex). */
  stealthAddress: string;
  /** Sender's ephemeral public key (hex). */
  ephPub: string;
  token: string;
  amount: bigint;
  expiresAt: bigint;
}

/** Emitted when a recipient withdraws funds from a stealth escrow. */
export interface StealthWithdrawnEvent extends BaseContractEvent {
  eventType: "StealthWithdrawn";
  /** One-time stealth address (hex). */
  stealthAddress: string;
  /** Recipient's real address – only revealed at withdrawal time. */
  recipient: string;
  token: string;
  amount: bigint;
}

export type QuickExContractEvent =
  | EscrowDepositedEvent
  | EscrowWithdrawnEvent
  | EscrowRefundedEvent
  | EscrowDisputedEvent
  | EscrowFinalizedEvent
  | RefundFinalizedEvent
  | PartialPaymentEvent
  | MilestoneCompletedEvent
  | EscrowExtensionAppliedEvent
  | EscrowExtensionFeeChargedEvent
  | EscrowExtensionFeeRefundedEvent
  | EscrowCleanedEvent
  | PrivacyToggledEvent
  | ContractPausedEvent
  | AdminChangedEvent
  | ContractUpgradedEvent
  | EphemeralKeyRegisteredEvent
  | StealthWithdrawnEvent
  | DisputeEvidenceSubmittedEvent
  | ArbiterVoteCastEvent
  | DisputeResolvedEvent;

export type EscrowEvent =
  | EscrowDepositedEvent
  | EscrowWithdrawnEvent
  | EscrowRefundedEvent
  | EscrowDisputedEvent
  | EscrowFinalizedEvent
  | RefundFinalizedEvent
  | PartialPaymentEvent
  | MilestoneCompletedEvent
  | EscrowExtensionAppliedEvent
  | EscrowExtensionFeeChargedEvent
  | EscrowExtensionFeeRefundedEvent
  | EscrowCleanedEvent;

export type AdminEvent =
  | ContractPausedEvent
  | AdminChangedEvent
  | ContractUpgradedEvent;

export type StealthEvent = EphemeralKeyRegisteredEvent | StealthWithdrawnEvent;

export type DisputeEvent =
  | EscrowDisputedEvent
  | ArbiterVoteCastEvent
  | DisputeResolvedEvent
  | DisputeEvidenceSubmittedEvent;
