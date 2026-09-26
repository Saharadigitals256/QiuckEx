export type ErrorContext = {
  requestId?: string;
  correlationId?: string;
  userId?: string;
  route?: string;
  componentStack?: string;
  extra?: Record<string, unknown>;
};

const EMAIL_RE = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g;
const PHONE_RE = /(\+?[\d\s\-()]{10,})/g;
const CARD_RE = /\b\d{4}[\s-]?\d{4}[\s-]?\d{4}[\s-]?\d{4}\b/g;
const STELLAR_KEY_RE = /\b[GCS][A-Z2-7]{55}\b/g;
const URL_RE = /https?:\/\/[^\s"'<>]+/gi;
const SECRET_KEY_RE = /token|secret|password|private.?key|wallet|address|memo|authorization|cookie/i;
const SAFE_ROUTES = new Set([
  "dashboard",
  "discovery",
  "generator",
  "history",
  "marketplace",
  "notifications",
  "offline",
  "pay",
  "settings",
  "admin",
  "webhooks",
]);
const SAFE_EXTRA_KEYS = new Set(["source", "feature", "section", "errorCode"]);

function redactString(value: string): string {
  return value
    .replace(CARD_RE, "[REDACTED_CARD]")
    .replace(EMAIL_RE, "[REDACTED_EMAIL]")
    .replace(PHONE_RE, "[REDACTED_PHONE]")
    .replace(STELLAR_KEY_RE, "[REDACTED_WALLET]")
    .replace(URL_RE, "[REDACTED_URL]");
}

export function redactPII(value: unknown): unknown {
  if (typeof value === "string") {
    return redactString(value);
  }

  if (Array.isArray(value)) {
    return value.map(redactPII);
  }

  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, child]) => [
        key,
        SECRET_KEY_RE.test(key) ? "[REDACTED]" : redactPII(child),
      ])
    );
  }

  return value;
}

function safeRoute(route?: string): string | undefined {
  if (!route) return undefined;
  let pathname = route;
  try {
    pathname = new URL(route, "https://quickex.invalid").pathname;
  } catch {
    return undefined;
  }
  const firstSegment = pathname.split("/").filter(Boolean)[0];
  if (!firstSegment) return "/";
  return SAFE_ROUTES.has(firstSegment.toLowerCase())
    ? `/${firstSegment.toLowerCase()}`
    : "/:dynamic";
}

export function sanitizeTelemetryContext(context: ErrorContext = {}): ErrorContext {
  const safeExtra = Object.fromEntries(
    Object.entries(context.extra ?? {})
      .filter(([key, value]) => SAFE_EXTRA_KEYS.has(key) && ["string", "number", "boolean"].includes(typeof value))
      .map(([key, value]) => [key, typeof value === "string" ? redactString(value).slice(0, 120) : value])
  );

  return {
    requestId: typeof context.requestId === "string" ? redactString(context.requestId).slice(0, 128) : undefined,
    correlationId: typeof context.correlationId === "string" ? redactString(context.correlationId).slice(0, 128) : undefined,
    route: safeRoute(context.route),
    componentStack: typeof context.componentStack === "string"
      ? redactString(context.componentStack).slice(0, 4000)
      : undefined,
    extra: safeExtra,
  };
}

export function sanitizeTelemetryError(error: unknown): Error {
  const source = error instanceof Error ? error : new Error(String(error));
  const safeError = new Error(redactString(source.message).slice(0, 1000));
  safeError.name = redactString(source.name).slice(0, 100);
  if (source.stack) safeError.stack = redactString(source.stack).slice(0, 8000);
  return safeError;
}

class ErrorReporter {
  async captureError(error: Error, context?: ErrorContext): Promise<void> {
    const enabled = process.env.NEXT_PUBLIC_ERROR_REPORTING_ENABLED === "true";
    const environment = process.env.NEXT_PUBLIC_VERCEL_ENV || process.env.NODE_ENV || "unknown";
    const appVersion = process.env.NEXT_PUBLIC_APP_VERSION || "unknown";
    const safeError = sanitizeTelemetryError(error);
    const safeContext = sanitizeTelemetryContext(context);
    const errorPayload = {
      timestamp: new Date().toISOString(),
      error: {
        name: safeError.name,
        message: safeError.message,
        stack: safeError.stack,
      },
      context: {
        ...safeContext,
        extra: safeContext.extra ?? {},
      },
      appVersion,
      environment,
    };

    if (!enabled || environment === "development") {
      console.warn("Client error reporting is disabled.");
      return;
    }

    const url = process.env.NEXT_PUBLIC_ERROR_REPORTING_URL;
    if (!url) {
      console.warn("Client error reporting URL is not configured.");
      return;
    }

    try {
      const response = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify(errorPayload),
      });
      if (!response.ok) {
        console.warn(`Client error report failed with status ${response.status}.`);
      }
    } catch (sendError) {
      console.warn("Failed to send client error report.");
    }
  }
}

export const errorReporter = new ErrorReporter();
export default errorReporter;
