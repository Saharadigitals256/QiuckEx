export const QUICKEX_EVENT_SCHEMA_VERSION = 2;

export const QUICKEX_EVENT_TOPICS = {
  admin: "TOPIC_ADMIN",
  dispute: "TOPIC_DISPUTE",
  escrow: "TOPIC_ESCROW",
  privacy: "TOPIC_PRIVACY",
  stealth: "TOPIC_STEALTH",
} as const;

export type QuickExEventTopic =
  (typeof QUICKEX_EVENT_TOPICS)[keyof typeof QUICKEX_EVENT_TOPICS];

export interface EventSchemaContract {
  topic: QuickExEventTopic;
  eventName: string;
  indexedFields: readonly string[];
  payloadKeys: readonly string[];
  schemaVersion: number;
  compatibleVersions: readonly number[];
}

export const QUICKEX_EVENT_SCHEMA_CONTRACTS = {
  EscrowDeposited: {
    topic: QUICKEX_EVENT_TOPICS.escrow,
    eventName: "EscrowDeposited",
    indexedFields: ["escrow_id", "owner"],
    payloadKeys: [
      "amount_due",
      "amount_paid",
      "expires_at",
      "schema_version",
      "timestamp",
      "token",
    ],
    schemaVersion: QUICKEX_EVENT_SCHEMA_VERSION,
    compatibleVersions: [1, QUICKEX_EVENT_SCHEMA_VERSION],
  },
  EscrowWithdrawn: {
    topic: QUICKEX_EVENT_TOPICS.escrow,
    eventName: "EscrowWithdrawn",
    indexedFields: ["escrow_id", "owner"],
    payloadKeys: ["amount", "fee", "schema_version", "timestamp", "token"],
    schemaVersion: QUICKEX_EVENT_SCHEMA_VERSION,
    compatibleVersions: [1, QUICKEX_EVENT_SCHEMA_VERSION],
  },
  EscrowRefunded: {
    topic: QUICKEX_EVENT_TOPICS.escrow,
    eventName: "EscrowRefunded",
    indexedFields: ["escrow_id", "owner"],
    payloadKeys: ["amount", "schema_version", "timestamp", "token"],
    schemaVersion: QUICKEX_EVENT_SCHEMA_VERSION,
    compatibleVersions: [1, QUICKEX_EVENT_SCHEMA_VERSION],
  },
  EscrowDisputed: {
    topic: QUICKEX_EVENT_TOPICS.escrow,
    eventName: "EscrowDisputed",
    indexedFields: ["escrow_id", "arbiter"],
    payloadKeys: ["schema_version", "timestamp"],
    schemaVersion: QUICKEX_EVENT_SCHEMA_VERSION,
    compatibleVersions: [QUICKEX_EVENT_SCHEMA_VERSION],
  },
  EscrowFinalized: {
    topic: QUICKEX_EVENT_TOPICS.escrow,
    eventName: "EscrowFinalized",
    indexedFields: ["escrow_id", "owner"],
    payloadKeys: ["schema_version", "timestamp", "token", "total_amount"],
    schemaVersion: QUICKEX_EVENT_SCHEMA_VERSION,
    compatibleVersions: [QUICKEX_EVENT_SCHEMA_VERSION],
  },
  RefundFinalized: {
    topic: QUICKEX_EVENT_TOPICS.escrow,
    eventName: "RefundFinalized",
    indexedFields: ["escrow_id", "owner"],
    payloadKeys: [
      "amount",
      "expires_at",
      "schema_version",
      "timestamp",
      "token",
    ],
    schemaVersion: QUICKEX_EVENT_SCHEMA_VERSION,
    compatibleVersions: [QUICKEX_EVENT_SCHEMA_VERSION],
  },
  PartialPayment: {
    topic: QUICKEX_EVENT_TOPICS.escrow,
    eventName: "PartialPayment",
    indexedFields: ["escrow_id", "payer"],
    payloadKeys: [
      "amount_due",
      "amount_paid",
      "payment_amount",
      "schema_version",
      "timestamp",
      "token",
    ],
    schemaVersion: QUICKEX_EVENT_SCHEMA_VERSION,
    compatibleVersions: [QUICKEX_EVENT_SCHEMA_VERSION],
  },
  MilestoneCompleted: {
    topic: QUICKEX_EVENT_TOPICS.escrow,
    eventName: "MilestoneCompleted",
    indexedFields: ["escrow_id"],
    payloadKeys: [
      "milestone_id",
      "milestone_amount",
      "schema_version",
      "timestamp",
      "total_amount_paid",
    ],
    schemaVersion: QUICKEX_EVENT_SCHEMA_VERSION,
    compatibleVersions: [QUICKEX_EVENT_SCHEMA_VERSION],
  },
  EscrowExtensionApplied: {
    topic: QUICKEX_EVENT_TOPICS.escrow,
    eventName: "EscrowExtensionApplied",
    indexedFields: ["escrow_id"],
    payloadKeys: [
      "extension_count",
      "extension_secs",
      "fee",
      "new_expires_at",
      "schema_version",
      "timestamp",
    ],
    schemaVersion: QUICKEX_EVENT_SCHEMA_VERSION,
    compatibleVersions: [QUICKEX_EVENT_SCHEMA_VERSION],
  },
  EscrowExtensionFeeCharged: {
    topic: QUICKEX_EVENT_TOPICS.escrow,
    eventName: "EscrowExtensionFeeCharged",
    indexedFields: ["escrow_id"],
    payloadKeys: ["extension_secs", "fee", "schema_version", "timestamp"],
    schemaVersion: QUICKEX_EVENT_SCHEMA_VERSION,
    compatibleVersions: [QUICKEX_EVENT_SCHEMA_VERSION],
  },
  EscrowExtensionFeeRefunded: {
    topic: QUICKEX_EVENT_TOPICS.escrow,
    eventName: "EscrowExtensionFeeRefunded",
    indexedFields: ["escrow_id"],
    payloadKeys: ["fee", "reason", "schema_version", "timestamp"],
    schemaVersion: QUICKEX_EVENT_SCHEMA_VERSION,
    compatibleVersions: [QUICKEX_EVENT_SCHEMA_VERSION],
  },
  EscrowCleaned: {
    topic: QUICKEX_EVENT_TOPICS.escrow,
    eventName: "EscrowCleaned",
    indexedFields: ["escrow_id"],
    payloadKeys: ["schema_version", "status", "timestamp"],
    schemaVersion: QUICKEX_EVENT_SCHEMA_VERSION,
    compatibleVersions: [QUICKEX_EVENT_SCHEMA_VERSION],
  },
  DisputeEvidenceSubmitted: {
    topic: QUICKEX_EVENT_TOPICS.dispute,
    eventName: "DisputeEvidenceSubmitted",
    indexedFields: ["escrow_id"],
    payloadKeys: [
      "evidence_hash",
      "submitted_by",
      "schema_version",
      "timestamp",
    ],
    schemaVersion: QUICKEX_EVENT_SCHEMA_VERSION,
    compatibleVersions: [QUICKEX_EVENT_SCHEMA_VERSION],
  },
  ArbiterVoteCast: {
    topic: QUICKEX_EVENT_TOPICS.dispute,
    eventName: "ArbiterVoteCast",
    indexedFields: ["escrow_id", "arbiter"],
    payloadKeys: [
      "resolve_for_owner",
      "schema_version",
      "threshold",
      "timestamp",
      "vote_count",
    ],
    schemaVersion: QUICKEX_EVENT_SCHEMA_VERSION,
    compatibleVersions: [QUICKEX_EVENT_SCHEMA_VERSION],
  },
  DisputeResolved: {
    topic: QUICKEX_EVENT_TOPICS.dispute,
    eventName: "DisputeResolved",
    indexedFields: ["escrow_id", "resolved_for_owner"],
    payloadKeys: [
      "amount",
      "schema_version",
      "threshold",
      "timestamp",
      "total_votes",
    ],
    schemaVersion: QUICKEX_EVENT_SCHEMA_VERSION,
    compatibleVersions: [QUICKEX_EVENT_SCHEMA_VERSION],
  },
  PrivacyToggled: {
    topic: QUICKEX_EVENT_TOPICS.privacy,
    eventName: "PrivacyToggled",
    indexedFields: ["owner"],
    payloadKeys: ["enabled", "schema_version", "timestamp"],
    schemaVersion: QUICKEX_EVENT_SCHEMA_VERSION,
    compatibleVersions: [1, QUICKEX_EVENT_SCHEMA_VERSION],
  },
  ContractPaused: {
    topic: QUICKEX_EVENT_TOPICS.admin,
    eventName: "ContractPaused",
    indexedFields: ["admin"],
    payloadKeys: ["paused", "reason", "schema_version", "timestamp"],
    schemaVersion: QUICKEX_EVENT_SCHEMA_VERSION,
    compatibleVersions: [QUICKEX_EVENT_SCHEMA_VERSION],
  },
  AdminChanged: {
    topic: QUICKEX_EVENT_TOPICS.admin,
    eventName: "AdminChanged",
    indexedFields: ["old_admin", "new_admin"],
    payloadKeys: ["schema_version", "timestamp"],
    schemaVersion: QUICKEX_EVENT_SCHEMA_VERSION,
    compatibleVersions: [1, QUICKEX_EVENT_SCHEMA_VERSION],
  },
  ContractUpgraded: {
    topic: QUICKEX_EVENT_TOPICS.admin,
    eventName: "ContractUpgraded",
    indexedFields: ["new_wasm_hash", "admin"],
    payloadKeys: ["schema_version", "timestamp"],
    schemaVersion: QUICKEX_EVENT_SCHEMA_VERSION,
    compatibleVersions: [QUICKEX_EVENT_SCHEMA_VERSION],
  },
  EphemeralKeyRegistered: {
    topic: QUICKEX_EVENT_TOPICS.stealth,
    eventName: "EphemeralKeyRegistered",
    indexedFields: ["stealth_address", "eph_pub"],
    payloadKeys: [
      "amount_due",
      "amount_paid",
      "expires_at",
      "schema_version",
      "timestamp",
      "token",
    ],
    schemaVersion: QUICKEX_EVENT_SCHEMA_VERSION,
    compatibleVersions: [QUICKEX_EVENT_SCHEMA_VERSION],
  },
  StealthWithdrawn: {
    topic: QUICKEX_EVENT_TOPICS.stealth,
    eventName: "StealthWithdrawn",
    indexedFields: ["stealth_address", "recipient"],
    payloadKeys: ["amount", "schema_version", "timestamp", "token"],
    schemaVersion: QUICKEX_EVENT_SCHEMA_VERSION,
    compatibleVersions: [QUICKEX_EVENT_SCHEMA_VERSION],
  },
} as const satisfies Record<string, EventSchemaContract>;

export const QUICKEX_EVENT_COMPATIBILITY = Object.fromEntries(
  Object.entries(QUICKEX_EVENT_SCHEMA_CONTRACTS).map(
    ([eventName, contract]) => [
      eventName,
      {
        currentVersion: contract.schemaVersion,
        compatibleVersions: contract.compatibleVersions,
        canonicalTopic: contract.topic,
      },
    ],
  ),
) as unknown as Record<
  keyof typeof QUICKEX_EVENT_SCHEMA_CONTRACTS,
  {
    currentVersion: number;
    compatibleVersions: readonly number[];
    canonicalTopic: QuickExEventTopic;
  }
>;
