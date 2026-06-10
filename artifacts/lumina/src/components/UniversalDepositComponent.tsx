import { useState, useCallback, useEffect, useRef } from "react";
import { useLuminaStore } from "../lib/store";
import { usePiPayment } from "../lib/usePiPayment";
import {
  requestDepositAddress,
  pollDepositStatus,
  isTerminalStatus,
  OmnichainServiceError,
} from "../lib/omnichainService";
import { LUMINA_CONTRACTS, PI_NETWORK_CONFIG } from "../lib/contracts";
import { simulateVaultDeposit } from "../lib/sorobanVault";
import type {
  CrossChainID,
  CrossChainAsset,
  CrossChainDepositState,
} from "../types/lumina";

type AssetTab = "PI" | CrossChainAsset;

interface AssetConfig {
  label: string;
  chain: CrossChainID | null;
  asset: CrossChainAsset | null;
  symbol: string;
  description: string;
}

const ASSET_CONFIGS: Record<AssetTab, AssetConfig> = {
  PI: {
    label: "π Pi",
    chain: null,
    asset: null,
    symbol: "π",
    description: "Deposit native Pi into your Lumina vault",
  },
  ETH: {
    label: "ETH",
    chain: "ETH",
    asset: "ETH",
    symbol: "ETH",
    description: "Deposit ETH → minted as piETH in your vault",
  },
  USDT: {
    label: "USDT",
    chain: "ETH",
    asset: "USDT",
    symbol: "USDT",
    description: "Deposit ERC-20 USDT → minted as piUSDT in your vault",
  },
  BTC: {
    label: "BTC",
    chain: "ETH",
    asset: "BTC",
    symbol: "BTC",
    description: "Deposit wrapped BTC → minted as piBTC in your vault",
  },
};

const ASSET_TABS: AssetTab[] = ["PI", "ETH", "USDT", "BTC"];

const STATUS_LABEL: Record<string, string> = {
  pending:   "Awaiting deposit…",
  detected:  "Transfer detected — accumulating confirmations",
  confirmed: "Confirmed — minting wrapped asset",
  minting:   "Minting on Pi Network…",
  minted:    "✓ Minted to your vault",
  failed:    "Deposit failed",
  expired:   "Address expired",
};

const STATUS_COLOR: Record<string, string> = {
  pending:   "text-white/40",
  detected:  "text-blue-400",
  confirmed: "text-yellow-400",
  minting:   "text-yellow-400",
  minted:    "text-emerald-400",
  failed:    "text-red-400",
  expired:   "text-white/30",
};

export function UniversalDepositComponent() {
  const { piSession, balances, upsertCrossChainDeposit, pendingPayments } = useLuminaStore();
  const { initiateDeposit } = usePiPayment();

  const [selectedTab, setSelectedTab] = useState<AssetTab>("PI");
  const [amount, setAmount] = useState("1");
  const [depositError, setDepositError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);

  const [activeDeposit, setActiveDeposit] =
    useState<CrossChainDepositState | null>(null);

  const [simulationStatus, setSimulationStatus] = useState<
    "idle" | "simulating" | "ok" | "error"
  >("idle");
  const [simulationFee, setSimulationFee] = useState<string | null>(null);

  const pollIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const simTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const isConnected = piSession.status === "connected";
  const parsedAmount = parseFloat(amount);
  const amountValid = !isNaN(parsedAmount) && parsedAmount >= 0.001;

  const config = ASSET_CONFIGS[selectedTab];

  useEffect(() => {
    return () => {
      if (pollIntervalRef.current !== null) {
        clearInterval(pollIntervalRef.current);
      }
      if (simTimerRef.current !== null) {
        clearTimeout(simTimerRef.current);
      }
    };
  }, []);

  useEffect(() => {
    if (selectedTab !== "PI" || !amountValid || !isConnected) {
      setSimulationStatus("idle");
      setSimulationFee(null);
      return;
    }

    if (simTimerRef.current !== null) {
      clearTimeout(simTimerRef.current);
    }

    setSimulationStatus("simulating");

    simTimerRef.current = setTimeout(() => {
      const userAddress = piSession.user?.walletAddress ?? "";
      simulateVaultDeposit(userAddress, parsedAmount)
        .then((result) => {
          if (result.skipped) {
            setSimulationStatus("idle");
            setSimulationFee(null);
          } else if (result.success) {
            setSimulationStatus("ok");
            setSimulationFee(result.minFee);
          } else {
            setSimulationStatus("error");
            setSimulationFee(null);
          }
        })
        .catch(() => {
          setSimulationStatus("error");
          setSimulationFee(null);
        });
    }, 600);
  }, [selectedTab, amountValid, parsedAmount, isConnected, piSession.user?.uid]);

  const startPolling = useCallback(
    (depositId: string, minConfirmations: number) => {
      if (!isConnected || !piSession.luminaJwt) return;
      const jwt = piSession.luminaJwt;

      pollIntervalRef.current = setInterval(async () => {
        try {
          const status = await pollDepositStatus(depositId, jwt);

          const updated: CrossChainDepositState = {
            depositId: status.depositId,
            chain: status.chain,
            asset: status.asset,
            depositAddress: status.depositAddress,
            wrappedAsset: assetToWrapped(status.asset),
            status: status.status,
            confirmations: status.confirmations ?? 0,
            minConfirmations,
            externalTxHash: status.externalTxHash ?? null,
            sorobanTxHash: status.sorobanTxHash ?? null,
            failureReason: status.failureReason ?? null,
            updatedAt: new Date(status.updatedAt * 1000).toISOString(),
          };

          setActiveDeposit(updated);
          upsertCrossChainDeposit(updated);

          if (isTerminalStatus(status.status)) {
            if (pollIntervalRef.current !== null) {
              clearInterval(pollIntervalRef.current);
              pollIntervalRef.current = null;
            }
          }
        } catch (err) {
          console.warn("[Lumina] Deposit status poll error:", err);
        }
      }, 15_000);
    },
    [isConnected, piSession.luminaJwt, upsertCrossChainDeposit],
  );

  const handleDeposit = useCallback(async () => {
    if (!isConnected || !amountValid) return;

    setDepositError(null);
    setIsLoading(true);

    try {
      if (selectedTab === "PI") {
        initiateDeposit({ amount: parsedAmount });
      } else {
        if (!piSession.luminaJwt || !piSession.user) {
          throw new Error("No Lumina JWT — re-authenticate and try again.");
        }

        const provisionedVaultId = useLuminaStore.getState().vaultId;

        if (!provisionedVaultId) {
          throw new Error(
            "No provisioned vault ID found — complete vault setup and try again.",
          );
        }

        const response = await requestDepositAddress({
          vaultId: provisionedVaultId,
          chain: config.chain as CrossChainID,
          asset: config.asset as CrossChainAsset,
          expectedAmount: parsedAmount.toString(),
          jwt: piSession.luminaJwt,
        });

        const depositState: CrossChainDepositState = {
          depositId: response.depositId,
          chain: response.chain,
          asset: response.asset,
          depositAddress: response.depositAddress,
          wrappedAsset: response.wrappedAsset,
          status: response.status,
          confirmations: 0,
          minConfirmations: response.minConfirmations,
          externalTxHash: null,
          sorobanTxHash: null,
          failureReason: null,
          updatedAt: new Date().toISOString(),
        };

        setActiveDeposit(depositState);
        upsertCrossChainDeposit(depositState);

        startPolling(response.depositId, response.minConfirmations);
      }
    } catch (err) {
      const message =
        err instanceof OmnichainServiceError
          ? err.message
          : err instanceof Error
            ? err.message
            : "Unknown error — see console.";
      console.error("[Lumina] Deposit initiation failed:", err);
      setDepositError(message);
    } finally {
      setIsLoading(false);
    }
  }, [
    isConnected,
    amountValid,
    selectedTab,
    parsedAmount,
    config,
    piSession,
    initiateDeposit,
    upsertCrossChainDeposit,
    startPolling,
  ]);

  const handleTabChange = useCallback((tab: AssetTab) => {
    setSelectedTab(tab);
    setDepositError(null);
    setActiveDeposit(null);
    if (pollIntervalRef.current !== null) {
      clearInterval(pollIntervalRef.current);
      pollIntervalRef.current = null;
    }
  }, []);

  return (
    <section className="rounded-2xl border border-[#F0C040]/20 bg-[#0F0F1A] p-6 shadow-lg shadow-black/40">
      <h2 className="mb-1 text-lg font-semibold tracking-widest text-[#F0C040] uppercase">
        Universal Deposit
      </h2>
      <p className="mb-6 text-xs text-white/40">
        Deposit native π or any supported omnichain asset into your Lumina vault.
      </p>

      <div className="mb-6 grid grid-cols-4 gap-3">
        {(
          [
            { label: "π  Pi",  value: balances.pi },
            { label: "piBTC",  value: balances.piBTC },
            { label: "piETH",  value: balances.piETH },
            { label: "piUSDT", value: balances.piUSDT },
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

      <div className="mb-4 flex gap-2">
        {ASSET_TABS.map((tab) => (
          <button
            key={tab}
            onClick={() => handleTabChange(tab)}
            aria-pressed={selectedTab === tab}
            className={[
              "flex-1 rounded-xl py-2 text-xs font-semibold tracking-widest uppercase transition-all duration-150",
              selectedTab === tab
                ? "bg-[#F0C040] text-[#0A0A0F]"
                : "border border-white/10 text-white/40 hover:border-[#F0C040]/30 hover:text-white/60",
            ].join(" ")}
          >
            {ASSET_CONFIGS[tab].label}
          </button>
        ))}
      </div>

      <p className="mb-4 text-[10px] text-white/40">{config.description}</p>

      {isConnected && (
        <div className="mb-4">
          <label
            htmlFor="deposit-amount"
            className="mb-1 block text-[10px] font-medium tracking-widest text-white/40 uppercase"
          >
            Amount ({config.symbol})
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
            aria-label={`Deposit amount in ${config.symbol}`}
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

      <div className="mb-4 rounded-xl border border-white/5 bg-[#0A0A0F] px-4 py-3">
        <p className="mb-1 text-[10px] font-medium tracking-widest text-white/30 uppercase">
          Vault Contract
        </p>
        <p className="truncate font-mono text-[10px] text-[#F0C040]/70">
          {LUMINA_CONTRACTS.VAULT}
        </p>
        <p className="mt-1 text-[10px] text-white/20">
          {PI_NETWORK_CONFIG.isSandbox ? "π Testnet" : "π Mainnet"} · Soroban
        </p>
      </div>

      {selectedTab === "PI" && isConnected && amountValid && (
        <div className="mb-4 flex items-center gap-2">
          {simulationStatus === "simulating" && (
            <span className="text-[10px] text-white/30">Simulating contract call…</span>
          )}
          {simulationStatus === "ok" && (
            <span className="text-[10px] text-emerald-400/70">
              ✓ Vault simulation passed
              {simulationFee ? ` · est. fee ${simulationFee} stroops` : ""}
            </span>
          )}
          {simulationStatus === "error" && (
            <span className="text-[10px] text-amber-400/60">
              ⚠ Simulation unavailable (testnet RPC unreachable)
            </span>
          )}
        </div>
      )}

      {selectedTab === "PI" && (() => {
        const confirmedPi = Object.values(pendingPayments).find(
          (p) => p.status === "confirmed" && p.sorobanTxHash,
        );
        return confirmedPi?.sorobanTxHash ? (
          <div className="mb-4 rounded-xl border border-emerald-500/20 bg-emerald-500/5 px-4 py-3">
            <p className="mb-1 text-[10px] font-medium tracking-widest text-emerald-400/60 uppercase">
              Last Soroban tx
            </p>
            <p className="truncate font-mono text-[10px] text-emerald-400">
              {confirmedPi.sorobanTxHash}
            </p>
          </div>
        ) : null;
      })()}

      {depositError && (
        <p
          role="alert"
          className="mb-3 rounded-lg border border-red-500/20 bg-red-500/10 px-3 py-2 text-xs text-red-400"
        >
          {depositError}
        </p>
      )}

      {activeDeposit && selectedTab !== "PI" && (
        <div className="mb-4 rounded-xl border border-white/10 bg-[#0A0A0F] p-4">
          <p className="mb-2 text-[10px] font-medium tracking-widest text-white/40 uppercase">
            Send {config.symbol} to this address on {activeDeposit.chain}
          </p>
          <p className="break-all font-mono text-xs text-[#F0C040]">
            {activeDeposit.depositAddress}
          </p>

          <p className="mt-2 text-[10px] text-amber-400/70">
            ⚠ Send funds once only to this address. Multiple deposits require
            operator-assisted recovery.
          </p>

          <div className="mt-3 flex items-center gap-2">
            <span
              className={[
                "text-[10px] font-medium",
                STATUS_COLOR[activeDeposit.status] ?? "text-white/40",
              ].join(" ")}
            >
              {STATUS_LABEL[activeDeposit.status] ?? activeDeposit.status}
            </span>
            {activeDeposit.status === "detected" &&
              activeDeposit.confirmations > 0 && (
                <span className="text-[10px] text-white/30">
                  ({activeDeposit.confirmations} / {activeDeposit.minConfirmations} confirmations)
                </span>
              )}
          </div>

          {activeDeposit.sorobanTxHash && (
            <p className="mt-1 truncate text-[10px] text-emerald-400/60">
              Soroban tx: {activeDeposit.sorobanTxHash}
            </p>
          )}
          {activeDeposit.failureReason && (
            <p className="mt-1 text-[10px] text-red-400/80">
              {activeDeposit.failureReason}
            </p>
          )}
        </div>
      )}

      <button
        onClick={handleDeposit}
        disabled={!isConnected || !amountValid || isLoading}
        aria-label={
          !isConnected
            ? "Connect Pi Wallet to continue"
            : amountValid
              ? `Initiate ${config.symbol} vault deposit of ${parsedAmount}`
              : "Enter a valid deposit amount to continue"
        }
        className={[
          "w-full rounded-xl py-3 text-sm font-semibold tracking-widest uppercase transition-all duration-150",
          isConnected && amountValid && !isLoading
            ? "cursor-pointer bg-[#F0C040] text-[#0A0A0F] hover:bg-[#F0C040]/90"
            : "cursor-not-allowed bg-[#F0C040]/10 text-[#F0C040]/40",
        ].join(" ")}
      >
        {isLoading
          ? "Generating address…"
          : isConnected
            ? selectedTab === "PI"
              ? "Initiate Deposit"
              : activeDeposit && !isTerminalStatus(activeDeposit.status)
                ? "Deposit in Progress"
                : `Get ${config.symbol} Deposit Address`
            : "Connect Pi Wallet to Continue"}
      </button>
    </section>
  );
}

function assetToWrapped(asset: CrossChainAsset): string {
  const map: Record<CrossChainAsset, string> = {
    ETH:  "piETH",
    BTC:  "piBTC",
    USDT: "piUSDT",
  };
  return map[asset] ?? asset;
}
