import base from "./jest.config";

export default {
  ...base,
  testRegex: ".*\\.int\\.spec\\.ts$",
  coverageThreshold: undefined,
  // Security regression suite for rate-limit bypass techniques (#208).
  // These integration specs exercise the rate limiter end to end against a
  // real store so bypass attempts (header spoofing, key rotation, duplicate
  // and expired tokens, malformed input, dependency failure) are covered.
  testPathIgnorePatterns: [
    ...(base.testPathIgnorePatterns ?? []),
    "/node_modules/",
  ],
  setupFilesAfterEnv: [
    ...(base.setupFilesAfterEnv ?? []),
    "<rootDir>/test/security/rate-limit.setup.ts",
  ],
};
