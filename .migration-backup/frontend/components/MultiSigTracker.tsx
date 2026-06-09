/**
 * MultiSigTracker.tsx — Live 2-of-2 multi-sig transaction status panel.
 *
 * Reads the `multiSigTxs` map from the Zustand store and renders a
 * chronological list of all in-flight and recently settled vault deposits.
 * Each row maps a Pi payment `txId` to its current Lumina multi-sig status,
 * giving the user real-time visibility into the signing pipeline:
 *
 *   pending_owner  → User's Master Key signature requested (Pi Wallet)
 *   pending_agent  → Lumina Agent counter-signature in progress
 *   broadcasting   → Signed XDR envelope being submitted to Stellar
 *   confirmed      → On-chain confirmation received; vault credited
 *   failed         → Submission error or user cancellation
 *
 * The component intentionally shows the most recent 10 transactions to
 * avoid unbounded DOM growth.  Older entries remain in the store and are
 * accessible via the /history route (Phase 13).
 */

"use client";

import { useLuminaStore } from "@/lib/store";
import type { MultiSigTxStatus } from "@/types/lumina";

// ─── Status Display Helpers ───────────────────────────────────────────────────

const STATUS_LABEL: Record<MultiSigTxStatus, string> = {
  pending_owner: "Awaiting Your Signature",
  pending_agent: "Agent Signing…",
  broadcasting: "Broadcasting",
  confirmed: "Confirmed",
  failed: "Failed",
};

const STATUS_COLOR: Record<MultiSigTxStatus, string> = {
  pending_owner: "text-yellow-400",
  pending_agent: "text-blue-400",
  broadcasting: "text-purple-400",
  confirmed: "text-green-400",
  failed: "text-red-400",
};

const STATUS_DOT: Record<MultiSigTxStatus, string> = {
  pending_owner: "bg-yellow-400 animate-pulse",
  pending_agent: "bg-blue-400 animate-pulse",
  broadcasting: "bg-purple-400 animate-pulse",
  confirmed: "bg-green-400",
  failed: "bg-red-400",
};

// ─── Component ────────────────────────────────────────────────────────────────

export function MultiSigTracker() {
  const { multiSigTxs } = useLuminaStore();

  const txList = Object.values(multiSigTxs)
    .sort(
      (a, b) =>
        new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime(),
    )
    .slice(0, 10);

  if (txList.length === 0) {
    return (
      <p className="text-sm text-white/30">
        No in-flight transactions. Once you initiate a vault deposit the 2-of-2
        signing pipeline will appear here in real time.
      </p>
    );
  }

  return (
    <ul className="space-y-3" aria-label="Multi-sig transaction list">
      {txList.map((tx) => (
        <li
          key={tx.txId}
          className="flex items-start justify-between gap-4 rounded-xl border border-white/5 bg-[#0A0A0F] px-4 py-3"
        >
          {/* Left: status indicator + txId */}
          <div className="flex min-w-0 items-center gap-3">
            <span
              className={`mt-0.5 h-2 w-2 shrink-0 rounded-full ${STATUS_DOT[tx.status]}`}
              aria-hidden="true"
            />
            <div className="min-w-0">
              <p className="truncate font-mono text-xs text-white/50">
                {tx.txId}
              </p>
              {tx.xdrEnvelope && (
                <p className="mt-0.5 truncate font-mono text-[10px] text-white/20">
                  XDR: {tx.xdrEnvelope.slice(0, 24)}…
                </p>
              )}
            </div>
          </div>

          {/* Right: status label + timestamp */}
          <div className="shrink-0 text-right">
            <p
              className={`text-xs font-semibold ${STATUS_COLOR[tx.status]}`}
            >
              {STATUS_LABEL[tx.status]}
            </p>
            <p className="mt-0.5 text-[10px] text-white/20">
              {new Date(tx.updatedAt).toLocaleTimeString()}
            </p>
          </div>
        </li>
      ))}
    </ul>
  );
}
