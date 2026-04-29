/**
 * page.tsx — Lumina Dashboard (root route).
 *
 * This is a React Server Component: it renders the static scaffold of the
 * dashboard and delegates all interactive elements to client components.
 *
 * Phase 11 delivers the structural skeleton only.  In subsequent phases:
 *  - The status panel will subscribe to real Pi SDK events.
 *  - The multi-sig panel will display live transaction states from Zustand.
 *  - The UniversalDepositComponent will activate the Pi payment API and the
 *    Lumina bridge listeners for external network confirmations.
 */

import { UniversalDepositComponent } from "@/components/UniversalDepositComponent";

export default function DashboardPage() {
  return (
    <div className="mx-auto w-full max-w-5xl flex-1 px-4 py-10 sm:px-6 lg:px-8">
      {/* ── Page Title ────────────────────────────────────────────────── */}
      <div className="mb-10">
        <h1 className="text-3xl font-bold tracking-tight text-[#F0C040]">
          Dashboard
        </h1>
        <p className="mt-1 text-sm text-white/40">
          Omnichain vault status · real-time · zero-trust
        </p>
      </div>

      {/* ── Primary Grid ──────────────────────────────────────────────── */}
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">

        {/* ── Left column: Vault Status ──────────────────────────────── */}
        <div className="lg:col-span-2 space-y-6">
          {/* Vault overview card */}
          <div className="rounded-2xl border border-[#F0C040]/20 bg-[#0F0F1A] p-6 shadow-lg shadow-black/40">
            <h2 className="mb-4 text-lg font-semibold tracking-widest text-[#F0C040] uppercase">
              Vault Overview
            </h2>
            <div className="grid grid-cols-2 gap-4 sm:grid-cols-3">
              {[
                { label: "Vault Status", value: "Awaiting Auth" },
                { label: "Multi-Sig", value: "2-of-2" },
                { label: "Network", value: "Pi Mainnet" },
              ].map(({ label, value }) => (
                <div key={label} className="rounded-xl bg-[#0A0A0F] px-4 py-3">
                  <p className="text-[10px] font-medium tracking-widest text-white/30 uppercase">
                    {label}
                  </p>
                  <p className="mt-1 text-sm font-semibold text-[#F0C040]">
                    {value}
                  </p>
                </div>
              ))}
            </div>
          </div>

          {/* Multi-Sig transaction tracker placeholder */}
          <div className="rounded-2xl border border-[#F0C040]/20 bg-[#0F0F1A] p-6 shadow-lg shadow-black/40">
            <h2 className="mb-4 text-lg font-semibold tracking-widest text-[#F0C040] uppercase">
              Multi-Sig Transactions
            </h2>
            <p className="text-sm text-white/30">
              No in-flight transactions. Transaction history will appear here
              once the 2-of-2 signing flow is activated in Phase 12.
            </p>
          </div>
        </div>

        {/* ── Right column: Universal Deposit ───────────────────────── */}
        <div className="lg:col-span-1">
          {/*
           * UniversalDepositComponent is a client component.
           * It reads from the Zustand store and will eventually dispatch
           * Pi SDK payment requests and bridge deposit intents.
           */}
          <UniversalDepositComponent />
        </div>
      </div>

      {/* ── Omnichain Network Status Bar ──────────────────────────────── */}
      <div className="mt-6 rounded-2xl border border-[#F0C040]/10 bg-[#0F0F1A] px-6 py-4">
        <p className="mb-3 text-[10px] font-medium tracking-widest text-white/30 uppercase">
          Omnichain Network Listeners
        </p>
        <div className="flex flex-wrap gap-4">
          {[
            { chain: "Pi Network", status: "pending" },
            { chain: "Bitcoin Bridge", status: "pending" },
            { chain: "Ethereum Bridge", status: "pending" },
            { chain: "Soroban RPC", status: "pending" },
          ].map(({ chain, status }) => (
            <div key={chain} className="flex items-center gap-2">
              {/* Status indicator — will be animated in Phase 12 */}
              <span className="h-2 w-2 rounded-full bg-white/20" />
              <span className="text-xs text-white/40">
                {chain}{" "}
                <span className="text-white/20">·</span>{" "}
                <span className="text-white/20 capitalize">{status}</span>
              </span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

