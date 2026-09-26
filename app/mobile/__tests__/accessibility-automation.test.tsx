import React from 'react';
import renderer, { act } from 'react-test-renderer';
import QuickReceiveScreen from '../app/quick-receive';
import PaymentConfirmationScreen from '../app/payment-confirmation';
import WalletConnectScreen from '../app/wallet-connect';

// Mock dependencies
jest.mock('expo-router', () => ({
  useRouter: () => ({
    push: jest.fn(),
    replace: jest.fn(),
    back: jest.fn(),
  }),
  useLocalSearchParams: () => ({
    username: 'alice',
    amount: '10.5',
    asset: 'USDC',
  }),
}));

jest.mock('expo-clipboard', () => ({
  setStringAsync: jest.fn(async () => true),
}));

jest.mock('uuid', () => ({
  v4: () => 'mock-uuid-1234',
}));

jest.mock('react-native-qrcode-svg', () => 'QRCode');

let mockWalletState = {
  connected: false,
  publicKey: undefined as string | undefined,
  network: 'testnet' as const,
  walletType: undefined as any,
  isConnecting: false,
  error: null as any,
};

jest.mock('../hooks/useWallet', () => ({
  useWallet: () => ({
    wallet: mockWalletState,
    switchNetwork: jest.fn(),
    connect: jest.fn(),
    disconnect: jest.fn(),
    clearError: jest.fn(),
  }),
}));

jest.mock('../src/theme/ThemeContext', () => ({
  useTheme: () => ({
    theme: {
      background: '#ffffff',
      surface: '#f5f5f5',
      textPrimary: '#111111',
      textSecondary: '#444444',
      textMuted: '#888888',
      qrBackground: '#ffffff',
      qrForeground: '#000000',
      chipBg: '#e5e7eb',
      chipText: '#1f2937',
      chipActiveBg: '#dbeafe',
      buttonPrimaryBg: '#3b82f6',
      buttonPrimaryText: '#ffffff',
      buttonSecondaryBorder: '#d1d5db',
      buttonSecondaryText: '#111111',
      buttonDangerBg: '#ef4444',
      buttonDangerText: '#ffffff',
      border: '#e5e7eb',
      divider: '#e5e7eb',
      networkMainnet: '#10b981',
      networkTestnet: '#f59e0b',
      status: {
        info: '#3b82f6',
        infoBg: '#eff6ff',
        success: '#22c55e',
        warning: '#f59e0b',
        warningBg: '#fffbeb',
        error: '#ef4444',
        errorBg: '#fef2f2',
      },
    },
    isDark: false,
    mode: 'light',
  }),
  QuickExThemeProvider: ({ children }: any) => children,
}));

jest.mock('../contexts/NetworkGuardContext', () => ({
  useNetworkGuard: () => ({
    currentNetwork: 'testnet',
    isGuarded: true,
  }),
}));

jest.mock('../hooks/useContractRegistry', () => ({
  useContractRegistry: () => ({
    isReady: true,
    status: 'verified',
    source: 'network',
    lastUpdatedLabel: 'Just now',
    fetchSource: 'network',
    missingContracts: [],
    isRefreshing: false,
    refresh: jest.fn(),
  }),
}));

jest.mock('../hooks/useWalletContext', () => ({
  SUPPORTED_WALLETS: [
    { type: 'albedo', label: 'Albedo', description: 'Browser-based signer' },
    { type: 'freighter', label: 'Freighter', description: 'Stellar browser extension' },
    { type: 'xbull', label: 'xBull', description: 'Multi-platform Stellar wallet' },
  ],
  useWalletContext: () => ({
    wallet: mockWalletState,
    switchNetwork: jest.fn(),
    connect: jest.fn(),
    disconnect: jest.fn(),
    clearError: jest.fn(),
  }),
}));

jest.mock('../hooks/use-security', () => ({
  useSecurity: () => ({
    settings: { biometricEnabled: false, pinEnabled: false },
    isAuthenticated: true,
  }),
}));

jest.mock('../components/notifications/NotificationContext', () => ({
  useNotifications: () => ({
    unreadCount: 0,
    notifications: [],
    markAsRead: jest.fn(),
  }),
}));

describe('Accessibility Automation for Core Payment & Wallet Screens (#272)', () => {
  beforeEach(() => {
    mockWalletState = {
      connected: false,
      publicKey: undefined,
      network: 'testnet',
      walletType: undefined,
      isConnecting: false,
      error: null,
    };
  });

  describe('Payment Confirmation Screen Accessibility', () => {
    it('verifies accessibility attributes on primary payment action buttons', () => {
      let tree: renderer.ReactTestRenderer;
      act(() => {
        tree = renderer.create(<PaymentConfirmationScreen />);
      });

      const root = tree!.root;

      // Pay with wallet button
      const payButton = root.findByProps({ testID: 'pay-with-wallet-button' });
      expect(payButton.props.accessibilityRole).toBe('button');
      expect(payButton.props.accessibilityLabel).toBeDefined();
      expect(payButton.props.accessibilityHint).toContain('wallet');
      expect(payButton.props.accessibilityState).toBeDefined();

      // Cancel button
      const cancelButton = root.findByProps({ testID: 'cancel-payment-button' });
      expect(cancelButton.props.accessibilityRole).toBe('button');
      expect(cancelButton.props.accessibilityLabel).toBe('Cancel payment');
      expect(cancelButton.props.accessibilityHint).toBeDefined();

      // Save contact button
      const saveContactButton = root.findByProps({ testID: 'save-contact-button' });
      expect(saveContactButton.props.accessibilityRole).toBe('button');
      expect(saveContactButton.props.accessibilityLabel).toBeDefined();
      expect(saveContactButton.props.accessibilityHint).toBeDefined();
    });
  });

  describe('Wallet Connect Screen Accessibility', () => {
    it('verifies accessibility roles, labels, and states on wallet provider options', () => {
      let tree: renderer.ReactTestRenderer;
      act(() => {
        tree = renderer.create(<WalletConnectScreen />);
      });

      const root = tree!.root;

      // Connect button
      const connectButton = root.findByProps({ testID: 'connect-wallet-button' });
      expect(connectButton.props.accessibilityRole).toBe('button');
      expect(connectButton.props.accessibilityLabel).toBe('Connect Wallet');
      expect(connectButton.props.accessibilityHint).toBeDefined();
      expect(connectButton.props.accessibilityState).toHaveProperty('disabled');

      // Wallet option items
      const albedoOption = root.findByProps({ testID: 'wallet-option-albedo' });
      expect(albedoOption.props.accessibilityRole).toBe('button');
      expect(albedoOption.props.accessibilityLabel).toContain('Albedo');
      expect(albedoOption.props.accessibilityState).toHaveProperty('selected');
    });

    it('verifies accessibility attributes on connected wallet action buttons', () => {
      mockWalletState = {
        connected: true,
        publicKey: 'GBZXN7PIRZGNMHGA728RGRVUANPTBRSEBBBVMISTA3UXXRZHS3XO73M7',
        network: 'testnet',
        walletType: 'albedo',
        isConnecting: false,
        error: null,
      };

      let tree: renderer.ReactTestRenderer;
      act(() => {
        tree = renderer.create(<WalletConnectScreen />);
      });

      const root = tree!.root;

      // Switch account button
      const switchAccountButton = root.findByProps({ testID: 'switch-account-button' });
      expect(switchAccountButton.props.accessibilityRole).toBe('button');
      expect(switchAccountButton.props.accessibilityLabel).toBe('Switch Account');

      // Reveal token button
      const revealTokenButton = root.findByProps({ testID: 'reveal-token-button' });
      expect(revealTokenButton.props.accessibilityRole).toBe('button');
      expect(revealTokenButton.props.accessibilityLabel).toBe('Reveal Secure Session Token');

      // Disconnect button
      const disconnectButton = root.findByProps({ testID: 'disconnect-wallet-button' });
      expect(disconnectButton.props.accessibilityRole).toBe('button');
      expect(disconnectButton.props.accessibilityLabel).toBe('Disconnect Wallet');
      expect(disconnectButton.props.accessibilityState).toHaveProperty('disabled');
    });
  });

  describe('Quick Receive Screen Accessibility', () => {
    it('verifies accessibility labels and hints on copy/share actions', () => {
      mockWalletState = {
        connected: true,
        publicKey: 'GBZXN7PIRZGNMHGA728RGRVUANPTBRSEBBBVMISTA3UXXRZHS3XO73M7',
        network: 'testnet',
        walletType: 'albedo',
        isConnecting: false,
        error: null,
      };

      let tree: renderer.ReactTestRenderer;
      act(() => {
        tree = renderer.create(<QuickReceiveScreen />);
      });

      const root = tree!.root;
      const buttons = root.findAllByProps({ accessibilityRole: 'button' });
      expect(buttons.length).toBeGreaterThanOrEqual(3);

      for (const btn of buttons) {
        expect(btn.props.accessibilityLabel).toBeTruthy();
        expect(btn.props.accessibilityHint).toBeTruthy();
      }
    });
  });
});
