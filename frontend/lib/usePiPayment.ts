/**
 * usePiPayment.ts — Custom React hook that formats a Pi Network payment
 * request and drives the Lumina 2-of-2 multi-sig vault deposit flow.
 *
 * Architecture — the Pi payment lifecycle maps to the Lumina multi-sig flow:
 *
 *  ┌─────────────────────────────────────────────────────────────────────┐
 *  │  User taps "Initiate Deposit"                                       │
 *  │  → window.Pi.createPayment() opens the Pi Wallet overlay            │
 *  │                                                                     │
 *  │  1. onReadyForServerApproval (paymentId)                            │
 *  │     → POST /v1/payments/:id/approve  (Bearer: Lumina JWT)           │
 *  │     → Backend calls Pi Platform /payments/:id/approve               │
 *  │     → Pi Wallet prompts the user to confirm                         │
 *  │     → User signs with their Master Key  ← 1st of 2-of-2 signature  │
 *  │                                                                     │
 *  │  2. onReadyForServerCompletion (paymentId, txid)                    │
 *  │     → POST /v1/payments/:id/complete  (Bearer: Lumina JWT)          │
 *  │     → Backend verifies on-chain txid, builds Soroban XDR envelope  │
 *  │     → Lumina Agent adds counter-signature  ← 2nd of 2-of-2         │
 *  │     → Escrow deposit confirmed on Stellar                           │
 *  └─────────────────────────────────────────────────────────────────────┘
 *
 *  All state transitions are written to the Zustand `multiSigTxs` map
 *  so every component on the dashboard reflects the live tx status.
 */

"use client";

import { useCallback } from "react";
import { useLuminaStore } from "@/lib/store";

// ─── Public Interface ──────────────────────────────────────────────────────────

export interface DepositParams {
  /** Amount of π to deposit into the Lumina 2-of-2 vault.  Must be > 0. */
  amount: number;
  /** Human-readable memo shown inside the Pi Wallet overlay (optional). */
  memo?: string;
}

// ─── Hook ─────────────────────────────────────────────────────────────────────

export function usePiPayment() {
  const { piSession, upsertMultiSigTx } = useLuminaStore();

  /**
   * initiateDeposit — Opens the Pi Wallet payment overlay and drives the
   * Lumina 2-of-2 multi-sig signing flow end-to-end.
   *
   * Throws if the wallet is not connected or the Pi SDK is unavailable.
   * All async state changes are reflected in the Zustand multi-sig tracker.
   */
  const initiateDeposit = useCallback(
    ({ amount, memo = "Lumina vault deposit" }: DepositParams): void => {
      if (piSession.status !== "connected" || !piSession.luminaJwt) {
        throw new Error(
          "Pi wallet is not connected — call connectWallet() first.",
        );
      }

      if (typeof window === "undefined" || !window.Pi) {
        throw new Error(
          "Pi SDK is not available — ensure the app is running inside the Pi Browser.",
        );
      }

      const backendUrl = process.env.NEXT_PUBLIC_LUMINA_API_URL;
      if (!backendUrl) {
        throw new Error(
          "NEXT_PUBLIC_LUMINA_API_URL is not set — check your environment configuration.",
        );
      }

      // Capture the JWT at call-time so the callbacks close over a stable value.
      const jwt = piSession.luminaJwt;

      const paymentData: PiPaymentData = {
        amount,
        memo,
        // Metadata is echoed back on every server callback, allowing the backend
        // to correlate this Pi payment with the corresponding Soroban vault tx.
        metadata: {
          source: "lumina-deposit",
          network: "omnichain-vault",
        },
      };

      window.Pi.createPayment(paymentData, {
        // ── Step 1: Server Approval ──────────────────────────────────────────
        /**
         * Called once the Pi Wallet overlay is open and ready.  We register the
         * payment with the Lumina backend, which in turn calls the Pi Platform
         * approve endpoint.  This is the gate that allows the user's Master Key
         * signature (1st of the 2-of-2) to proceed inside the Pi Wallet.
         */
        onReadyForServerApproval: async (paymentId: string) => {
          // Record the pending transaction immediately so the UI is responsive.
          upsertMultiSigTx({
            txId: paymentId,
            status: "pending_owner",
            updatedAt: new Date().toISOString(),
            xdrEnvelope: null,
          });

          try {
            const res = await fetch(
              `${backendUrl}/v1/payments/${paymentId}/approve`,
              {
                method: "POST",
                headers: {
                  "Content-Type": "application/json",
                  // Lumina JWT authorises the backend to act on the user's behalf.
                  Authorization: `Bearer ${jwt}`,
                },
              },
            );

            if (!res.ok) {
              console.error(
                `[Lumina] Payment approval failed — HTTP ${res.status}`,
              );
            }
          } catch (err) {
            console.error("[Lumina] Payment approval request error:", err);
          }
        },

        // ── Step 2: Server Completion ────────────────────────────────────────
        /**
         * Called after the Pi blockchain confirms the transaction.  We forward
         * the on-chain txid to the backend, which:
         *   a) Calls the Pi Platform complete endpoint.
         *   b) Constructs the Soroban XDR envelope for the vault deposit.
         *   c) Appends the Lumina Agent's counter-signature — the 2nd of 2-of-2.
         * The backend returns the signed XDR which we store for auditability.
         */
        onReadyForServerCompletion: async (
          paymentId: string,
          txid: string,
        ) => {
          upsertMultiSigTx({
            txId: paymentId,
            status: "pending_agent",
            updatedAt: new Date().toISOString(),
            xdrEnvelope: null,
          });

          try {
            const res = await fetch(
              `${backendUrl}/v1/payments/${paymentId}/complete`,
              {
                method: "POST",
                headers: {
                  "Content-Type": "application/json",
                  Authorization: `Bearer ${jwt}`,
                },
                body: JSON.stringify({ txid }),
              },
            );

            if (res.ok) {
              const { xdrEnvelope } = (await res.json()) as {
                xdrEnvelope: string | null;
              };

              upsertMultiSigTx({
                txId: paymentId,
                status: "confirmed",
                updatedAt: new Date().toISOString(),
                xdrEnvelope: xdrEnvelope ?? null,
              });
            } else {
              console.error(
                `[Lumina] Payment completion failed — HTTP ${res.status}`,
              );
              upsertMultiSigTx({
                txId: paymentId,
                status: "failed",
                updatedAt: new Date().toISOString(),
                xdrEnvelope: null,
              });
            }
          } catch (err) {
            console.error("[Lumina] Payment completion request error:", err);
            upsertMultiSigTx({
              txId: paymentId,
              status: "failed",
              updatedAt: new Date().toISOString(),
              xdrEnvelope: null,
            });
          }
        },

        // ── Cancellation ─────────────────────────────────────────────────────
        onCancel: (paymentId: string) => {
          upsertMultiSigTx({
            txId: paymentId,
            status: "failed",
            updatedAt: new Date().toISOString(),
            xdrEnvelope: null,
          });
        },

        // ── Error ─────────────────────────────────────────────────────────────
        onError: (error: Error, payment?: PiPaymentDTO) => {
          console.error("[Lumina] Pi payment SDK error:", error);
          if (payment) {
            upsertMultiSigTx({
              txId: payment.identifier,
              status: "failed",
              updatedAt: new Date().toISOString(),
              xdrEnvelope: null,
            });
          }
        },
      });
    },
    [piSession, upsertMultiSigTx],
  );

  return { initiateDeposit };
}
