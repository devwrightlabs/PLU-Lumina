/**
 * store.ts — Zustand global state for the Lumina frontend.
 *
 * Architecture notes:
 *  - `persist` middleware writes hydration-safe snapshots to localStorage so
 *    that page reloads don't flash empty states.
 *  - `skipHydration: true` defers rehydration until the client mounts,
 *    eliminating SSR/client hydration mismatches in Next.js App Router.
 *  - The store is designed to be extended: each omnichain network listener
 *    (ETH, BTC, etc.) will dispatch balance updates through `setBalances`.
 *  - The Pi SDK (injected by the Pi Browser at runtime) will call
 *    `setPiSession` once authentication completes.
 */

import { create } from "zustand";
import { persist, createJSONStorage } from "zustand/middleware";
import type {
  PiSession,
  MultiSigTransaction,
  OmnichainBalances,
} from "@/types/lumina";

// ─── State Shape ──────────────────────────────────────────────────────────────

interface LuminaState {
  // ── Pi Wallet Session ──────────────────────────────────────────────────────
  piSession: PiSession;
  setPiSession: (session: Partial<PiSession>) => void;
  clearPiSession: () => void;

  // ── 2-of-2 Multi-Sig Tracking ─────────────────────────────────────────────
  /** In-flight and recent multi-sig transactions keyed by txId. */
  multiSigTxs: Record<string, MultiSigTransaction>;
  upsertMultiSigTx: (tx: MultiSigTransaction) => void;
  removeMultiSigTx: (txId: string) => void;

  // ── Omnichain Asset Balances ───────────────────────────────────────────────
  balances: OmnichainBalances;
  setBalances: (balances: Partial<OmnichainBalances>) => void;
}

// ─── Default Values ───────────────────────────────────────────────────────────

const DEFAULT_SESSION: PiSession = {
  status: "idle",
  user: null,
  luminaJwt: null,
};

const DEFAULT_BALANCES: OmnichainBalances = {
  pi: "0",
  piBTC: "0",
  piETH: "0",
};

// ─── Store ────────────────────────────────────────────────────────────────────

export const useLuminaStore = create<LuminaState>()(
  persist(
    (set) => ({
      // ── Pi Session ──────────────────────────────────────────────────────────
      piSession: DEFAULT_SESSION,

      setPiSession: (patch) =>
        set((state) => ({
          piSession: { ...state.piSession, ...patch },
        })),

      clearPiSession: () =>
        set({ piSession: DEFAULT_SESSION }),

      // ── Multi-Sig Transactions ──────────────────────────────────────────────
      multiSigTxs: {},

      upsertMultiSigTx: (tx) =>
        set((state) => ({
          multiSigTxs: { ...state.multiSigTxs, [tx.txId]: tx },
        })),

      removeMultiSigTx: (txId) =>
        set((state) => {
          const next = { ...state.multiSigTxs };
          delete next[txId];
          return { multiSigTxs: next };
        }),

      // ── Omnichain Balances ──────────────────────────────────────────────────
      balances: DEFAULT_BALANCES,

      setBalances: (patch) =>
        set((state) => ({
          balances: { ...state.balances, ...patch },
        })),
    }),
    {
      name: "lumina-state",
      storage: createJSONStorage(() => localStorage),
      /**
       * skipHydration: true prevents Zustand from rehydrating synchronously
       * during the server render pass.  The StoreHydrator component (rendered
       * client-side inside layout.tsx) calls rehydrate() explicitly, ensuring
       * the DOM matches before any interactive code runs.
       */
      skipHydration: true,
      /**
       * Exclude sensitive fields (JWT, user identity) from localStorage.
       * They are re-established on each page load via the Pi SDK handshake.
       */
      partialize: (state) => ({
        balances: state.balances,
        multiSigTxs: state.multiSigTxs,
      }),
    }
  )
);
