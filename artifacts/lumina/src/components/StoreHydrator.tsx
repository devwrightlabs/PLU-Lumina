import { useEffect } from "react";
import { useLuminaStore } from "../lib/store";

export function StoreHydrator(): null {
  useEffect(() => {
    useLuminaStore.persist.rehydrate();
  }, []);

  return null;
}
