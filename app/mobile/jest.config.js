try {
    const jestMockPath = require.resolve('jest-mock', { paths: [require.resolve('jest-environment-node')] });
    const { ModuleMocker } = require(jestMockPath);
    if (ModuleMocker && !ModuleMocker.prototype.clearMocksOnScope) {
        ModuleMocker.prototype.clearMocksOnScope = function () {};
    }
} catch (_) {}

module.exports = {
    preset: 'jest-expo',
    setupFilesAfterEnv: ['<rootDir>/jest.setup.js'],
    moduleNameMapper: {
        '^@react-native/assets-registry/registry$': require.resolve('react-native/asset-registry'),
        // Stub out native modules that crash in the Jest/jsdom environment
        'react-native-safe-area-context': require.resolve(
            './__mocks__/react-native-safe-area-context.js'
        ),
        '^@react-native/assets-registry/registry$': require.resolve(
            './__mocks__/@react-native/assets-registry/registry.js'
        ),
    },
};
