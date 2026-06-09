import { usePiSDK } from "../lib/usePiSDK";
import { useLuminaStore } from "../lib/store";

export function PiConnectButton() {
  const { connectWallet } = usePiSDK();
  const { piSession } = useLuminaStore();

  if (piSession.status === "connected") {
    return (
      <div
        role="status"
        aria-label={`Pi Wallet connected as ${piSession.user?.username}`}
        className="flex items-center gap-2 rounded-xl border border-[#F0C040]/20 bg-[#0F0F1A] px-4 py-2"
      >
        <span
          className="h-2 w-2 rounded-full bg-green-400"
          aria-hidden="true"
        />
        <span className="font-mono text-xs font-medium text-[#F0C040]">
          {piSession.user?.username ?? "Connected"}
        </span>
      </div>
    );
  }

  const isConnecting = piSession.status === "connecting";

  return (
    <button
      onClick={isConnecting ? undefined : connectWallet}
      disabled={isConnecting}
      aria-label="Connect your Pi Wallet to Lumina"
      className={[
        "rounded-xl border border-[#F0C040]/40 bg-[#F0C040]/10",
        "px-4 py-2 text-sm font-semibold tracking-widest text-[#F0C040] uppercase",
        "transition-all duration-150",
        isConnecting
          ? "cursor-wait opacity-60"
          : "cursor-pointer hover:border-[#F0C040]/70 hover:bg-[#F0C040]/20",
      ].join(" ")}
    >
      {isConnecting ? "Connecting…" : "Connect Pi Wallet"}
    </button>
  );
}
