import base from "./jest.config";

export default {
  ...base,
  testRegex: ".*\\.e2e-spec\\.ts$",
  // End-to-end testnet coverage for native (XLM) and issued-asset payments.
  // These suites exercise the real payment path against Stellar testnet and are
  // explicitly gated so they never run against mainnet. Set
  // STELLAR_NETWORK=testnet (and the testnet funding secrets) to enable them.
  testTimeout: 60_000,
  setupFilesAfterEnv: [
    ...(base.setupFilesAfterEnv ?? []),
    "<rootDir>/test/setup/testnet-payments.setup.ts",
  ],
};
