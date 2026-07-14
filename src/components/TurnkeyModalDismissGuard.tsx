"use client";

import { useEffect } from "react";

/**
 * Turnkey's modal closes on backdrop mousedown. That discards in-progress OTP /
 * wallet selection. Capture-phase stop keeps the X button working (it's a child)
 * while preventing accidental dismiss when clicking outside.
 */
export function TurnkeyModalDismissGuard() {
  useEffect(() => {
    const onMouseDown = (event: MouseEvent) => {
      const target = event.target;
      if (!(target instanceof Element)) return;
      if (!target.classList.contains("tk-modal")) return;
      event.stopImmediatePropagation();
    };

    document.addEventListener("mousedown", onMouseDown, true);
    return () => {
      document.removeEventListener("mousedown", onMouseDown, true);
    };
  }, []);

  return null;
}
