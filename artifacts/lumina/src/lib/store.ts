import { create } from "zustand";
import { persist, createJSONStorage } from "zustand/middleware";
import type {
  PiSession,
  PendingPayment,
  OmnichainBalances,
  CrossChainDepositState,
} from "../types/lumina";

interface LuminaState {
  piSession: PiSession;
  setPiSession: (session: Partial<PiSession>) => void;
  clearPiSession: () => void;

  pendingPayments: Record<string, PendingPayment>;
  upsertPendingPayment: (payment: PendingPayment) => void;
  removePendingPayment: (paymentId: string) => void;

  balances: OmnichainBalances;
  setBalances: (balances: Partial<OmnichainBalances>) => void;

  vaultId: string | null;

  crossChainDeposits: Record<string, CrossChainDepositState>;
  upsertCrossChainDeposit: (deposit: CrossChainDepositState) => void;
  removeCrossChainDeposit: (depositId: string) => void;
}

const DEFAULT_SESSION: PiSession = {
  status: "idle",
  user: null,
  luminaJwt: null,
};

const DEFAULT_BALANCES: OmnichainBalances = {
  pi: "0",
  piBTC: "0",
  piETH: "0",
  piUSDT: "0",
};

export const useLuminaStore = create<LuminaState>()(
  persist(
    (set) => ({
      piSession: DEFAULT_SESSION,

      setPiSession: (patch) =>
        set((state) => ({
          piSession: { ...state.piSession, ...patch },
        })),

      clearPiSession: () =>
        set({ piSession: DEFAULT_SESSION }),

      pendingPayments: {},

      upsertPendingPayment: (payment) =>
        set((state) => ({
          pendingPayments: {
            ...state.pendingPayments,
            [payment.paymentId]: payment,
          },
        })),

      removePendingPayment: (paymentId) =>
        set((state) => {
          const next = { ...state.pendingPayments };
          delete next[paymentId];
          return { pendingPayments: next };
        }),

      balances: DEFAULT_BALANCES,

      setBalances: (patch) =>
        set((state) => ({
          balances: { ...state.balances, ...patch },
        })),

      vaultId: null,

      crossChainDeposits: {},

      upsertCrossChainDeposit: (deposit) =>
        set((state) => ({
          crossChainDeposits: {
            ...state.crossChainDeposits,
            [deposit.depositId]: deposit,
          },
        })),

      removeCrossChainDeposit: (depositId) =>
        set((state) => {
          const next = { ...state.crossChainDeposits };
          delete next[depositId];
          return { crossChainDeposits: next };
        }),
    }),
    {
      name: "lumina-state",
      storage: createJSONStorage(() => localStorage),
      skipHydration: true,
      partialize: (state) => ({
        balances: state.balances,
        pendingPayments: state.pendingPayments,
        crossChainDeposits: state.crossChainDeposits,
      }),
    }
  )
);
