/**
 * usePiSDK.ts — Custom React hook for Pi Network SDK initialisation and
 * native wallet authentication.
 *
 * Architecture:
 *  1. On mount, calls `window.Pi.init` exactly once using a ref guard.
 *     The `NEXT_PUBLIC_PI_SANDBOX` env variable controls whether the SDK
 *     points at the Pi Testnet (sandbox) or Pi Mainnet — the same code
 *     ships to both environments without modification.
 *
 *  2. `connectWallet` invokes `window.Pi.authenticate` to request the user's
 *     Pi identity via the native browser overlay (scopes: username + payments).
 *     The resulting access token is immediately forwarded to the Lumina-Core
 *     backend for server-side verification against the Pi Platform API.
 *     On success, the Lumina JWT is written to the Zustand session store
 *     (never to localStorage — the store's `partialize` config excludes it).
 *
 *  3. `handleIncompletePayment` is the `onIncompletePaymentFound` callback
 *     required by `Pi.authenticate`.  It surfaces any in-flight payment that
 *     the user started but never completed, inserting it into the Zustand
 *     multi-sig tracker so the UI can prompt resolution before a new deposit.
 */

"use client";

import { useCallback, useEffect, useRef } from "react";
import { useLuminaStore } from "@/lib/store";

/** Pi SDK version targeted by this integration. */
const PI_SDK_VERSION = "2.0";

/**
 * Scopes requested from the user during authentication.
 * `username` gives us uid + username; `payments` allows deposit creation.
 */
const PI_SCOPES: PiScope[] = ["username", "payments"];

// ─── Hook ─────────────────────────────────────────────────────────────────────

export function usePiSDK() {
  const { setPiSession, upsertMultiSigTx } = useLuminaStore();

  // Prevent double-initialisation in React Strict Mode's double-invoke.
  const initialised = useRef(false);

  // ── SDK Initialisation ─────────────────────────────────────────────────────
  useEffect(() => {
    if (initialised.current) return;
    if (typeof window === "undefined" || !window.Pi) {
      // Not running inside a Pi Browser — leave session as "idle".
      return;
    }

    const sandbox = process.env.NEXT_PUBLIC_PI_SANDBOX === "true";

    // Bind the SDK to the correct network before any other SDK call.
    window.Pi.init({ version: PI_SDK_VERSION, sandbox });
    initialised.current = true;
  }, []);

  // ── Incomplete Payment Recovery ────────────────────────────────────────────
  /**
   * Called by the Pi SDK if a previous payment was started but never finished.
   * We surface it in the Zustand multi-sig tracker so the dashboard can
   * prompt the user to complete or cancel it before initiating a new deposit.
   */
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

  // ── Authentication ─────────────────────────────────────────────────────────
  /**
   * Triggers the native Pi Browser auth overlay, then exchanges the resulting
   * access token for a Lumina JWT issued by the Go backend.  The JWT is stored
   * in the Zustand session slice (in-memory only; excluded from localStorage).
   */
  const connectWallet = useCallback(async (): Promise<void> => {
    if (typeof window === "undefined" || !window.Pi) {
      // SDK unavailable — this can happen when running outside Pi Browser.
      setPiSession({ status: "error" });
      return;
    }

    setPiSession({ status: "connecting" });

    try {
      // Request the Pi Browser's native wallet overlay for authentication.
      const authResult = await window.Pi.authenticate(
        PI_SCOPES,
        handleIncompletePayment,
      );

      const backendUrl = process.env.NEXT_PUBLIC_LUMINA_API_URL;
      if (!backendUrl) {
        throw new Error(
          "NEXT_PUBLIC_LUMINA_API_URL is not set — check your environment configuration.",
        );
      }

      // Exchange the Pi-issued access token for a Lumina JWT.
      // The backend verifies the token against the Pi Platform API and
      // returns a signed JWT that authorises subsequent vault operations.
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

      // Commit the verified session to the Zustand store.
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
