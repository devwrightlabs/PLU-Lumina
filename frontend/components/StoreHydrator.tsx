/**
 * StoreHydrator.tsx — Client-side Zustand rehydration trigger.
 *
 * Because the Lumina store is created with `skipHydration: true`, it will not
 * pull its persisted state from localStorage during the SSR pass.  This
 * component mounts on the client and calls `rehydrate()` exactly once,
 * ensuring the hydration happens after the DOM is ready and preventing
 * React hydration mismatches in Next.js App Router.
 */

"use client";

import { useEffect } from "react";
import { useLuminaStore } from "@/lib/store";

export function StoreHydrator(): null {
  useEffect(() => {
    // Trigger Zustand persist rehydration on first client render.
    useLuminaStore.persist.rehydrate();
  }, []);

  return null;
}
