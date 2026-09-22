"use client";

import { useState } from "react";

/**
 * A button that requires a second click within 4s to actually fire
 * onConfirm — the minimum-friction confirm pattern for disable/enable/
 * rotate/retry, which are all real mutations against real customer VPN
 * access. Not a modal, to keep this component tiny; upgrade to a real
 * dialog if a future admin reports a misclick.
 */
export function ConfirmButton({
  label,
  confirmLabel,
  onConfirm,
  className,
}: {
  label: string;
  confirmLabel: string;
  onConfirm: () => void;
  className?: string;
}) {
  const [confirming, setConfirming] = useState(false);

  return (
    <button
      className={className}
      onClick={() => {
        if (confirming) {
          setConfirming(false);
          onConfirm();
        } else {
          setConfirming(true);
          setTimeout(() => setConfirming(false), 4000);
        }
      }}
    >
      {confirming ? confirmLabel : label}
    </button>
  );
}
