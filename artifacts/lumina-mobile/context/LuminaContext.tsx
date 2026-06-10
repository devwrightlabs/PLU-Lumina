import AsyncStorage from "@react-native-async-storage/async-storage";
import React, { createContext, useCallback, useContext, useEffect, useState } from "react";

import type {
  CrossChainDepositState,
  MultiSigTransaction,
  OmnichainBalances,
  PiSession,
} from "@/types/lumina";

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

interface LuminaContextValue {
  piSession: PiSession;
  setPiSession: (patch: Partial<PiSession>) => void;
  clearPiSession: () => void;

  balances: OmnichainBalances;
  setBalances: (patch: Partial<OmnichainBalances>) => void;

  multiSigTxs: Record<string, MultiSigTransaction>;
  upsertMultiSigTx: (tx: MultiSigTransaction) => void;
  removeMultiSigTx: (txId: string) => void;

  crossChainDeposits: Record<string, CrossChainDepositState>;
  upsertCrossChainDeposit: (deposit: CrossChainDepositState) => void;
  removeCrossChainDeposit: (depositId: string) => void;

  vaultId: string | null;
  setVaultId: (id: string | null) => void;

  isHydrated: boolean;
}

const LuminaContext = createContext<LuminaContextValue | null>(null);

const STORAGE_KEY = "lumina-state-v1";

interface PersistedState {
  balances: OmnichainBalances;
  multiSigTxs: Record<string, MultiSigTransaction>;
  crossChainDeposits: Record<string, CrossChainDepositState>;
  vaultId: string | null;
}

export function LuminaProvider({ children }: { children: React.ReactNode }) {
  const [piSession, setPiSessionState] = useState<PiSession>(DEFAULT_SESSION);
  const [balances, setBalancesState] = useState<OmnichainBalances>(DEFAULT_BALANCES);
  const [multiSigTxs, setMultiSigTxs] = useState<Record<string, MultiSigTransaction>>({});
  const [crossChainDeposits, setCrossChainDeposits] = useState<Record<string, CrossChainDepositState>>({});
  const [vaultId, setVaultIdState] = useState<string | null>(null);
  const [isHydrated, setIsHydrated] = useState(false);

  useEffect(() => {
    AsyncStorage.getItem(STORAGE_KEY)
      .then((raw) => {
        if (raw) {
          const saved: PersistedState = JSON.parse(raw);
          if (saved.balances) setBalancesState(saved.balances);
          if (saved.multiSigTxs) setMultiSigTxs(saved.multiSigTxs);
          if (saved.crossChainDeposits) setCrossChainDeposits(saved.crossChainDeposits);
          if (saved.vaultId !== undefined) setVaultIdState(saved.vaultId);
        }
      })
      .catch(() => {})
      .finally(() => setIsHydrated(true));
  }, []);

  const persist = useCallback(
    (
      nextBalances: OmnichainBalances,
      nextTxs: Record<string, MultiSigTransaction>,
      nextDeposits: Record<string, CrossChainDepositState>,
      nextVaultId: string | null,
    ) => {
      const toSave: PersistedState = {
        balances: nextBalances,
        multiSigTxs: nextTxs,
        crossChainDeposits: nextDeposits,
        vaultId: nextVaultId,
      };
      AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(toSave)).catch(() => {});
    },
    [],
  );

  const setPiSession = useCallback((patch: Partial<PiSession>) => {
    setPiSessionState((prev) => ({ ...prev, ...patch }));
  }, []);

  const clearPiSession = useCallback(() => {
    setPiSessionState(DEFAULT_SESSION);
  }, []);

  const setBalances = useCallback(
    (patch: Partial<OmnichainBalances>) => {
      setBalancesState((prev) => {
        const next = { ...prev, ...patch };
        persist(next, multiSigTxs, crossChainDeposits, vaultId);
        return next;
      });
    },
    [multiSigTxs, crossChainDeposits, vaultId, persist],
  );

  const upsertMultiSigTx = useCallback(
    (tx: MultiSigTransaction) => {
      setMultiSigTxs((prev) => {
        const next = { ...prev, [tx.txId]: tx };
        persist(balances, next, crossChainDeposits, vaultId);
        return next;
      });
    },
    [balances, crossChainDeposits, vaultId, persist],
  );

  const removeMultiSigTx = useCallback(
    (txId: string) => {
      setMultiSigTxs((prev) => {
        const next = { ...prev };
        delete next[txId];
        persist(balances, next, crossChainDeposits, vaultId);
        return next;
      });
    },
    [balances, crossChainDeposits, vaultId, persist],
  );

  const upsertCrossChainDeposit = useCallback(
    (deposit: CrossChainDepositState) => {
      setCrossChainDeposits((prev) => {
        const next = { ...prev, [deposit.depositId]: deposit };
        persist(balances, multiSigTxs, next, vaultId);
        return next;
      });
    },
    [balances, multiSigTxs, vaultId, persist],
  );

  const removeCrossChainDeposit = useCallback(
    (depositId: string) => {
      setCrossChainDeposits((prev) => {
        const next = { ...prev };
        delete next[depositId];
        persist(balances, multiSigTxs, next, vaultId);
        return next;
      });
    },
    [balances, multiSigTxs, vaultId, persist],
  );

  const setVaultId = useCallback(
    (id: string | null) => {
      setVaultIdState(id);
      persist(balances, multiSigTxs, crossChainDeposits, id);
    },
    [balances, multiSigTxs, crossChainDeposits, persist],
  );

  return (
    <LuminaContext.Provider
      value={{
        piSession,
        setPiSession,
        clearPiSession,
        balances,
        setBalances,
        multiSigTxs,
        upsertMultiSigTx,
        removeMultiSigTx,
        crossChainDeposits,
        upsertCrossChainDeposit,
        removeCrossChainDeposit,
        vaultId,
        setVaultId,
        isHydrated,
      }}
    >
      {children}
    </LuminaContext.Provider>
  );
}

export function useLumina(): LuminaContextValue {
  const ctx = useContext(LuminaContext);
  if (!ctx) throw new Error("useLumina must be used inside LuminaProvider");
  return ctx;
}
