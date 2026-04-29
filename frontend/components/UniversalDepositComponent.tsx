/**
 * UniversalDepositComponent.tsx — Omnichain deposit gateway.
 *
 * Phase 12: fully wired to the Pi Network SDK payment flow.
 *  - Native π deposits are routed through `usePiPayment.initiateDeposit`,
 *    which opens the Pi Wallet overlay and drives the Lumina 2-of-2 multi-sig
 *    vault signing pipeline.
 *  - Cross-chain asset bridging (piBTC, piETH) hooks are prepared for Phase 13.
 *  - All state transitions are reflected in the Zustand store in real time.
 */

"use client";

import { useState, useCallback } from "react";
import { useLuminaStore } from "@/lib/store";
import { usePiPayment } from "@/lib/usePiPayment";

export function UniversalDepositComponent() {
  const { piSession, balances } = useLuminaStore();
  const { initiateDeposit } = usePiPayment();

  const [amount, setAmount] = useState("1");
  const [depositError, setDepositError] = useState<string | null>(null);

  const isConnected = piSession.status === "connected";
  const parsedAmount = parseFloat(amount);
  // Matches the `min` attribute on the input — prevent dust amounts below the
  // Pi Network minimum transferable unit.
  const amountValid = !isNaN(parsedAmount) && parsedAmount >= 0.001;

  // ── Deposit Handler ────────────────────────────────────────────────────────
  const handleDeposit = useCallback(() => {
    if (!isConnected || !amountValid) return;

    setDepositError(null);
    try {
      // initiateDeposit is synchronous — it opens the Pi Wallet overlay
      // and drives all subsequent async steps via SDK callbacks.
      initiateDeposit({ amount: parsedAmount });
    } catch (err) {
      const message =
        err instanceof Error ? err.message : "Unknown error — see console.";
      console.error("[Lumina] Deposit initiation failed:", err);
      setDepositError(message);
    }
  }, [isConnected, amountValid, parsedAmount, initiateDeposit]);

  return (
    <section className="rounded-2xl border border-[#F0C040]/20 bg-[#0F0F1A] p-6 shadow-lg shadow-black/40">
      {/* ── Section Header ────────────────────────────────────────────── */}
      <h2 className="mb-1 text-lg font-semibold tracking-widest text-[#F0C040] uppercase">
        Universal Deposit
      </h2>
      <p className="mb-6 text-xs text-white/40">
        Deposit native π or any supported omnichain asset into your Lumina vault.
      </p>

      {/* ── Asset Balance Grid ────────────────────────────────────────── */}
      <div className="mb-6 grid grid-cols-3 gap-3">
        {(
          [
            { label: "π  Pi", value: balances.pi },
            { label: "piBTC", value: balances.piBTC },
            { label: "piETH", value: balances.piETH },
          ] as const
        ).map(({ label, value }) => (
          <div
            key={label}
            className="flex flex-col items-center rounded-xl border border-white/5 bg-[#0A0A0F] py-4"
          >
            <span className="text-[10px] font-medium tracking-widest text-white/40 uppercase">
              {label}
            </span>
            <span className="mt-1 font-mono text-xl font-bold text-[#F0C040]">
              {value}
            </span>
          </div>
        ))}
      </div>

      {/* ── Amount Input — active only when wallet is connected ───────── */}
      {isConnected && (
        <div className="mb-4">
          <label
            htmlFor="deposit-amount"
            className="mb-1 block text-[10px] font-medium tracking-widest text-white/40 uppercase"
          >
            Amount (π)
          </label>
          <input
            id="deposit-amount"
            type="number"
            value={amount}
            onChange={(e) => {
              setDepositError(null);
              setAmount(e.target.value);
            }}
            min="0.001"
            step="0.001"
            placeholder="0.000"
            aria-label="Deposit amount in Pi"
            className={[
              "w-full rounded-xl border bg-[#0A0A0F] px-4 py-2 font-mono text-sm text-[#E8E8F0]",
              "placeholder-white/20 outline-none transition-colors",
              "focus:border-[#F0C040]/50 focus:ring-1 focus:ring-[#F0C040]/20",
              amountValid || amount === ""
                ? "border-white/10"
                : "border-red-500/50",
            ].join(" ")}
          />
        </div>
      )}

      {/* ── Error Message ─────────────────────────────────────────────── */}
      {depositError && (
        <p
          role="alert"
          className="mb-3 rounded-lg border border-red-500/20 bg-red-500/10 px-3 py-2 text-xs text-red-400"
        >
          {depositError}
        </p>
      )}

      {/* ── Deposit CTA ───────────────────────────────────────────────── */}
      <button
        onClick={handleDeposit}
        disabled={!isConnected || !amountValid}
        aria-label={
          isConnected
            ? `Initiate vault deposit of ${parsedAmount} π`
            : "Connect Pi Wallet to continue"
        }
        className={[
          "w-full rounded-xl py-3 text-sm font-semibold tracking-widest uppercase transition-all duration-150",
          isConnected && amountValid
            ? "cursor-pointer bg-[#F0C040] text-[#0A0A0F] hover:bg-[#F0C040]/90"
            : "cursor-not-allowed bg-[#F0C040]/10 text-[#F0C040]/40",
        ].join(" ")}
      >
        {isConnected ? "Initiate Deposit" : "Connect Pi Wallet to Continue"}
      </button>
    </section>
  );
}
