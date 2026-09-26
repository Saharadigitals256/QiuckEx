/**
 * Comprehensive Scenario Tests for Mobile:
 * 1. Offline Scenarios (network degradation, queueing, retries, boundary/failure handling)
 * 2. Background Scenarios (state transitions, periodic sync, deduplication, battery/wifi constraints)
 * 3. App-Restart Scenarios (cold boot rehydration, session validation, launch sync, crash recovery)
 */

import AsyncStorage from "@react-native-async-storage/async-storage";
import NetInfo from "@react-native-community/netinfo";
import { AppState } from "react-native";

import {
  enqueueAction,
  dequeueAction,
  clearOfflineQueue,
  getOfflineQueue,
  processOfflineQueue,
  registerActionHandler,
  retryQueuedAction,
} from "../services/offline-queue";
import {
  DEFAULT_BACKGROUND_SYNC_SETTINGS,
  DEFAULT_SYNC_SNAPSHOT,
  getBackgroundSyncSettings,
  getSyncSnapshot,
  getUnreadNotificationCount,
  mergeSyncSnapshot,
  performBackgroundSync,
  saveBackgroundSyncSettings,
  saveSyncSnapshot,
  configureBackgroundSyncTask,
} from "../services/background-sync";
import {
  clearWalletSession,
  getSessionInvalidReason,
  getWalletSession,
  isSessionRestorable,
  resetInvalidSession,
  saveWalletSession,
} from "../services/wallet-session";
import type { WalletSession } from "../services/wallet-session";
import { fetchTransactions } from "../services/transactions";
import type { TransactionItem } from "../types/transaction";

// Mock AsyncStorage
jest.mock("@react-native-async-storage/async-storage", () => {
  let store: Record<string, string> = {};
  return {
    getItem: jest.fn(async (key: string) => store[key] ?? null),
    setItem: jest.fn(async (key: string, value: string) => {
      store[key] = value;
    }),
    removeItem: jest.fn(async (key: string) => {
      delete store[key];
    }),
    clear: jest.fn(async () => {
      store = {};
    }),
  };
});

// Mock NetInfo
jest.mock("@react-native-community/netinfo", () => ({
  fetch: jest.fn(),
}));

// Mock transactions service
jest.mock("../services/transactions", () => ({
  fetchTransactions: jest.fn(),
}));

const TEST_ACCOUNT = "GDQP2KPQGKIHYJGXNUIYOMHARUARCA7DJT5FO2FFOOKY3B2WSQHG4W37";

const MOCK_SESSION: WalletSession = {
  publicKey: TEST_ACCOUNT,
  network: "testnet",
  walletType: "freighter",
  connectedAt: Date.now(),
  lastConfirmedAt: new Date().toISOString(),
  environmentId: "testnet",
};

describe("Mobile Offline, Background, and App-Restart Scenarios", () => {
  beforeEach(async () => {
    jest.clearAllMocks();
    await AsyncStorage.clear();

    // Default network state: Online, WiFi
    (NetInfo.fetch as jest.Mock).mockResolvedValue({
      isConnected: true,
      type: "wifi",
      isInternetReachable: true,
    });

    // Default AppState
    Object.defineProperty(AppState, "currentState", {
      value: "active",
      configurable: true,
      writable: true,
    });
  });

  afterEach(async () => {
    await clearOfflineQueue();
    await clearWalletSession();
  });

  // =========================================================================
  // 1. OFFLINE SCENARIOS
  // =========================================================================
  describe("1. Offline Scenarios", () => {
    const OFFLINE_PAYLOAD = { recipient: "GBB...", amount: "50", asset: "XLM" };

    it("enqueues user actions into offline queue when device is disconnected", async () => {
      (NetInfo.fetch as jest.Mock).mockResolvedValue({
        isConnected: false,
        type: "none",
        isInternetReachable: false,
      });

      const action = await enqueueAction("payment.submit", OFFLINE_PAYLOAD);

      expect(action).toBeDefined();
      expect(action.id).toMatch(/^act_\d+_/);
      expect(action.type).toBe("payment.submit");
      expect(action.payload).toEqual(OFFLINE_PAYLOAD);
      expect(action.status).toBe("pending");
      expect(action.attempts).toBe(0);

      const queue = await getOfflineQueue();
      expect(queue).toHaveLength(1);
      expect(queue[0].id).toBe(action.id);
    });

    it("skips background sync cleanly when offline without throwing unhandled exceptions", async () => {
      await saveWalletSession(MOCK_SESSION);
      (NetInfo.fetch as jest.Mock).mockResolvedValue({
        isConnected: false,
        type: "none",
        isInternetReachable: false,
      });

      const result = await performBackgroundSync("manual");

      expect(result.status).toBe("skipped");
      expect(result.detail).toBe("offline");
      expect(fetchTransactions).not.toHaveBeenCalled();
    });

    it("retries and resolves queued actions once network connectivity is restored", async () => {
      let networkAvailable = false;
      const executedActions: any[] = [];

      registerActionHandler("payment.submit", async (payload) => {
        if (!networkAvailable) {
          throw new Error("Network unavailable");
        }
        executedActions.push(payload);
      });

      // Enqueue action while offline
      const action = await enqueueAction("payment.submit", OFFLINE_PAYLOAD);

      // Attempt processing while offline: should mark as failed with error reason
      await processOfflineQueue();
      let queue = await getOfflineQueue();
      expect(queue[0].status).toBe("failed");
      expect(queue[0].attempts).toBe(1);
      expect(queue[0].failureReason).toBe("Network unavailable");
      expect(executedActions).toHaveLength(0);

      // Network comes back online
      networkAvailable = true;
      (NetInfo.fetch as jest.Mock).mockResolvedValue({
        isConnected: true,
        type: "wifi",
        isInternetReachable: true,
      });

      // Queue is processed again on reconnection
      await processOfflineQueue();
      queue = await getOfflineQueue();
      expect(queue[0].status).toBe("completed");
      expect(queue[0].attempts).toBe(2);
      expect(queue[0].failureReason).toBeNull();
      expect(executedActions).toHaveLength(1);
      expect(executedActions[0]).toEqual(OFFLINE_PAYLOAD);
    });

    it("handles permanent handler failures with stable error records and attempts count", async () => {
      registerActionHandler("payment.invalid", async () => {
        throw new Error("Account does not exist on testnet");
      });

      const action = await enqueueAction("payment.invalid", { bad: "data" });
      const result = await retryQueuedAction(action.id);

      expect(result?.status).toBe("failed");
      expect(result?.attempts).toBe(1);
      expect(result?.failureReason).toBe("Account does not exist on testnet");

      // Verify the item is still stored in queue for inspection
      const queue = await getOfflineQueue();
      expect(queue[0].status).toBe("failed");
      expect(queue[0].failureReason).toBe("Account does not exist on testnet");
    });

    it("dequeues an action upon explicit user dismissal or manual clearing", async () => {
      const act1 = await enqueueAction("type1", { a: 1 });
      const act2 = await enqueueAction("type2", { b: 2 });

      await dequeueAction(act1.id);
      const queue = await getOfflineQueue();

      expect(queue).toHaveLength(1);
      expect(queue[0].id).toBe(act2.id);
    });
  });

  // =========================================================================
  // 2. BACKGROUND SCENARIOS
  // =========================================================================
  describe("2. Background Scenarios", () => {
    const MOCK_TXS: TransactionItem[] = [
      {
        amount: "100.0000000",
        asset: "XLM",
        memo: "Invoice 1234",
        timestamp: "2026-09-24T12:00:00Z",
        txHash: "hash-001",
        pagingToken: "token-001",
        source: "G_SENDER_1",
        destination: TEST_ACCOUNT,
        status: "Success",
      },
      {
        amount: "50.0000000",
        asset: "USDC",
        memo: "Dinner split",
        timestamp: "2026-09-24T12:30:00Z",
        txHash: "hash-002",
        pagingToken: "token-002",
        source: "G_SENDER_2",
        destination: TEST_ACCOUNT,
        status: "Success",
      },
    ];

    it("skips background sync when background execution is disabled in settings", async () => {
      await saveWalletSession(MOCK_SESSION);
      await saveBackgroundSyncSettings({
        ...DEFAULT_BACKGROUND_SYNC_SETTINGS,
        enabled: false,
      });

      const result = await performBackgroundSync("background");

      expect(result.status).toBe("skipped");
      expect(result.detail).toBe("disabled");
      expect(fetchTransactions).not.toHaveBeenCalled();
    });

    it("skips background sync when no active wallet session is present", async () => {
      await clearWalletSession();

      const result = await performBackgroundSync("background");

      expect(result.status).toBe("skipped");
      expect(result.detail).toBe("no-wallet");
      expect(fetchTransactions).not.toHaveBeenCalled();
    });

    it("respects wifi-only constraint during background execution when on cellular network", async () => {
      await saveWalletSession(MOCK_SESSION);
      await saveBackgroundSyncSettings({
        ...DEFAULT_BACKGROUND_SYNC_SETTINGS,
        wifiOnly: true,
      });

      (NetInfo.fetch as jest.Mock).mockResolvedValue({
        isConnected: true,
        type: "cellular",
        isInternetReachable: true,
      });

      const result = await performBackgroundSync("background");

      expect(result.status).toBe("skipped");
      expect(result.detail).toBe("wifi-required");
      expect(fetchTransactions).not.toHaveBeenCalled();
    });

    it("fetches transactions and updates snapshot with unread items in background mode", async () => {
      await saveWalletSession(MOCK_SESSION);
      (fetchTransactions as jest.Mock).mockResolvedValue({
        items: MOCK_TXS,
        cursor: "token-002",
      });

      // Prime snapshot as initially completed
      await saveSyncSnapshot({
        ...DEFAULT_SYNC_SNAPSHOT,
        currentAccountId: TEST_ACCOUNT,
        initialSyncCompleted: true,
      });

      // Transition app to background
      Object.defineProperty(AppState, "currentState", {
        value: "background",
        configurable: true,
      });

      const result = await performBackgroundSync("background");

      expect(result.status).toBe("updated");
      expect(result.reason).toBe("background");
      expect(result.snapshot.notifications).toHaveLength(2);
      expect(getUnreadNotificationCount(result.snapshot)).toBe(2);

      // Verify persistence to AsyncStorage
      const storedSnapshot = await getSyncSnapshot();
      expect(storedSnapshot.notifications).toHaveLength(2);
      expect(storedSnapshot.lastSuccessfulSyncAt).not.toBeNull();
    });

    it("deduplicates transactions across repeated background sync cycles", async () => {
      await saveWalletSession(MOCK_SESSION);
      (fetchTransactions as jest.Mock).mockResolvedValue({
        items: MOCK_TXS,
      });

      await saveSyncSnapshot({
        ...DEFAULT_SYNC_SNAPSHOT,
        initialSyncCompleted: true,
      });

      // First background sync
      const res1 = await performBackgroundSync("background");
      expect(res1.snapshot.notifications).toHaveLength(2);

      // Second background sync with same transactions plus one new one
      const NEW_TX: TransactionItem = {
        amount: "25.0000000",
        asset: "XLM",
        memo: "New transfer",
        timestamp: "2026-09-24T13:00:00Z",
        txHash: "hash-003",
        pagingToken: "token-003",
        source: "G_SENDER_3",
        destination: TEST_ACCOUNT,
        status: "Success",
      };

      (fetchTransactions as jest.Mock).mockResolvedValue({
        items: [NEW_TX, ...MOCK_TXS],
      });

      const res2 = await performBackgroundSync("background");
      expect(res2.snapshot.notifications).toHaveLength(3);
      // Newest item should be at the top
      expect(res2.snapshot.notifications[0].id).toBe("hash-003");
    });

    it("configures background task registration for native platforms", async () => {
      const settings = {
        ...DEFAULT_BACKGROUND_SYNC_SETTINGS,
        frequency: "frequent" as const,
      };

      const result = await configureBackgroundSyncTask(settings);
      expect(result).toBeDefined();
      expect(typeof result.available).toBe("boolean");
    });
  });

  // =========================================================================
  // 3. APP-RESTART SCENARIOS
  // =========================================================================
  describe("3. App-Restart Scenarios", () => {
    it("rehydrates pending offline queue from storage across app restarts", async () => {
      // Prior app session enqueues items
      await enqueueAction("tx.draft", { id: 101, note: "Pre-restart draft" });
      await enqueueAction("tx.draft", { id: 102, note: "Pre-restart draft 2" });

      // Simulate app kill & cold restart by re-querying storage cleanly
      const rehydratedQueue = await getOfflineQueue();
      expect(rehydratedQueue).toHaveLength(2);
      expect(rehydratedQueue[0].payload.note).toBe("Pre-restart draft");
      expect(rehydratedQueue[1].payload.note).toBe("Pre-restart draft 2");
      expect(rehydratedQueue[0].status).toBe("pending");
    });

    it("rehydrates and validates active wallet session on cold boot", async () => {
      await saveWalletSession(MOCK_SESSION);

      // App cold boot: read session
      const session = await getWalletSession();
      expect(session).not.toBeNull();
      expect(session?.publicKey).toBe(TEST_ACCOUNT);
      expect(isSessionRestorable(session!)).toBe(true);

      const validity = getSessionInvalidReason(session!, "testnet");
      expect(validity.invalid).toBe(false);
    });

    it("detects expired session on restart and performs safe rollback cleanup", async () => {
      const eightDaysAgo = Date.now() - 8 * 24 * 60 * 60 * 1000;
      const expiredSession: WalletSession = {
        ...MOCK_SESSION,
        connectedAt: eightDaysAgo,
        lastConfirmedAt: new Date(eightDaysAgo).toISOString(),
      };
      await saveWalletSession(expiredSession);

      // Verify restart detects expired session
      const invalidity = getSessionInvalidReason(expiredSession, "testnet");
      expect(invalidity.invalid).toBe(true);
      expect(invalidity.reason).toBe("expired");

      // Reset invalid session on startup
      const cleanup = await resetInvalidSession("testnet");
      expect(cleanup.reason).toBe("expired");

      // Verified cleared
      const postCleanup = await getWalletSession();
      expect(postCleanup).toBeNull();
    });

    it("detects environment mismatch on restart and resets session to prevent cross-network state corruption", async () => {
      // Session was established on staging/testnet
      await saveWalletSession(MOCK_SESSION, "testnet");

      // App is restarted in production/mainnet mode
      const result = await resetInvalidSession("production");

      expect(result.reason).toBe("environment_mismatch");
      const current = await getWalletSession();
      expect(current).toBeNull();
    });

    it("runs app-launch sync on restart and marks baseline items read to avoid notification floods", async () => {
      await saveWalletSession(MOCK_SESSION);
      (fetchTransactions as jest.Mock).mockResolvedValue({
        items: [
          {
            amount: "10.0000000",
            asset: "XLM",
            memo: "Historical",
            timestamp: "2026-09-20T10:00:00Z",
            txHash: "historic-1",
            pagingToken: "p-1",
            source: "G_PREV",
            destination: TEST_ACCOUNT,
            status: "Success",
          },
        ],
      });

      // App restarts with uninitialized snapshot
      await saveSyncSnapshot(DEFAULT_SYNC_SNAPSHOT);

      const result = await performBackgroundSync("app-launch");

      expect(result.status).toBe("updated");
      expect(result.reason).toBe("app-launch");
      expect(result.snapshot.initialSyncCompleted).toBe(true);
      // Historical item is marked as read so user doesn't get flooded with badges on fresh restart
      expect(result.snapshot.notifications[0].read).toBe(true);
      expect(getUnreadNotificationCount(result.snapshot)).toBe(0);
    });

    it("handles corrupted storage state gracefully on restart without throwing", async () => {
      // Inject corrupted JSON into storage
      await AsyncStorage.setItem("quickex.offline-queue.v1", "INVALID_JSON_CORRUPT{");
      await AsyncStorage.setItem("quickex.background-sync.snapshot.v1", "INVALID_JSON_CORRUPT{");

      // App restarts: services should fall back to safe defaults without crashing
      const queue = await getOfflineQueue();
      expect(queue).toEqual([]);

      const snapshot = await getSyncSnapshot();
      expect(snapshot).toEqual(DEFAULT_SYNC_SNAPSHOT);

      const invalidCleanup = await resetInvalidSession("testnet");
      expect(invalidCleanup.reason).toBe("corrupted");
    });
  });
});
