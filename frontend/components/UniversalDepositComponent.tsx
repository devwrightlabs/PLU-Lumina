/**
 * UniversalDepositComponent.tsx — Omnichain deposit gateway placeholder.
 *
 * This component will evolve into the primary interaction surface for:
 *  - Native π deposits routed through the Pi SDK payment flow.
 *  - Cross-chain asset bridging (piBTC, piETH) via the Lumina bridge layer.
 *  - 2-of-2 multi-sig escrow initiation, tracked in the Zustand store.
 *
 * For Phase 11 this renders an inert skeleton that demonstrates the
 * enterprise-grade layout and wires up the store hooks so that later
 * phases can activate functionality without structural refactoring.
 */

"use client";

import { useLuminaStore } from "@/lib/store";

export function UniversalDepositComponent() {
  const { piSession, balances } = useLuminaStore();

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

      {/* ── Deposit Action ────────────────────────────────────────────── */}
      <button
        disabled
        aria-label="Initiate deposit — requires active Pi wallet connection"
        className="w-full cursor-not-allowed rounded-xl bg-[#F0C040]/10 py-3 text-sm font-semibold tracking-widest text-[#F0C040]/40 uppercase transition-colors"
      >
        {piSession.status === "connected"
          ? "Initiate Deposit"
          : "Connect Pi Wallet to Continue"}
      </button>

      {/* ── Phase note (remove before production) ─────────────────────── */}
      <p className="mt-4 text-center text-[10px] text-white/20">
        Phase 12 will activate Pi SDK payment flow and bridge listeners.
      </p>
    </section>
  );
}
