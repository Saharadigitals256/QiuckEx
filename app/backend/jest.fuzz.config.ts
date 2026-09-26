import type { Config } from 'jest';

const config: Config = {
    moduleFileExtensions: ['js', 'json', 'ts'],
    rootDir: '.',
    testRegex: ['.fuzz.spec.ts$'],
    transform: {
        '^.+\\.(t|j)s$': 'ts-jest',
    },
    testEnvironment: 'node',
    // Fuzz tests need long timeouts because they run thousands of iterations
    testTimeout: 120_000,
    // Property-based tests for username normalization and uniqueness (#201)
    // run many generated cases; keep them isolated and deterministic.
    maxWorkers: 1,
    clearMocks: true,
    restoreMocks: true,
};

export default config;