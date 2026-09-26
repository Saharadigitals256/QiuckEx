import AsyncStorage from "@react-native-async-storage/async-storage";

import {
  syncPushNotificationToken,
  upsertPushNotificationPreference,
  registerPushNotificationToken,
  rotatePushNotificationToken,
  revokePushNotificationToken,
  PUSH_TOKEN_STORAGE_KEY,
  PUSH_TOKEN_PUBLIC_KEY_STORAGE_KEY,
  PUSH_TOKEN_STATUS_KEY,
} from "../services/push-notifications";
import { getOfflineQueue, clearOfflineQueue } from "../services/offline-queue";

describe("push notification registration, rotation, and revocation", () => {
  beforeEach(async () => {
    jest.clearAllMocks();
    await AsyncStorage.clear();
    await clearOfflineQueue();
    global.fetch = jest.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ success: true }),
    })) as any;
  });

  describe("registration", () => {
    it("registers the Expo token and persists the backend preference", async () => {
      const result = await syncPushNotificationToken("GTESTPUBLICKEY");

      expect(result).toBe(true);
      expect(global.fetch).toHaveBeenCalledWith(
        expect.stringContaining("/notifications/preferences/GTESTPUBLICKEY"),
        expect.objectContaining({
          method: "PUT",
          body: expect.stringContaining('"channel":"push"'),
        }),
      );
      expect(await AsyncStorage.getItem(PUSH_TOKEN_STORAGE_KEY)).toBe(
        "ExponentPushToken[abc123]",
      );
    });

    it("skips registration when there is no wallet public key", async () => {
      await expect(syncPushNotificationToken(undefined)).resolves.toBe(false);
      expect(global.fetch).not.toHaveBeenCalled();
    });

    it("serializes a preference payload for the API", async () => {
      await upsertPushNotificationPreference("GTESTPUBLICKEY", "ExponentPushToken[abc123]");

      expect(global.fetch).toHaveBeenCalledWith(
        expect.stringContaining("GTESTPUBLICKEY"),
        expect.objectContaining({
          method: "PUT",
          body: JSON.stringify({
            channel: "push",
            pushToken: "ExponentPushToken[abc123]",
            enabled: true,
            events: null,
          }),
        }),
      );
    });

    it("returns unchanged when stored token already matches", async () => {
      await AsyncStorage.setItem(PUSH_TOKEN_STORAGE_KEY, "ExponentPushToken[abc123]");
      await AsyncStorage.setItem(PUSH_TOKEN_PUBLIC_KEY_STORAGE_KEY, "GTESTPUBLICKEY");

      const res = await registerPushNotificationToken("GTESTPUBLICKEY", "ExponentPushToken[abc123]");
      expect(res.success).toBe(true);
      expect(res.outcome).toBe("unchanged");
      expect(global.fetch).not.toHaveBeenCalled();
    });

    it("falls back to durable offline action when network request fails", async () => {
      (global.fetch as jest.Mock).mockRejectedValueOnce(new Error("Network offline"));

      const res = await registerPushNotificationToken("GTESTPUBLICKEY", "ExponentPushToken[abc123]");
      expect(res.success).toBe(true);
      expect(res.outcome).toBe("registered");
      expect(res.reason).toBe("queued-offline");

      const queue = await getOfflineQueue();
      expect(queue).toHaveLength(1);
      expect(queue[0].type).toBe("push.token-sync");
      expect(queue[0].payload).toEqual({
        publicKey: "GTESTPUBLICKEY",
        pushToken: "ExponentPushToken[abc123]",
      });
    });
  });

  describe("rotation", () => {
    it("rotates token to a new push token and updates backend and storage", async () => {
      await AsyncStorage.setItem(PUSH_TOKEN_STORAGE_KEY, "ExponentPushToken[old]");
      await AsyncStorage.setItem(PUSH_TOKEN_PUBLIC_KEY_STORAGE_KEY, "GTESTPUBLICKEY");

      const res = await rotatePushNotificationToken("GTESTPUBLICKEY", "ExponentPushToken[new]");
      expect(res.success).toBe(true);
      expect(res.outcome).toBe("rotated");
      expect(res.pushToken).toBe("ExponentPushToken[new]");

      expect(global.fetch).toHaveBeenCalledWith(
        expect.stringContaining("/notifications/preferences/GTESTPUBLICKEY"),
        expect.objectContaining({
          method: "PUT",
          body: expect.stringContaining("ExponentPushToken[new]"),
        }),
      );
      expect(await AsyncStorage.getItem(PUSH_TOKEN_STORAGE_KEY)).toBe(
        "ExponentPushToken[new]",
      );
    });

    it("returns unchanged when rotating to the same token", async () => {
      await AsyncStorage.setItem(PUSH_TOKEN_STORAGE_KEY, "ExponentPushToken[same]");
      await AsyncStorage.setItem(PUSH_TOKEN_PUBLIC_KEY_STORAGE_KEY, "GTESTPUBLICKEY");

      const res = await rotatePushNotificationToken("GTESTPUBLICKEY", "ExponentPushToken[same]");
      expect(res.success).toBe(true);
      expect(res.outcome).toBe("unchanged");
      expect(global.fetch).not.toHaveBeenCalled();
    });
  });

  describe("revocation", () => {
    it("revokes token on backend and clears local storage", async () => {
      await AsyncStorage.setItem(PUSH_TOKEN_STORAGE_KEY, "ExponentPushToken[active]");
      await AsyncStorage.setItem(PUSH_TOKEN_PUBLIC_KEY_STORAGE_KEY, "GTESTPUBLICKEY");

      const res = await revokePushNotificationToken("GTESTPUBLICKEY");
      expect(res.success).toBe(true);
      expect(res.outcome).toBe("revoked");

      expect(global.fetch).toHaveBeenCalledWith(
        expect.stringContaining("/notifications/preferences/GTESTPUBLICKEY/push"),
        expect.objectContaining({ method: "DELETE" }),
      );
      expect(await AsyncStorage.getItem(PUSH_TOKEN_STORAGE_KEY)).toBeNull();
      expect(await AsyncStorage.getItem(PUSH_TOKEN_PUBLIC_KEY_STORAGE_KEY)).toBeNull();
      expect(await AsyncStorage.getItem(PUSH_TOKEN_STATUS_KEY)).toBe("revoked");
    });

    it("queues offline revocation if network request fails", async () => {
      await AsyncStorage.setItem(PUSH_TOKEN_STORAGE_KEY, "ExponentPushToken[active]");
      await AsyncStorage.setItem(PUSH_TOKEN_PUBLIC_KEY_STORAGE_KEY, "GTESTPUBLICKEY");

      (global.fetch as jest.Mock).mockRejectedValueOnce(new Error("Network offline"));

      const res = await revokePushNotificationToken("GTESTPUBLICKEY");
      expect(res.success).toBe(true);
      expect(res.outcome).toBe("revoked");
      expect(res.reason).toBe("queued-offline");

      const queue = await getOfflineQueue();
      const revokeAction = queue.find((a) => a.type === "push.token-revoke");
      expect(revokeAction).toBeDefined();
      expect(revokeAction?.payload).toEqual({ publicKey: "GTESTPUBLICKEY" });
    });
  });
});