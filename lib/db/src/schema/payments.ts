import {
  pgTable,
  text,
  numeric,
  timestamp,
  uuid,
  pgEnum,
} from "drizzle-orm/pg-core";
import { usersTable } from "./users";

export const paymentStatusEnum = pgEnum("payment_status", [
  "pending",
  "approved",
  "confirmed",
  "failed",
  "cancelled",
]);

/**
 * Tracks Pi Network payments processed through the Lumina vault.
 */
export const paymentsTable = pgTable("payments", {
  id: uuid("id").primaryKey().defaultRandom(),
  piPaymentId: text("pi_payment_id").notNull().unique(),
  userId: uuid("user_id").references(() => usersTable.id, { onDelete: "set null" }),
  amountPi: numeric("amount_pi", { precision: 18, scale: 7 }).notNull(),
  memo: text("memo").notNull().default(""),
  status: paymentStatusEnum("status").notNull().default("pending"),
  piTxid: text("pi_txid"),
  sorobanTxHash: text("soroban_tx_hash"),
  sorobanError: text("soroban_error"),
  contractAddress: text("contract_address"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export type InsertPayment = typeof paymentsTable.$inferInsert;
export type Payment = typeof paymentsTable.$inferSelect;
