import AsyncStorage from "@react-native-async-storage/async-storage";
import * as Notifications from "expo-notifications";

import { getWalletSession, isValidStellarPublicKey } from "./wallet-session";
import { enqueueAction, registerActionHandler } from "./offline-queue";
import type { PushTokenSyncResult, PushTokenSyncOutcome } from "../types/push-notification";

export const PUSH_TOKEN_STORAGE_KEY = "quickex.push-token.v1";
export const PUSH_TOKEN_PUBLIC_KEY_STORAGE_KEY = "quickex.push-token.public-key.v1";
export const PUSH_TOKEN_STATUS_KEY = "quickex.push-token.status.v1";

export const PUSH_TOKEN_SYNC_ACTION = "push.token-sync";
export const PUSH_TOKEN_REVOKE_ACTION = "push.token-revoke";

function getApiBaseUrl(): string {
  const baseUrl =
    (globalThis as any)?.API_BASE_URL ??
    process.env.EXPO_PUBLIC_API_URL ??
    "http://localhost:3000";

  return String(baseUrl).replace(/\/$/, "");
}

export interface PushTelemetry {
  event: "register" | "rotate" | "revoke" | "offline_queue" | "permission_denied";
  publicKeyPrefix?: string;
  outcome?: PushTokenSyncOutcome;
  error?: string;
}

export function recordPushTelemetry(telemetry: PushTelemetry): void {
  if (__DEV__) {
    console.log("[PushNotifications]", JSON.stringify(telemetry));
  }
}

export async function ensureNotificationPermissions(): Promise<boolean> {
  try {
    const permissions = await Notifications.getPermissionsAsync();
    if (permissions?.granted) return true;

    if (!Notifications.requestPermissionsAsync) return false;

    const requested = await Notifications.requestPermissionsAsync();
    return Boolean(requested?.granted);
  } catch {
    return false;
  }
}

export async function resolveExpoPushToken(): Promise<string | null> {
  try {
    if (Notifications.getExpoPushTokenAsync) {
      const token = await Notifications.getExpoPushTokenAsync();
      if (token?.data) return token.data;
    }

    if (Notifications.registerForPushNotificationsAsync) {
      const token = await Notifications.registerForPushNotificationsAsync();
      if (token?.data) return token.data;
    }
  } catch {
    return null;
  }

  return null;
}

export async function getStoredPushToken(): Promise<{
  pushToken: string | null;
  publicKey: string | null;
}> {
  try {
    const [pushToken, publicKey] = await Promise.all([
      AsyncStorage.getItem(PUSH_TOKEN_STORAGE_KEY),
      AsyncStorage.getItem(PUSH_TOKEN_PUBLIC_KEY_STORAGE_KEY),
    ]);
    return { pushToken, publicKey };
  } catch {
    return { pushToken: null, publicKey: null };
  }
}

/**
 * Sends push token registration to backend.
 */
export async function upsertPushNotificationPreference(
  publicKey: string,
  pushToken: string,
): Promise<boolean> {
  const response = await fetch(
    `${getApiBaseUrl()}/notifications/preferences/${encodeURIComponent(publicKey)}`,
    {
      method: "PUT",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        channel: "push",
        pushToken,
        enabled: true,
        events: null,
      }),
    },
  );

  if (!response.ok) {
    let message = `Push registration failed (${response.status})`;
    try {
      const body = (await response.json()) as { message?: string };
      if (body.message) message = body.message;
    } catch {
      // surface status-based message
    }
    throw new Error(message);
  }

  return true;
}

/**
 * Opts out/disables push token on backend.
 */
export async function deletePushNotificationPreference(
  publicKey: string,
): Promise<boolean> {
  const response = await fetch(
    `${getApiBaseUrl()}/notifications/preferences/${encodeURIComponent(publicKey)}/push`,
    {
      method: "DELETE",
      headers: {
        Accept: "application/json",
      },
    },
  );

  if (!response.ok && response.status !== 404) {
    let message = `Push revocation failed (${response.status})`;
    try {
      const body = (await response.json()) as { message?: string };
      if (body.message) message = body.message;
    } catch {
      // surface status-based message
    }
    throw new Error(message);
  }

  return true;
}

function isValidPublicKey(key: unknown): boolean {
  return typeof key === "string" && key.startsWith("G") && key.length >= 10;
}

/**
 * Registers push notification token for a public key.
 */
export async function registerPushNotificationToken(
  publicKey: string,
  explicitToken?: string,
): Promise<PushTokenSyncResult> {
  if (!publicKey || !isValidPublicKey(publicKey)) {
    recordPushTelemetry({
      event: "register",
      outcome: "skipped",
      error: "Invalid or missing Stellar public key",
    });
    return { success: false, outcome: "skipped", reason: "Invalid public key" };
  }

  const hasPermission = await ensureNotificationPermissions();
  if (!hasPermission) {
    recordPushTelemetry({
      event: "permission_denied",
      publicKeyPrefix: publicKey.slice(0, 8),
      outcome: "skipped",
    });
    return { success: false, outcome: "skipped", reason: "Permission denied" };
  }

  const token = explicitToken ?? (await resolveExpoPushToken());
  if (!token) {
    return { success: false, outcome: "skipped", reason: "Could not resolve token" };
  }

  const stored = await getStoredPushToken();
  if (stored.pushToken === token && stored.publicKey === publicKey) {
    return { success: true, outcome: "unchanged", pushToken: token };
  }

  try {
    await upsertPushNotificationPreference(publicKey, token);
    await AsyncStorage.setItem(PUSH_TOKEN_STORAGE_KEY, token);
    await AsyncStorage.setItem(PUSH_TOKEN_PUBLIC_KEY_STORAGE_KEY, publicKey);
    await AsyncStorage.setItem(PUSH_TOKEN_STATUS_KEY, "registered");

    recordPushTelemetry({
      event: "register",
      publicKeyPrefix: publicKey.slice(0, 8),
      outcome: "registered",
    });

    return { success: true, outcome: "registered", pushToken: token };
  } catch (error: any) {
    // Graceful offline fallback: enqueue typed offline action
    await enqueueAction(
      PUSH_TOKEN_SYNC_ACTION,
      { publicKey, pushToken: token },
      { idempotencyKey: `push-sync-${publicKey}` },
    );

    await AsyncStorage.setItem(PUSH_TOKEN_STORAGE_KEY, token);
    await AsyncStorage.setItem(PUSH_TOKEN_PUBLIC_KEY_STORAGE_KEY, publicKey);
    await AsyncStorage.setItem(PUSH_TOKEN_STATUS_KEY, "registered");

    recordPushTelemetry({
      event: "offline_queue",
      publicKeyPrefix: publicKey.slice(0, 8),
      outcome: "registered",
      error: error?.message,
    });

    return {
      success: true,
      outcome: "registered",
      reason: "queued-offline",
      pushToken: token,
    };
  }
}

/**
 * Rotates push notification token when token changes or when explicitly requested.
 */
export async function rotatePushNotificationToken(
  publicKey: string,
  newToken?: string,
): Promise<PushTokenSyncResult> {
  if (!publicKey || !isValidPublicKey(publicKey)) {
    return { success: false, outcome: "skipped", reason: "Invalid public key" };
  }

  const token = newToken ?? (await resolveExpoPushToken());
  if (!token) {
    return { success: false, outcome: "skipped", reason: "Could not resolve new token" };
  }

  const stored = await getStoredPushToken();
  if (stored.pushToken === token && stored.publicKey === publicKey) {
    return { success: true, outcome: "unchanged", pushToken: token };
  }

  try {
    await upsertPushNotificationPreference(publicKey, token);
    await AsyncStorage.setItem(PUSH_TOKEN_STORAGE_KEY, token);
    await AsyncStorage.setItem(PUSH_TOKEN_PUBLIC_KEY_STORAGE_KEY, publicKey);
    await AsyncStorage.setItem(PUSH_TOKEN_STATUS_KEY, "registered");

    recordPushTelemetry({
      event: "rotate",
      publicKeyPrefix: publicKey.slice(0, 8),
      outcome: "rotated",
    });

    return { success: true, outcome: "rotated", pushToken: token };
  } catch (error: any) {
    await enqueueAction(
      PUSH_TOKEN_SYNC_ACTION,
      { publicKey, pushToken: token },
      { idempotencyKey: `push-rotate-${publicKey}` },
    );

    await AsyncStorage.setItem(PUSH_TOKEN_STORAGE_KEY, token);
    await AsyncStorage.setItem(PUSH_TOKEN_PUBLIC_KEY_STORAGE_KEY, publicKey);

    recordPushTelemetry({
      event: "offline_queue",
      publicKeyPrefix: publicKey.slice(0, 8),
      outcome: "rotated",
      error: error?.message,
    });

    return {
      success: true,
      outcome: "rotated",
      reason: "queued-offline",
      pushToken: token,
    };
  }
}

/**
 * Revokes push notification registration (e.g. on disconnect or opt-out).
 */
export async function revokePushNotificationToken(
  publicKey?: string,
): Promise<PushTokenSyncResult> {
  const stored = await getStoredPushToken();
  const targetKey = publicKey ?? stored.publicKey;

  if (!targetKey) {
    return { success: true, outcome: "skipped", reason: "No active token registered" };
  }

  try {
    await deletePushNotificationPreference(targetKey);
    await AsyncStorage.removeItem(PUSH_TOKEN_STORAGE_KEY);
    await AsyncStorage.removeItem(PUSH_TOKEN_PUBLIC_KEY_STORAGE_KEY);
    await AsyncStorage.setItem(PUSH_TOKEN_STATUS_KEY, "revoked");

    recordPushTelemetry({
      event: "revoke",
      publicKeyPrefix: targetKey.slice(0, 8),
      outcome: "revoked",
    });

    return { success: true, outcome: "revoked" };
  } catch (error: any) {
    await enqueueAction(
      PUSH_TOKEN_REVOKE_ACTION,
      { publicKey: targetKey },
      { idempotencyKey: `push-revoke-${targetKey}` },
    );

    await AsyncStorage.removeItem(PUSH_TOKEN_STORAGE_KEY);
    await AsyncStorage.removeItem(PUSH_TOKEN_PUBLIC_KEY_STORAGE_KEY);
    await AsyncStorage.setItem(PUSH_TOKEN_STATUS_KEY, "revoked");

    recordPushTelemetry({
      event: "offline_queue",
      publicKeyPrefix: targetKey.slice(0, 8),
      outcome: "revoked",
      error: error?.message,
    });

    return {
      success: true,
      outcome: "revoked",
      reason: "queued-offline",
    };
  }
}

/**
 * Backward-compatible helper for existing callers.
 */
export async function syncPushNotificationToken(
  publicKey?: string,
): Promise<boolean> {
  if (!publicKey) return false;
  const result = await registerPushNotificationToken(publicKey);
  return result.success;
}

export async function syncPushNotificationTokenForActiveWallet(): Promise<boolean> {
  const walletSession = await getWalletSession();
  if (!walletSession?.publicKey) return false;

  return syncPushNotificationToken(walletSession.publicKey);
}

// ── Register durable typed offline handlers ─────────────────────────────────

registerActionHandler(
  PUSH_TOKEN_SYNC_ACTION,
  async (payload: { publicKey: string; pushToken: string }) => {
    if (!payload.publicKey || !payload.pushToken) {
      throw new Error("Missing parameters for push token sync");
    }
    await upsertPushNotificationPreference(payload.publicKey, payload.pushToken);
  },
);

registerActionHandler(
  PUSH_TOKEN_REVOKE_ACTION,
  async (payload: { publicKey: string }) => {
    if (!payload.publicKey) {
      throw new Error("Missing publicKey for push token revoke");
    }
    await deletePushNotificationPreference(payload.publicKey);
  },
);