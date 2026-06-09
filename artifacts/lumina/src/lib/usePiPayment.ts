import { useCallback } from "react";
import { useLuminaStore } from "./store";

export interface DepositParams {
  amount: number;
  memo?: string;
}

export function usePiPayment() {
  const { piSession, upsertPendingPayment } = useLuminaStore();

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
          upsertPendingPayment({
            paymentId,
            status: "pending_approval",
            updatedAt: new Date().toISOString(),
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
              upsertPendingPayment({
                paymentId,
                status: "failed",
                updatedAt: new Date().toISOString(),
              });
            }
          } catch (err) {
            console.error("[Lumina] Payment approval request error:", err);
            upsertPendingPayment({
              paymentId,
              status: "failed",
              updatedAt: new Date().toISOString(),
            });
          }
        },

        onReadyForServerCompletion: async (
          paymentId: string,
          txid: string,
        ) => {
          upsertPendingPayment({
            paymentId,
            status: "processing",
            updatedAt: new Date().toISOString(),
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
              upsertPendingPayment({
                paymentId,
                status: "confirmed",
                txid,
                updatedAt: new Date().toISOString(),
              });
            } else {
              console.error(
                `[Lumina] Payment completion failed — HTTP ${res.status}`,
              );
              upsertPendingPayment({
                paymentId,
                status: "failed",
                updatedAt: new Date().toISOString(),
              });
            }
          } catch (err) {
            console.error("[Lumina] Payment completion request error:", err);
            upsertPendingPayment({
              paymentId,
              status: "failed",
              updatedAt: new Date().toISOString(),
            });
          }
        },

        onCancel: (paymentId: string) => {
          upsertPendingPayment({
            paymentId,
            status: "failed",
            updatedAt: new Date().toISOString(),
          });
        },

        onError: (error: Error, payment?: PiPaymentDTO) => {
          console.error("[Lumina] Pi payment SDK error:", error);
          if (payment) {
            upsertPendingPayment({
              paymentId: payment.identifier,
              status: "failed",
              updatedAt: new Date().toISOString(),
            });
          }
        },
      });
    },
    [piSession, upsertPendingPayment],
  );

  return { initiateDeposit };
}

