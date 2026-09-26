import { getWalletSession } from "./wallet-session";
import type { BackendMetadata } from "../src/config/environment";

export interface AccountContext {
  publicKey: string;
}

export interface BootstrapResponse {
  metadata: BackendMetadata;
  unreadCount: number;
  featureFlags: Record<string, boolean>;
  accountContext: AccountContext | null;
  degraded?: boolean;
}

export interface FetchBootstrapOptions {
  allowDegraded?: boolean;
  currentEnvironmentId?: string;
}

export interface BootstrapTelemetry {
  status: "success" | "degraded" | "failure";
  durationMs: number;
  authenticated: boolean;
  statusCode?: number;
  errorMessage?: string;
}

/**
 * Structured logger for session bootstrap observability without leaking secrets.
 */
export function recordBootstrapTelemetry(metric: BootstrapTelemetry): void {
  // Production observability telemetry
  if (__DEV__) {
    console.log("[SessionBootstrap]", JSON.stringify(metric));
  }
}

/**
 * Fetches the session bootstrap data including environment metadata,
 * feature flags, unread counts, and account context.
 * 
 * If a wallet session exists, it attaches the public key as a Bearer token
 * to fetch authenticated data (e.g. unread count). Otherwise, it fetches
 * guest data.
 * 
 * In degraded mode (e.g. backend unreachable or offline), it falls back
 * gracefully to safe defaults preserving self-custodial account context.
 */
export async function fetchSessionBootstrap(
  apiUrl: string,
  options?: FetchBootstrapOptions,
): Promise<BootstrapResponse> {
  const startTime = Date.now();
  const session = await getWalletSession();
  const authenticated = Boolean(session?.publicKey);

  const headers: Record<string, string> = {
    Accept: "application/json",
    "Content-Type": "application/json",
  };
  
  if (session?.publicKey) {
    // We use the publicKey as a Bearer token for the session.
    headers["Authorization"] = `Bearer ${session.publicKey}`;
  }
  
  const baseUrl = apiUrl.replace(/\/$/, "");
  try {
    const response = await fetch(`${baseUrl}/session/bootstrap`, {
      method: "GET",
      headers,
    });
    
    if (!response.ok) {
      let message = `Bootstrap failed with status ${response.status}`;
      try {
        const body = (await response.json()) as { message?: string };
        if (body.message) message = body.message;
      } catch {
        // keep status-code message
      }

      if (options?.allowDegraded) {
        recordBootstrapTelemetry({
          status: "degraded",
          durationMs: Date.now() - startTime,
          authenticated,
          statusCode: response.status,
          errorMessage: message,
        });

        return {
          metadata: {
            appVersion: "1.0.0",
            minAppVersion: "1.0.0",
            environment: options.currentEnvironmentId ?? "production",
            stellarNetwork: session?.network ?? "testnet",
          },
          unreadCount: 0,
          featureFlags: {
            "testnet.contract_writes": true,
            "mainnet.contract_writes": false,
          },
          accountContext: session?.publicKey ? { publicKey: session.publicKey } : null,
          degraded: true,
        };
      }

      recordBootstrapTelemetry({
        status: "failure",
        durationMs: Date.now() - startTime,
        authenticated,
        statusCode: response.status,
        errorMessage: message,
      });
      throw new Error(message);
    }
    
    const data = (await response.json()) as BootstrapResponse;
    recordBootstrapTelemetry({
      status: "success",
      durationMs: Date.now() - startTime,
      authenticated,
      statusCode: response.status,
    });
    return data;
  } catch (error: any) {
    if (options?.allowDegraded) {
      recordBootstrapTelemetry({
        status: "degraded",
        durationMs: Date.now() - startTime,
        authenticated,
        errorMessage: error?.message,
      });

      return {
        metadata: {
          appVersion: "1.0.0",
          minAppVersion: "1.0.0",
          environment: options.currentEnvironmentId ?? "production",
          stellarNetwork: session?.network ?? "testnet",
        },
        unreadCount: 0,
        featureFlags: {
          "testnet.contract_writes": true,
          "mainnet.contract_writes": false,
        },
        accountContext: session?.publicKey ? { publicKey: session.publicKey } : null,
        degraded: true,
      };
    }

    recordBootstrapTelemetry({
      status: "failure",
      durationMs: Date.now() - startTime,
      authenticated,
      errorMessage: error?.message,
    });
    throw error;
  }
}

