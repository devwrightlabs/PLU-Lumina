import { useLuminaStore } from "../lib/store";
import type { PaymentStatus } from "../types/lumina";

const STATUS_LABEL: Record<PaymentStatus, string> = {
  pending_approval: "Pending Approval",
  processing: "Processing",
  confirmed: "Confirmed",
  failed: "Failed",
};

const STATUS_COLOR: Record<PaymentStatus, string> = {
  pending_approval: "text-yellow-400",
  processing: "text-blue-400",
  confirmed: "text-green-400",
  failed: "text-red-400",
};

const STATUS_DOT: Record<PaymentStatus, string> = {
  pending_approval: "bg-yellow-400 animate-pulse",
  processing: "bg-blue-400 animate-pulse",
  confirmed: "bg-green-400",
  failed: "bg-red-400",
};

export function PaymentStatusTracker() {
  const { pendingPayments } = useLuminaStore();

  const paymentList = Object.values(pendingPayments)
    .sort(
      (a, b) =>
        new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime(),
    )
    .slice(0, 10);

  if (paymentList.length === 0) {
    return (
      <p className="text-sm text-white/30">
        No in-flight payments. Once you initiate a vault deposit its status
        will appear here in real time.
      </p>
    );
  }

  return (
    <ul className="space-y-3" aria-label="Payment status list">
      {paymentList.map((payment) => (
        <li
          key={payment.paymentId}
          className="flex items-start justify-between gap-4 rounded-xl border border-white/5 bg-[#0A0A0F] px-4 py-3"
        >
          <div className="flex min-w-0 items-center gap-3">
            <span
              className={`mt-0.5 h-2 w-2 shrink-0 rounded-full ${STATUS_DOT[payment.status]}`}
              aria-hidden="true"
            />
            <div className="min-w-0">
              <p className="truncate font-mono text-xs text-white/50">
                {payment.paymentId}
              </p>
              {payment.txid && (
                <p className="mt-0.5 truncate font-mono text-[10px] text-white/20">
                  tx: {payment.txid.slice(0, 24)}…
                </p>
              )}
            </div>
          </div>

          <div className="shrink-0 text-right">
            <p className={`text-xs font-semibold ${STATUS_COLOR[payment.status]}`}>
              {STATUS_LABEL[payment.status]}
            </p>
            <p className="mt-0.5 text-[10px] text-white/20">
              {new Date(payment.updatedAt).toLocaleTimeString()}
            </p>
          </div>
        </li>
      ))}
    </ul>
  );
}
