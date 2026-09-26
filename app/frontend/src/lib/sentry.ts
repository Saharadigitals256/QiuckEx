/**
 * Lightweight Sentry wrapper.
 * Uses @sentry/nextjs when installed/configured; falls back to console
 * logging so error reporting never throws if Sentry isn't set up yet.
 */

import { sanitizeTelemetryContext, sanitizeTelemetryError } from "@/lib/errorReporter";

export interface CaptureContext {
  componentStack?: string | null;
  url?: string;
  user?: {
    id?: string;
    email?: string;
    username?: string;
  } | null;
  extra?: Record<string, unknown>;
}

export function captureException(error: unknown, context: CaptureContext = {}): void {
  const safeError = sanitizeTelemetryError(error);
  const safeContext = sanitizeTelemetryContext({
    route: context.url,
    componentStack: context.componentStack ?? undefined,
    extra: context.extra,
  });
  const payload = {
    route: safeContext.route,
    componentStack: safeContext.componentStack,
    extra: safeContext.extra,
  };

  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const Sentry = require("@sentry/nextjs");
    Sentry.withScope((scope: any) => {
      if (payload.route) scope.setTag("route", payload.route);
      if (payload.componentStack) scope.setExtra("componentStack", payload.componentStack);
      if (payload.extra) {
        Object.entries(payload.extra).forEach(([key, value]) => scope.setExtra(key, value));
      }
      Sentry.captureException(safeError);
    });
  } catch {
    console.error("[sentry:captureException]", safeError, payload);
  }
}
