/**
 * layout.tsx — Root application shell for Lumina.
 *
 * Responsibilities:
 *  1. Sets the HTML-level metadata (viewport, title, description).
 *  2. Enforces the enterprise dark-mode brand palette globally via
 *     the `bg-[#0A0A0F]` and `text-[#E8E8F0]` Tailwind utilities.
 *  3. Renders the <StoreHydrator /> which triggers Zustand's client-side
 *     rehydration after the initial render, preventing hydration mismatches.
 *  4. Wraps children in a full-height flex column so that the sticky header
 *     and footer (added in later phases) behave correctly.
 *
 * The `"use client"` directive is intentionally absent here: this layout
 * remains a React Server Component so metadata exports work correctly.
 * Client interactivity is isolated to the StoreHydrator and leaf components.
 */

import type { Metadata, Viewport } from "next";
import "./globals.css";
import { StoreHydrator } from "@/components/StoreHydrator";
import { PiConnectButton } from "@/components/PiConnectButton";

export const metadata: Metadata = {
  title: "Lumina — Omnichain Pi Vault",
  description:
    "Institutional-grade, Pi-native vault with 2-of-2 multi-sig security and omnichain asset support.",
  applicationName: "PLU-Lumina",
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  // Matches the Lumina brand background so the status bar blends in the Pi Browser.
  themeColor: "#0A0A0F",
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en" className="h-full">
      <body className="flex min-h-full flex-col bg-[#0A0A0F] text-[#E8E8F0] antialiased">
        {/*
         * StoreHydrator is a null-rendering client component.
         * It triggers zustand/persist rehydration on the client after mount,
         * ensuring localStorage state is available before any interactive
         * component renders its first interactive frame.
         */}
        <StoreHydrator />

        {/* ── Top Navigation Bar ──────────────────────────────────────── */}
        <header className="sticky top-0 z-50 flex items-center justify-between border-b border-[#F0C040]/10 bg-[#0A0A0F]/80 px-6 py-4 backdrop-blur-md">
          <div className="flex items-center gap-3">
            {/* Gold diamond logotype — a visual trust anchor. */}
            <span className="text-2xl text-[#F0C040]" aria-hidden="true">◆</span>
            <span className="text-lg font-bold tracking-widest text-[#F0C040] uppercase">
              Lumina
            </span>
          </div>
          <nav aria-label="Primary navigation">
            <ul className="flex items-center gap-6 text-xs font-medium tracking-widest text-white/40 uppercase">
              <li>
                <a href="/" className="transition-colors hover:text-[#F0C040]">
                  Dashboard
                </a>
              </li>
              <li>
                <a href="/vault" className="transition-colors hover:text-[#F0C040]">
                  Vault
                </a>
              </li>
              <li>
                <a href="/history" className="transition-colors hover:text-[#F0C040]">
                  History
                </a>
              </li>
              <li>
                {/*
                 * PiConnectButton renders the wallet connection CTA or the
                 * authenticated identity pill depending on Zustand session state.
                 * It is a client component and is safe to render from this RSC.
                 */}
                <PiConnectButton />
              </li>
            </ul>
          </nav>
        </header>

        {/* ── Main Content Area ───────────────────────────────────────── */}
        <main className="flex flex-1 flex-col">{children}</main>

        {/* ── Footer ─────────────────────────────────────────────────── */}
        <footer className="border-t border-[#F0C040]/10 px-6 py-4 text-center text-[10px] tracking-widest text-white/20 uppercase">
          © {new Date().getFullYear()} Devright Labs · PLU-Lumina · All rights reserved
        </footer>
      </body>
    </html>
  );
}
