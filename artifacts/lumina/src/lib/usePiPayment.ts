import { useCallback } from "react";
import { useLuminaStore } from "./store";

export interface DepositParams {
  amount: number;
  memo?: string;
}

export function usePiPayment() {
  const { piSession, upsertMultiSigTx } = useLuminaStore();

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

      const backendUrl = import.meta.env.VITE_LUMINA_API_URL;
      if (!backendUrl) {
        throw new Error(
          "VITE_LUMINA_API_URL is not set — check your environment configuration.",
        );
      }

      const jwt = piSession.luminaJwt;

      const paymentData: PiPaymentData = {
        amount,
        memo,
        metadata: {
          source: "lumina-deposit",
          network: "omnichain-vault",
        },
      };

      window.Pi.createPayment(paymentData, {
        onReadyForServerApproval: async (paymentId: string) => {
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
                  Authorization: `Bearer ${jwt}`,
                },
              },
            );

            if (!res.ok) {
              console.error(
                `[Lumina] Payment approval failed — HTTP ${res.status}`,
              );
              upsertMultiSigTx({
                txId: paymentId,
                status: "failed",
                updatedAt: new Date().toISOString(),
                xdrEnvelope: null,
              });
            }
          } catch (err) {
            console.error("[Lumina] Payment approval request error:", err);
            upsertMultiSigTx({
              txId: paymentId,
              status: "failed",
              updatedAt: new Date().toISOString(),
              xdrEnvelope: null,
            });
          }
        },

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

        onCancel: (paymentId: string) => {
          upsertMultiSigTx({
            txId: paymentId,
            status: "failed",
            updatedAt: new Date().toISOString(),
            xdrEnvelope: null,
          });
        },

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
