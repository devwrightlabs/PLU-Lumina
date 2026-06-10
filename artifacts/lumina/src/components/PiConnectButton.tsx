import { motion, AnimatePresence } from "framer-motion";
import { Wallet, CheckCircle2, Loader2, AlertCircle } from "lucide-react";
import { usePiSDK } from "../lib/usePiSDK";
import { useLuminaStore } from "../lib/store";

export function PiConnectButton() {
  const { connectWallet } = usePiSDK();
  const { piSession } = useLuminaStore();

  if (piSession.status === "connected") {
    return (
      <motion.div
        initial={{ opacity: 0, scale: 0.9 }}
        animate={{ opacity: 1, scale: 1 }}
        transition={{ duration: 0.3 }}
        role="status"
        aria-label={`Pi Wallet connected as ${piSession.user?.username}`}
        className="flex items-center gap-2.5 rounded-xl px-4 py-2"
        style={{
          background: "rgba(74,222,128,0.08)",
          border: "1px solid rgba(74,222,128,0.2)",
          boxShadow: "0 0 20px rgba(74,222,128,0.08)",
        }}
      >
        <span className="relative flex h-2 w-2 shrink-0">
          <span className="ripple-dot ripple-dot-green absolute inline-flex h-full w-full rounded-full bg-emerald-400" />
          <span className="relative inline-flex h-2 w-2 rounded-full bg-emerald-400" />
        </span>
        <CheckCircle2 className="h-3.5 w-3.5 text-emerald-400" />
        <span className="font-mono text-xs font-semibold text-emerald-300">
          {piSession.user?.username ?? "Connected"}
        </span>
      </motion.div>
    );
  }

  if (piSession.status === "error") {
    return (
      <motion.button
        onClick={connectWallet}
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        className="flex items-center gap-2 rounded-xl border border-red-500/30 bg-red-500/10 px-4 py-2 text-xs font-semibold text-red-400 transition-all hover:bg-red-500/15"
      >
        <AlertCircle className="h-3.5 w-3.5" />
        Retry Connection
      </motion.button>
    );
  }

  const isConnecting = piSession.status === "connecting";

  return (
    <AnimatePresence mode="wait">
      <motion.button
        key="connect"
        onClick={isConnecting ? undefined : connectWallet}
        disabled={isConnecting}
        aria-label="Connect your Pi Wallet to Lumina"
        whileHover={isConnecting ? {} : { scale: 1.03 }}
        whileTap={isConnecting ? {} : { scale: 0.97 }}
        className={[
          "relative flex items-center gap-2 overflow-hidden rounded-xl px-5 py-2.5 text-sm font-black tracking-widest uppercase",
          isConnecting
            ? "cursor-wait opacity-70"
            : "cursor-pointer btn-gold-shimmer",
        ].join(" ")}
        style={isConnecting ? {
          background: "rgba(240,192,64,0.12)",
          border: "1px solid rgba(240,192,64,0.3)",
          color: "#F0C040",
        } : {}}
      >
        {isConnecting ? (
          <>
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
            <span className="text-[11px]">Connecting…</span>
          </>
        ) : (
          <>
            <Wallet className="h-3.5 w-3.5" />
            <span className="text-[11px]">Connect Pi Wallet</span>
          </>
        )}
      </motion.button>
    </AnimatePresence>
  );
}
