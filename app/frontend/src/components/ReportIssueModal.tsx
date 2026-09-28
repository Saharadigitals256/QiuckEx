"use client";

import { useEffect, useMemo, useState } from "react";
import { redactPII } from "@/lib/errorReporter";
import { useFocusTrap } from "@/hooks/useFocusTrap";

type ReportIssueModalProps = {
  open: boolean;
  onClose: () => void;
  errorSummary: string;
  requestId?: string;
  onSubmit: (payload: { userMessage?: string }) => Promise<void> | void;
};

export function ReportIssueModal({
  open,
  onClose,
  errorSummary,
  requestId,
  onSubmit,
}: ReportIssueModalProps) {
  const [userMessage, setUserMessage] = useState("");
  const [status, setStatus] = useState<"idle" | "submitting" | "success">(
    "idle"
  );
  useEffect(() => {
    if (open) setStatus("idle");
  }, [open]);

  const sanitizedSummary = useMemo(
    () => String(redactPII(errorSummary)),
    [errorSummary]
  );

  const handleClose = () => {
    setUserMessage("");
    setStatus("idle");
    onClose();
  };

  const modalRef = useFocusTrap<HTMLDivElement>(open, handleClose);

  const handleSubmit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setStatus("submitting");

    const safeMessage = redactPII(userMessage);
    await onSubmit({
      userMessage:
        typeof safeMessage === "string" ? safeMessage : String(safeMessage),
    });

    setStatus("success");
  };

  if (!open) {
    return null;
  }

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="report-issue-title"
      className="fixed inset-0 z-50 flex items-center justify-center bg-background/50 px-4 py-6"
    >
      <div
        ref={modalRef}
        className="w-full max-w-2xl rounded-3xl bg-background p-8 shadow-2xl shadow-black/50"
      >
        <div className="flex items-start justify-between gap-4">
          <div>
            <h2
              id="report-issue-title"
              className="text-2xl font-semibold text-foreground"
            >
              Report an issue
            </h2>
            <p className="mt-2 text-sm text-subtle">
              We will send a report with your request details and the error
              summary.
            </p>
          </div>
          <button
            type="button"
            onClick={handleClose}
            className="rounded-full bg-surface-strong px-4 py-2 text-sm text-foreground transition hover:bg-surface-strong"
          >
            Close
          </button>
        </div>

        <div className="mt-6 space-y-4 rounded-3xl border border-border-strong bg-surface p-4">
          <p className="text-sm font-semibold text-muted">
            Error summary
          </p>
          <p className="whitespace-pre-wrap rounded-2xl bg-card p-4 text-sm text-muted">
            {sanitizedSummary || "No summary available."}
          </p>

          <div className="grid gap-2 sm:grid-cols-[1fr_auto]">
            <div>
              <label className="text-sm text-muted">Request ID</label>
              <div className="mt-2 overflow-hidden rounded-2xl bg-card px-3 py-2 text-sm text-muted">
                {requestId || "Unavailable"}
              </div>
            </div>
          </div>
        </div>

        <form onSubmit={handleSubmit} className="mt-6 space-y-4">
          <label className="block text-sm font-semibold text-muted">
            Additional details
          </label>
          <textarea
            value={userMessage}
            onChange={(event) => setUserMessage(event.target.value)}
            rows={5}
            className="w-full rounded-3xl border border-border-strong bg-card px-4 py-3 text-sm text-foreground outline-none transition focus:border-white/30"
            placeholder="What were you doing when this happened?"
          />
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <p className="text-xs text-subtle">
              Your message will be sanitized before sending.
            </p>
            <button
              type="submit"
              disabled={status === "submitting" || status === "success"}
              className="inline-flex items-center justify-center rounded-full bg-card px-6 py-3 text-sm font-semibold text-foreground transition hover:bg-surface-strong disabled:cursor-not-allowed disabled:opacity-50"
            >
              {status === "submitting" ? "Sending..." : "Send report"}
            </button>
          </div>
        </form>

        {status === "success" ? (
          <div className="mt-4 rounded-3xl bg-success-soft px-4 py-3 text-sm text-success">
            Issue report submitted successfully.
          </div>
        ) : null}
      </div>
    </div>
  );
}
