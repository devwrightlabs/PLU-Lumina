/**
 * UniversalDepositComponent.tsx — Omnichain deposit gateway.
 *
 * Phase 13: cross-chain deposit flow fully wired.
 *  - "Pi" tab: routes through `usePiPayment.initiateDeposit` (Phase 12 flow).
 *  - Cross-chain tabs (ETH, USDT, BTC): call the Go backend to generate a
 *    one-time EVM deposit address via POST /deposit/address, then poll
 *    GET /deposit/:id/status on a 15-second interval until the omnichain
 *    listener confirms the transfer and the wrapped asset is minted into the
 *    user's 2-of-2 Multi-Sig Vault.
 *  - All state transitions are reflected in the Zustand store in real time.
 */

"use client";

import { useState, useCallback, useEffect, useRef } from "react";
import { useLuminaStore } from "@/lib/store";
import { usePiPayment } from "@/lib/usePiPayment";
import {
  requestDepositAddress,
  pollDepositStatus,
  isTerminalStatus,
  OmnichainServiceError,
} from "@/lib/omnichainService";
import type {
  CrossChainID,
  CrossChainAsset,
  CrossChainDepositState,
} from "@/types/lumina";

// ─── Asset configuration ──────────────────────────────────────────────────────

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

// ─── Status display maps ──────────────────────────────────────────────────────

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

// ─── Component ────────────────────────────────────────────────────────────────

export function UniversalDepositComponent() {
  const { piSession, balances, upsertCrossChainDeposit } = useLuminaStore();
  const { initiateDeposit } = usePiPayment();

  const [selectedTab, setSelectedTab] = useState<AssetTab>("PI");
  const [amount, setAmount] = useState("1");
  const [depositError, setDepositError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);

  // Active cross-chain deposit for the current UI session.
  const [activeDeposit, setActiveDeposit] =
    useState<CrossChainDepositState | null>(null);

  // Ref to the status-polling interval; cleared on unmount or terminal state.
  const pollIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const isConnected = piSession.status === "connected";
  const parsedAmount = parseFloat(amount);
  const amountValid = !isNaN(parsedAmount) && parsedAmount >= 0.001;

  const config = ASSET_CONFIGS[selectedTab];

  // Clear any in-flight poll on component unmount.
  useEffect(() => {
    return () => {
      if (pollIntervalRef.current !== null) {
        clearInterval(pollIntervalRef.current);
      }
    };
  }, []);

  // ── Cross-chain status polling ─────────────────────────────────────────────

  const startPolling = useCallback(
    (depositId: string) => {
      if (!isConnected || !piSession.luminaJwt) return;
      const jwt = piSession.luminaJwt;

      // Poll every 15 s, matching the backend's omnichain listener cadence.
      // The interval is cleared automatically when a terminal status is reached.
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
            // Preserve minConfirmations from the initial DepositAddressResponse;
            // the status poll endpoint does not repeat this configuration value.
            minConfirmations: activeDeposit?.minConfirmations ?? 12,
            externalTxHash: status.externalTxHash ?? null,
            sorobanTxHash: status.sorobanTxHash ?? null,
            failureReason: status.failureReason ?? null,
            updatedAt: new Date(status.updatedAt * 1000).toISOString(),
          };

          setActiveDeposit(updated);
          // Persist to the Zustand store so other dashboard components can
          // react to the deposit lifecycle (e.g. MultiSigTracker, balance card).
          upsertCrossChainDeposit(updated);

          if (isTerminalStatus(status.status)) {
            if (pollIntervalRef.current !== null) {
              clearInterval(pollIntervalRef.current);
              pollIntervalRef.current = null;
            }
          }
        } catch (err) {
          // Non-fatal: log and let the next cycle retry.
          console.warn("[Lumina] Deposit status poll error:", err);
        }
      }, 15_000);
    },
    [isConnected, piSession.luminaJwt, upsertCrossChainDeposit],
  );

  // ── Deposit handler ────────────────────────────────────────────────────────

  const handleDeposit = useCallback(async () => {
    if (!isConnected || !amountValid) return;

    setDepositError(null);
    setIsLoading(true);

    try {
      if (selectedTab === "PI") {
        // ── Native Pi deposit (Phase 12 SDK flow) ───────────────────────
        // Synchronous: opens Pi Wallet overlay; all subsequent steps are
        // driven via SDK callbacks in usePiPayment.
        initiateDeposit({ amount: parsedAmount });
      } else {
        // ── Cross-chain EVM deposit (Phase 13 relayer flow) ─────────────
        if (!piSession.luminaJwt || !piSession.user) {
          throw new Error("No Lumina JWT — re-authenticate and try again.");
        }

        // Request a deterministically-derived one-time deposit address.
        // The backend derives it from OMNICHAIN_DEPOSIT_SEED + depositID so
        // the frontend has zero influence over the address derivation —
        // maintaining trustless execution guarantees.
        const response = await requestDepositAddress({
          vaultId: piSession.user.uid,
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
          // minConfirmations is returned by the backend so the UI threshold
          // stays in sync with EVM_MIN_CONFIRMATIONS without any hardcoding.
          minConfirmations: response.minConfirmations,
          externalTxHash: null,
          sorobanTxHash: null,
          failureReason: null,
          updatedAt: new Date().toISOString(),
        };

        setActiveDeposit(depositState);
        upsertCrossChainDeposit(depositState);

        // Begin polling for on-chain confirmation and Soroban minting.
        startPolling(response.depositId);
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

  // ── Tab change resets active deposit ──────────────────────────────────────

  const handleTabChange = useCallback((tab: AssetTab) => {
    setSelectedTab(tab);
    setDepositError(null);
    setActiveDeposit(null);
    if (pollIntervalRef.current !== null) {
      clearInterval(pollIntervalRef.current);
      pollIntervalRef.current = null;
    }
  }, []);

  // ─────────────────────────────────────────────────────────────────────────────

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

      {/* ── Asset Selector Tabs ───────────────────────────────────────── */}
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

      {/* ── Asset Description ─────────────────────────────────────────── */}
      <p className="mb-4 text-[10px] text-white/40">{config.description}</p>

      {/* ── Amount Input — active only when wallet is connected ───────── */}
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

      {/* ── Error Message ─────────────────────────────────────────────── */}
      {depositError && (
        <p
          role="alert"
          className="mb-3 rounded-lg border border-red-500/20 bg-red-500/10 px-3 py-2 text-xs text-red-400"
        >
          {depositError}
        </p>
      )}

      {/* ── Cross-chain deposit address card ──────────────────────────── */}
      {activeDeposit && selectedTab !== "PI" && (
        <div className="mb-4 rounded-xl border border-white/10 bg-[#0A0A0F] p-4">
          <p className="mb-2 text-[10px] font-medium tracking-widest text-white/40 uppercase">
            Send {config.symbol} to this address on {activeDeposit.chain}
          </p>
          {/* Monospace, full-width — user copies this to their external wallet */}
          <p className="break-all font-mono text-xs text-[#F0C040]">
            {activeDeposit.depositAddress}
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

      {/* ── Deposit CTA ───────────────────────────────────────────────── */}
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

// ─── Helper ───────────────────────────────────────────────────────────────────

function assetToWrapped(asset: CrossChainAsset): string {
  const map: Record<CrossChainAsset, string> = {
    ETH:  "piETH",
    BTC:  "piBTC",
    USDT: "piUSDT",
  };
  return map[asset] ?? asset;
}
