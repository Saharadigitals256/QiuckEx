import React from 'react';
import renderer, { act } from 'react-test-renderer';

import ScanToPayScreen from '../app/scan-to-pay';

const mockReplace = jest.fn();
const mockHaptics = jest.fn(async () => undefined);
let mockPermission: { granted: boolean } | null = { granted: true };
let cameraProps: { onBarcodeScanned?: (result: { data: string }) => void } = {};

jest.mock('expo-router', () => ({
  useRouter: () => ({ replace: mockReplace, back: jest.fn() }),
}));

jest.mock('expo-camera', () => ({
  CameraView: (props: typeof cameraProps) => {
    cameraProps = props;
    return null;
  },
  useCameraPermissions: () => [mockPermission, jest.fn()],
}));

jest.mock('expo-haptics', () => ({
  notificationAsync: mockHaptics,
  NotificationFeedbackType: { Success: 'success', Error: 'error' },
}));

jest.mock('@expo/vector-icons', () => ({
  Ionicons: () => null,
}));

jest.mock('../src/theme/ThemeContext', () => ({
  useTheme: () => ({
    theme: {
      background: '#fff',
      primary: '#111',
      textPrimary: '#111',
      textSecondary: '#444',
      buttonPrimaryBg: '#111',
      buttonPrimaryText: '#fff',
    },
  }),
}));

describe('<ScanToPayScreen />', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.useRealTimers();
    mockPermission = { granted: true };
    cameraProps = {};
  });

  it('shows a camera permission action when access is unavailable', () => {
    mockPermission = { granted: false };
    const tree = renderer.create(<ScanToPayScreen />);

    expect(JSON.stringify(tree.toJSON())).toContain('Camera Permission Required');
    expect(JSON.stringify(tree.toJSON())).toContain('Grant Access');
  });

  it('routes a valid QR payment link to confirmation', async () => {
    renderer.create(<ScanToPayScreen />);

    await act(async () => {
      await cameraProps.onBarcodeScanned?.({
        data: 'https://quickex.to/jordan?amount=12.5&asset=XLM',
      });
    });

    expect(mockReplace).toHaveBeenCalledWith({
      pathname: '/payment-confirmation',
      params: {
        username: 'jordan',
        amount: '12.5000000',
        asset: 'XLM',
        privacy: 'false',
      },
    });
  });

  it('re-enables scanning after an invalid QR code', async () => {
    jest.useFakeTimers();
    renderer.create(<ScanToPayScreen />);

    await act(async () => {
      await cameraProps.onBarcodeScanned?.({ data: 'not-a-quickex-link' });
    });

    act(() => {
      jest.advanceTimersByTime(1500);
    });

    await act(async () => {
      await cameraProps.onBarcodeScanned?.({
        data: 'https://quickex.to/jordan?amount=1&asset=XLM',
      });
    });

    expect(mockReplace).toHaveBeenCalledTimes(1);
  });

  it('ignores duplicate camera callbacks while processing a scan', async () => {
    renderer.create(<ScanToPayScreen />);

    await act(async () => {
      await Promise.all([
        cameraProps.onBarcodeScanned?.({
          data: 'https://quickex.to/jordan?amount=1&asset=XLM',
        }),
        cameraProps.onBarcodeScanned?.({
          data: 'https://quickex.to/jordan?amount=2&asset=XLM',
        }),
      ]);
    });

    expect(mockReplace).toHaveBeenCalledTimes(1);
  });
});
