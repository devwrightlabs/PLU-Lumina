import { motion, AnimatePresence } from "framer-motion";
import { Clock, Loader2, CheckCircle2, XCircle, ArrowRight } from "lucide-react";
import { useLuminaStore } from "../lib/store";
import type { PaymentStatus } from "../types/lumina";

const STATUS_CONFIG: Record<
  PaymentStatus,
  { label: string; icon: typeof Clock; color: string; bg: string; dotClass: string }
> = {
  pending_approval: {
    label: "Pending Approval",
    icon: Clock,
    color: "text-yellow-400",
    bg: "bg-yellow-400/10 border-yellow-400/20",
    dotClass: "bg-yellow-400 ripple-dot ripple-dot-yellow",
  },
  processing: {
    label: "Processing",
    icon: Loader2,
    color: "text-blue-400",
    bg: "bg-blue-400/10 border-blue-400/20",
    dotClass: "bg-blue-400 ripple-dot ripple-dot-blue",
  },
  confirmed: {
    label: "Confirmed",
    icon: CheckCircle2,
    color: "text-emerald-400",
    bg: "bg-emerald-400/10 border-emerald-400/20",
    dotClass: "bg-emerald-400 ripple-dot ripple-dot-green",
  },
  failed: {
    label: "Failed",
    icon: XCircle,
    color: "text-red-400",
    bg: "bg-red-400/10 border-red-400/20",
    dotClass: "bg-red-400",
  },
};

const STEPS: PaymentStatus[] = ["pending_approval", "processing", "confirmed"];

export function PaymentStatusTracker() {
  const { pendingPayments } = useLuminaStore();

  const paymentList = Object.values(pendingPayments)
    .sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime())
    .slice(0, 8);

  if (paymentList.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-8 text-center">
        <div className="mb-3 flex h-12 w-12 items-center justify-center rounded-full bg-white/[0.04] border border-white/[0.06]">
          <Clock className="h-5 w-5 text-white/20" />
        </div>
        <p className="text-sm font-medium text-white/25">No active payments</p>
        <p className="mt-1 text-xs text-white/15">
          Initiate a vault deposit to track it here
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-3" aria-label="Payment status list">
      <AnimatePresence initial={false}>
        {paymentList.map((payment, idx) => {
          const cfg = STATUS_CONFIG[payment.status];
          const Icon = cfg.icon;
          const stepIndex = STEPS.indexOf(payment.status);

          return (
            <motion.div
              key={payment.paymentId}
              initial={{ opacity: 0, y: -8, scale: 0.98 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={{ opacity: 0, scale: 0.96 }}
              transition={{ duration: 0.3, delay: idx * 0.04 }}
              className={`rounded-xl border px-4 py-3.5 ${cfg.bg}`}
            >
              <div className="flex items-start justify-between gap-3">
                <div className="flex items-center gap-3 min-w-0">
                  <div className={`relative flex h-2.5 w-2.5 shrink-0 rounded-full ${cfg.dotClass}`} />
                  <div className="min-w-0">
                    <p className="truncate font-mono text-[11px] text-white/45">
                      #{payment.paymentId.slice(0, 20)}…
                    </p>
                    {payment.txid && (
                      <p className="mt-0.5 truncate font-mono text-[10px] text-white/25">
                        tx: {payment.txid.slice(0, 22)}…
                      </p>
                    )}
                  </div>
                </div>
                <div className="shrink-0 flex items-center gap-2">
                  <Icon className={`h-3.5 w-3.5 ${cfg.color} ${payment.status === "processing" ? "animate-spin" : ""}`} />
                  <div className="text-right">
                    <p className={`text-xs font-bold ${cfg.color}`}>{cfg.label}</p>
                    <p className="text-[10px] text-white/20">
                      {new Date(payment.updatedAt).toLocaleTimeString()}
                    </p>
                  </div>
                </div>
              </div>

              {payment.status !== "failed" && stepIndex >= 0 && (
                <div className="mt-3 flex items-center gap-1">
                  {STEPS.map((step, i) => (
                    <div key={step} className="flex items-center gap-1">
                      <div
                        className={[
                          "h-1.5 rounded-full transition-all duration-500",
                          i <= stepIndex
                            ? "bg-[#F0C040] w-6"
                            : "bg-white/10 w-4",
                        ].join(" ")}
                      />
                      {i < STEPS.length - 1 && (
                        <ArrowRight className={`h-2.5 w-2.5 ${i < stepIndex ? "text-[#F0C040]/40" : "text-white/10"}`} />
                      )}
                    </div>
                  ))}
                  <span className="ml-2 text-[10px] text-white/25">
                    Step {Math.min(stepIndex + 1, STEPS.length)}/{STEPS.length}
                  </span>
                </div>
              )}
            </motion.div>
          );
        })}
      </AnimatePresence>
    </div>
  );
}
