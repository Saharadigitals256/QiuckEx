"use client";

import { useState } from "react";
import { detectWallets, type WalletId } from "@/lib/wallet/detectWallets";
import {
  WalletUserDeniedError,
  connectWallet,
  fetchUnsignedXdr,
  signXdr,
  submitSignedXdr,
} from "@/lib/wallet/walletSigning";

type SigningStep = "idle" | "connecting" | "composing" | "signing" | "submitting" | "done" | "error";

interface WalletSigningFlowProps {
  composeParams?: Record<string, unknown>;
  onComplete?: (result: unknown) => void;
}

const STEP_LABELS: Record<SigningStep, string> = {
  idle: "Choose a wallet to begin.",
  connecting: "Connecting to wallet...",
  composing: "Preparing transaction...",
  signing: "Waiting for signature in your wallet...",
  submitting: "Submitting transaction to the network...",
  done: "Transaction submitted.",
  error: "Something went wrong.",
};

export function WalletSigningFlow({ composeParams = {}, onComplete }: WalletSigningFlowProps) {
  const [step, setStep] = useState<SigningStep>("idle");
  const [activeWalletId, setActiveWalletId] = useState<WalletId | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [denied, setDenied] = useState(false);
  const [announcement, setAnnouncement] = useState<string>("");
  const [alertAnnouncement, setAlertAnnouncement] = useState<string>("");
  const wallets = detectWallets();

  const runFlow = async (walletId: WalletId) => {
    const walletObj = wallets.find((w) => w.id === walletId);
    const walletName = walletObj?.name || "Stellar";
    setActiveWalletId(walletId);
    setError(null);
    setDenied(false);
    setAlertAnnouncement("");

    try {
      setStep("connecting");
      setAnnouncement(`Connecting to ${walletName} wallet...`);
      const publicKey = await connectWallet(walletId);

      setStep("composing");
      setAnnouncement(`Connected to ${walletName}. Preparing transaction...`);
      const xdr = await fetchUnsignedXdr({ ...composeParams, publicKey });

      setStep("signing");
      setAnnouncement(`Waiting for transaction signature in your ${walletName} wallet...`);
      const signedXdr = await signXdr(walletId, xdr);

      setStep("submitting");
      setAnnouncement("Signature received. Submitting transaction to the Stellar network...");
      const result = await submitSignedXdr(signedXdr);

      setStep("done");
      setAnnouncement("Transaction successfully submitted and confirmed on the Stellar network.");
      onComplete?.(result);
    } catch (err) {
      if (err instanceof WalletUserDeniedError) {
        setDenied(true);
        setStep("idle");
        const denialMsg = `Signature request declined in ${walletName} wallet. No transaction was submitted.`;
        setAlertAnnouncement(denialMsg);
        return;
      }
      const errorMsg = err instanceof Error ? err.message : "Signing failed.";
      setError(errorMsg);
      setStep("error");
      setAlertAnnouncement(`Wallet signing failed: ${errorMsg}`);
    } finally {
      setActiveWalletId(null);
    }
  };

  return (
    <div className="space-y-4">
      {/* Accessible live region announcements for screen readers */}
      <div className="sr-only" aria-live="polite" aria-atomic="true" role="status">
        {announcement}
      </div>
      <div className="sr-only" aria-live="assertive" aria-atomic="true" role="alert">
        {alertAnnouncement}
      </div>

      <div className="flex gap-2">
        {wallets.map((wallet) => {
          const isBusy = activeWalletId === wallet.id && (step === "connecting" || step === "signing");
          return (
            <button
              key={wallet.id}
              type="button"
              disabled={!wallet.available || (step !== "idle" && step !== "error")}
              aria-busy={isBusy}
              aria-label={
                wallet.available
                  ? `Connect and sign with ${wallet.name}`
                  : `${wallet.name} (not detected in browser)`
              }
              onClick={() => runFlow(wallet.id)}
              className="rounded-md border px-3 py-2 text-sm font-medium disabled:opacity-40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-300"
            >
              {wallet.name}
              {!wallet.available && " (not detected)"}
            </button>
          );
        })}
      </div>

      {step !== "idle" && (
        <p className="text-sm text-muted-foreground" role="status" aria-live="polite">
          {STEP_LABELS[step]}
        </p>
      )}

      {denied && (
        <p className="text-sm text-amber-500" role="alert" aria-live="assertive">
          You declined the request in your wallet. No transaction was submitted.
        </p>
      )}

      {error && (
        <p className="text-sm text-red-500" role="alert" aria-live="assertive">
          {error}
        </p>
      )}
    </div>
  );
}

export default WalletSigningFlow;
