import { useState, useCallback, useEffect, useRef } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { ArrowDownToLine, Loader2, CheckCircle2, Copy, AlertTriangle, Zap, Info } from "lucide-react";
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
  icon: string;
  chain: CrossChainID | null;
  asset: CrossChainAsset | null;
  symbol: string;
  description: string;
  accentColor: string;
  bgColor: string;
}

const ASSET_CONFIGS: Record<AssetTab, AssetConfig> = {
  PI: {
    label: "π Pi",
    icon: "π",
    chain: null,
    asset: null,
    symbol: "π",
    description: "Deposit native Pi via Pi Browser — secured by your Pi Wallet",
    accentColor: "text-[#F0C040]",
    bgColor: "bg-[#F0C040]/10 border-[#F0C040]/20",
  },
  ETH: {
    label: "ETH",
    icon: "Ξ",
    chain: "ETH",
    asset: "ETH",
    symbol: "ETH",
    description: "Send ETH — minted as piETH in your Lumina vault",
    accentColor: "text-blue-400",
    bgColor: "bg-blue-400/10 border-blue-400/20",
  },
  USDT: {
    label: "USDT",
    icon: "$",
    chain: "ETH",
    asset: "USDT",
    symbol: "USDT",
    description: "Send ERC-20 USDT — minted as piUSDT in your vault",
    accentColor: "text-emerald-400",
    bgColor: "bg-emerald-400/10 border-emerald-400/20",
  },
  BTC: {
    label: "BTC",
    icon: "₿",
    chain: "ETH",
    asset: "BTC",
    symbol: "BTC",
    description: "Send wrapped BTC — minted as piBTC in your vault",
    accentColor: "text-orange-400",
    bgColor: "bg-orange-400/10 border-orange-400/20",
  },
};

const ASSET_TABS: AssetTab[] = ["PI", "ETH", "USDT", "BTC"];

const STATUS_LABEL: Record<string, string> = {
  pending:   "Awaiting deposit…",
  detected:  "Transfer detected",
  confirmed: "Confirmed — minting",
  minting:   "Minting on Pi Network…",
  minted:    "Minted to vault",
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

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  const handleCopy = () => {
    navigator.clipboard.writeText(text).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  };
  return (
    <button
      onClick={handleCopy}
      className="shrink-0 rounded-lg p-1.5 text-white/30 hover:text-[#F0C040] hover:bg-[#F0C040]/10 transition-all"
      title="Copy address"
    >
      {copied
        ? <CheckCircle2 className="h-3.5 w-3.5 text-emerald-400" />
        : <Copy className="h-3.5 w-3.5" />
      }
    </button>
  );
}

export function UniversalDepositComponent() {
  const { piSession, upsertCrossChainDeposit, pendingPayments } = useLuminaStore();
  const { initiateDeposit } = usePiPayment();

  const [selectedTab, setSelectedTab] = useState<AssetTab>("PI");
  const [amount, setAmount] = useState("1");
  const [depositError, setDepositError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [activeDeposit, setActiveDeposit] = useState<CrossChainDepositState | null>(null);
  const [simulationStatus, setSimulationStatus] = useState<"idle" | "simulating" | "ok" | "error">("idle");
  const [simulationFee, setSimulationFee] = useState<string | null>(null);

  const pollIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const simTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const isConnected = piSession.status === "connected";
  const parsedAmount = parseFloat(amount);
  const amountValid = !isNaN(parsedAmount) && parsedAmount >= 0.001;
  const config = ASSET_CONFIGS[selectedTab];

  useEffect(() => {
    return () => {
      if (pollIntervalRef.current !== null) clearInterval(pollIntervalRef.current);
      if (simTimerRef.current !== null) clearTimeout(simTimerRef.current);
    };
  }, []);

  useEffect(() => {
    if (selectedTab !== "PI" || !amountValid || !isConnected) {
      setSimulationStatus("idle");
      setSimulationFee(null);
      return;
    }
    if (simTimerRef.current !== null) clearTimeout(simTimerRef.current);
    setSimulationStatus("simulating");
    simTimerRef.current = setTimeout(() => {
      const userAddress = piSession.user?.walletAddress ?? "";
      simulateVaultDeposit(userAddress, parsedAmount)
        .then((result) => {
          if (result.skipped) { setSimulationStatus("idle"); setSimulationFee(null); }
          else if (result.success) { setSimulationStatus("ok"); setSimulationFee(result.minFee); }
          else { setSimulationStatus("error"); setSimulationFee(null); }
        })
        .catch(() => { setSimulationStatus("error"); setSimulationFee(null); });
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
          throw new Error("No provisioned vault ID — complete vault setup first.");
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
        err instanceof OmnichainServiceError ? err.message
        : err instanceof Error ? err.message
        : "Unknown error — see console.";
      console.error("[Lumina] Deposit initiation failed:", err);
      setDepositError(message);
    } finally {
      setIsLoading(false);
    }
  }, [isConnected, amountValid, selectedTab, parsedAmount, config, piSession, initiateDeposit, upsertCrossChainDeposit, startPolling]);

  const handleTabChange = useCallback((tab: AssetTab) => {
    setSelectedTab(tab);
    setDepositError(null);
    setActiveDeposit(null);
    if (pollIntervalRef.current !== null) {
      clearInterval(pollIntervalRef.current);
      pollIntervalRef.current = null;
    }
  }, []);

  const confirmedPiTx = selectedTab === "PI"
    ? Object.values(pendingPayments).find((p) => p.status === "confirmed" && p.sorobanTxHash)
    : null;

  return (
    <section className="glass-card rounded-2xl p-6 h-full flex flex-col">
      <div className="flex items-center gap-2 mb-1">
        <ArrowDownToLine className="h-4 w-4 text-[#F0C040]" />
        <h2 className="text-sm font-bold tracking-[0.15em] text-[#F0C040] uppercase">
          Universal Deposit
        </h2>
      </div>
      <p className="mb-5 text-xs text-white/35">
        Deposit native π or any supported chain asset into your vault
      </p>

      <div className="relative mb-5 flex rounded-xl p-1"
        style={{ background: "rgba(10,10,15,0.7)", border: "1px solid rgba(255,255,255,0.06)" }}
      >
        {ASSET_TABS.map((tab) => {
          const cfg = ASSET_CONFIGS[tab];
          return (
            <button
              key={tab}
              onClick={() => handleTabChange(tab)}
              aria-pressed={selectedTab === tab}
              className="relative flex-1 rounded-lg py-2.5 z-10 transition-colors duration-150"
            >
              {selectedTab === tab && (
                <motion.div
                  layoutId="tab-indicator"
                  className="absolute inset-0 rounded-lg"
                  style={{
                    background: "linear-gradient(135deg, rgba(240,192,64,0.18) 0%, rgba(240,192,64,0.08) 100%)",
                    border: "1px solid rgba(240,192,64,0.3)",
                  }}
                  transition={{ type: "spring", stiffness: 500, damping: 35 }}
                />
              )}
              <span className={[
                "relative flex flex-col items-center gap-0.5 text-[11px] font-bold tracking-wide",
                selectedTab === tab ? cfg.accentColor : "text-white/30",
              ].join(" ")}>
                <span className="text-base leading-none">{cfg.icon}</span>
                <span>{tab}</span>
              </span>
            </button>
          );
        })}
      </div>

      <AnimatePresence mode="wait">
        <motion.p
          key={selectedTab}
          initial={{ opacity: 0, y: 4 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: -4 }}
          transition={{ duration: 0.2 }}
          className="mb-5 text-[11px] text-white/35 flex items-center gap-1.5"
        >
          <Info className="h-3 w-3 shrink-0 text-white/20" />
          {config.description}
        </motion.p>
      </AnimatePresence>

      {isConnected && (
        <div className="mb-4">
          <label
            htmlFor="deposit-amount"
            className="mb-1.5 flex items-center justify-between text-[10px] font-semibold tracking-widest text-white/30 uppercase"
          >
            <span>Amount ({config.symbol})</span>
            {amountValid && (
              <span className="text-[#F0C040]/60 font-mono normal-case">
                {parsedAmount.toFixed(3)} {config.symbol}
              </span>
            )}
          </label>
          <input
            id="deposit-amount"
            type="number"
            value={amount}
            onChange={(e) => { setDepositError(null); setAmount(e.target.value); }}
            min="0.001"
            step="0.001"
            placeholder="0.000"
            aria-label={`Deposit amount in ${config.symbol}`}
            className={[
              "input-lumina w-full rounded-xl px-4 py-3 font-mono text-lg font-bold",
              !amountValid && amount !== "" ? "border-red-500/40 focus:border-red-500/60" : "",
            ].join(" ")}
          />
        </div>
      )}

      <div className="mb-4 rounded-xl px-4 py-3"
        style={{ background: "rgba(10,10,15,0.7)", border: "1px solid rgba(255,255,255,0.06)" }}
      >
        <div className="flex items-center justify-between mb-1">
          <p className="text-[10px] font-semibold tracking-widest text-white/25 uppercase">
            Vault Contract
          </p>
          <span className="text-[10px] text-white/20 flex items-center gap-1">
            <span className="h-1.5 w-1.5 rounded-full bg-[#F0C040]/40" />
            {PI_NETWORK_CONFIG.isSandbox ? "Testnet" : "Mainnet"}
          </span>
        </div>
        <div className="flex items-center gap-2">
          <p className="truncate font-mono text-[11px] text-[#F0C040]/55 flex-1">
            {LUMINA_CONTRACTS.VAULT}
          </p>
          <CopyButton text={LUMINA_CONTRACTS.VAULT} />
        </div>
      </div>

      {selectedTab === "PI" && isConnected && amountValid && (
        <AnimatePresence>
          <motion.div
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: "auto" }}
            exit={{ opacity: 0, height: 0 }}
            className="mb-4 overflow-hidden"
          >
            <div className={[
              "flex items-center gap-2 rounded-xl px-3 py-2 text-[10px]",
              simulationStatus === "ok" ? "bg-emerald-400/8 border border-emerald-400/15" :
              simulationStatus === "error" ? "bg-amber-400/8 border border-amber-400/15" :
              "bg-white/[0.03] border border-white/[0.06]",
            ].join(" ")}>
              {simulationStatus === "simulating" && (
                <><Loader2 className="h-3 w-3 animate-spin text-white/30" /><span className="text-white/30">Simulating contract call…</span></>
              )}
              {simulationStatus === "ok" && (
                <><CheckCircle2 className="h-3 w-3 text-emerald-400" /><span className="text-emerald-400/80">Simulation passed{simulationFee ? ` · est. ${simulationFee} stroops` : ""}</span></>
              )}
              {simulationStatus === "error" && (
                <><AlertTriangle className="h-3 w-3 text-amber-400/70" /><span className="text-amber-400/60">Simulation unavailable (RPC unreachable)</span></>
              )}
            </div>
          </motion.div>
        </AnimatePresence>
      )}

      {confirmedPiTx?.sorobanTxHash && (
        <motion.div
          initial={{ opacity: 0, y: 4 }}
          animate={{ opacity: 1, y: 0 }}
          className="mb-4 rounded-xl px-4 py-3 border border-emerald-500/20 bg-emerald-500/5"
        >
          <div className="flex items-center justify-between mb-1">
            <p className="text-[10px] font-semibold tracking-widest text-emerald-400/60 uppercase">
              Last confirmed tx
            </p>
            <CheckCircle2 className="h-3 w-3 text-emerald-400" />
          </div>
          <div className="flex items-center gap-2">
            <p className="truncate font-mono text-[11px] text-emerald-400 flex-1">
              {confirmedPiTx.sorobanTxHash}
            </p>
            <CopyButton text={confirmedPiTx.sorobanTxHash} />
          </div>
        </motion.div>
      )}

      <AnimatePresence>
        {depositError && (
          <motion.div
            initial={{ opacity: 0, scale: 0.97 }}
            animate={{ opacity: 1, scale: 1 }}
            exit={{ opacity: 0, scale: 0.97 }}
            role="alert"
            className="mb-4 flex items-start gap-2 rounded-xl border border-red-500/20 bg-red-500/8 px-4 py-3"
          >
            <AlertTriangle className="h-3.5 w-3.5 shrink-0 text-red-400 mt-0.5" />
            <p className="text-xs text-red-400">{depositError}</p>
          </motion.div>
        )}
      </AnimatePresence>

      <AnimatePresence>
        {activeDeposit && selectedTab !== "PI" && (
          <motion.div
            initial={{ opacity: 0, y: 6 }}
            animate={{ opacity: 1, y: 0 }}
            className="mb-4 rounded-xl p-4"
            style={{ background: "rgba(10,10,15,0.7)", border: "1px solid rgba(255,255,255,0.08)" }}
          >
            <p className="mb-2 text-[10px] font-semibold tracking-widest text-white/35 uppercase">
              Send {config.symbol} to this address on {activeDeposit.chain}
            </p>
            <div className="flex items-start gap-2 rounded-lg bg-[#F0C040]/5 border border-[#F0C040]/15 px-3 py-2.5 mb-3">
              <p className="break-all font-mono text-[11px] text-[#F0C040] flex-1 leading-relaxed">
                {activeDeposit.depositAddress}
              </p>
              <CopyButton text={activeDeposit.depositAddress} />
            </div>
            <div className="flex items-center justify-between">
              <span className={`text-[10px] font-semibold ${STATUS_COLOR[activeDeposit.status] ?? "text-white/40"}`}>
                {STATUS_LABEL[activeDeposit.status] ?? activeDeposit.status}
              </span>
              {activeDeposit.status === "detected" && activeDeposit.confirmations > 0 && (
                <span className="text-[10px] text-white/25">
                  {activeDeposit.confirmations}/{activeDeposit.minConfirmations} confs
                </span>
              )}
            </div>
            {activeDeposit.failureReason && (
              <p className="mt-1.5 text-[10px] text-red-400/80">{activeDeposit.failureReason}</p>
            )}
          </motion.div>
        )}
      </AnimatePresence>

      <div className="mt-auto pt-2">
        <motion.button
          onClick={handleDeposit}
          disabled={!isConnected || !amountValid || isLoading}
          whileHover={isConnected && amountValid && !isLoading ? { scale: 1.02 } : {}}
          whileTap={isConnected && amountValid && !isLoading ? { scale: 0.98 } : {}}
          className={[
            "w-full rounded-xl py-3.5 text-sm font-black tracking-[0.12em] uppercase flex items-center justify-center gap-2",
            isConnected && amountValid && !isLoading
              ? "btn-gold-shimmer cursor-pointer"
              : "cursor-not-allowed",
          ].join(" ")}
          style={!(isConnected && amountValid && !isLoading) ? {
            background: "rgba(240,192,64,0.08)",
            border: "1px solid rgba(240,192,64,0.15)",
            color: "rgba(240,192,64,0.3)",
          } : {}}
        >
          {isLoading ? (
            <><Loader2 className="h-4 w-4 animate-spin" /> Generating address…</>
          ) : isConnected ? (
            <>
              <Zap className="h-4 w-4" />
              {selectedTab === "PI"
                ? "Initiate Pi Deposit"
                : activeDeposit && !isTerminalStatus(activeDeposit.status)
                  ? "Deposit in Progress"
                  : `Get ${config.symbol} Address`}
            </>
          ) : (
            "Connect Pi Wallet to Continue"
          )}
        </motion.button>
      </div>
    </section>
  );
}

function assetToWrapped(asset: CrossChainAsset): string {
  const map: Record<CrossChainAsset, string> = { ETH: "piETH", BTC: "piBTC", USDT: "piUSDT" };
  return map[asset] ?? asset;
}
