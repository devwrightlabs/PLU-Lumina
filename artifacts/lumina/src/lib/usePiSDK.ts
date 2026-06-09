import { useCallback, useEffect, useRef } from "react";
import { useLuminaStore } from "./store";

const PI_SDK_VERSION = "2.0";
const PI_SCOPES: PiScope[] = ["username", "payments"];

export function usePiSDK() {
  const { setPiSession, upsertMultiSigTx } = useLuminaStore();

  const initialised = useRef(false);

  useEffect(() => {
    if (initialised.current) return;
    if (typeof window === "undefined" || !window.Pi) {
      return;
    }

    const sandbox = import.meta.env.VITE_PI_SANDBOX === "true";

    window.Pi.init({ version: PI_SDK_VERSION, sandbox });
    initialised.current = true;
  }, []);

  const handleIncompletePayment = useCallback(
    (payment: PiPaymentDTO) => {
      upsertMultiSigTx({
        txId: payment.identifier,
        status: "pending_owner",
        updatedAt: new Date().toISOString(),
        xdrEnvelope: null,
      });
    },
    [upsertMultiSigTx],
  );

  const connectWallet = useCallback(async (): Promise<void> => {
    if (typeof window === "undefined" || !window.Pi) {
      setPiSession({ status: "error" });
      return;
    }

    setPiSession({ status: "connecting" });

    try {
      const authResult = await window.Pi.authenticate(
        PI_SCOPES,
        handleIncompletePayment,
      );

      const backendUrl = import.meta.env.VITE_LUMINA_API_URL;
      if (!backendUrl) {
        throw new Error(
          "VITE_LUMINA_API_URL is not set — check your environment configuration.",
        );
      }

      const res = await fetch(`${backendUrl}/v1/auth/pi`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ accessToken: authResult.accessToken }),
      });

      if (!res.ok) {
        throw new Error(
          `Lumina auth endpoint returned HTTP ${res.status} — check backend logs.`,
        );
      }

      const { jwt } = (await res.json()) as { jwt: string };

      setPiSession({
        status: "connected",
        user: {
          uid: authResult.user.uid,
          username: authResult.user.username,
        },
        luminaJwt: jwt,
      });
    } catch (err) {
      console.error("[Lumina] Pi wallet authentication failed:", err);
      setPiSession({ status: "error" });
    }
  }, [setPiSession, handleIncompletePayment]);

  return { connectWallet };
}
