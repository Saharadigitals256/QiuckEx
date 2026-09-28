import {
  QUICKEX_EVENT_SCHEMA_CONTRACTS,
  QUICKEX_EVENT_SCHEMA_VERSION,
} from "../event-schema";

describe("QuickEx event schema compatibility", () => {
  it("declares a complete compatibility contract for every event", () => {
    for (const contract of Object.values(QUICKEX_EVENT_SCHEMA_CONTRACTS)) {
      expect(contract.schemaVersion).toBe(QUICKEX_EVENT_SCHEMA_VERSION);
      expect(contract.compatibleVersions).toContain(contract.schemaVersion);
      expect(contract.payloadKeys).toContain("timestamp");
      expect(contract.payloadKeys).toContain("schema_version");
      expect(contract.indexedFields.length).toBeGreaterThan(0);
    }
  });

  it("keeps the v1 to v2 compatibility boundary explicit", () => {
    const legacyCompatible = [
      "EscrowDeposited",
      "EscrowWithdrawn",
      "EscrowRefunded",
      "PrivacyToggled",
      "AdminChanged",
    ];

    for (const eventName of legacyCompatible) {
      expect(
        QUICKEX_EVENT_SCHEMA_CONTRACTS[
          eventName as keyof typeof QUICKEX_EVENT_SCHEMA_CONTRACTS
        ].compatibleVersions,
      ).toEqual(expect.arrayContaining([1, 2]));
    }

    for (const eventName of [
      "ContractPaused",
      "ContractUpgraded",
      "EphemeralKeyRegistered",
      "StealthWithdrawn",
    ] as const) {
      expect(QUICKEX_EVENT_SCHEMA_CONTRACTS[eventName].compatibleVersions).toEqual([2]);
    }
  });
});