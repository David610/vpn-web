"use client";

import { useEffect, useRef, useState } from "react";

/**
 * The top-right account chip: avatar, label and a one-item menu with Sign out.
 * The caller supplies how to sign out, because the customer portal and the
 * admin area keep separate sessions.
 */
export default function UserMenu({
  email,
  label,
  onSignOut,
}: {
  email: string;
  /** Shown next to the avatar instead of the email (the email moves into the menu). */
  label?: string;
  onSignOut: () => Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onPointer = (e: PointerEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("pointerdown", onPointer);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onPointer);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <div className="ps-user" ref={ref}>
      <button type="button" className="ps-user__button" aria-label={`Account menu for ${email}`} aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
        <span className="ps-user__avatar" aria-hidden="true">{(label ?? email).charAt(0).toUpperCase()}</span>
        <span className="ps-user__email">{label ?? email}</span>
        <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M6 9l6 6 6-6" />
        </svg>
      </button>
      {open ? (
        <div className="ps-user__menu" role="menu">
          <p className={`ps-user__menu-email${label ? " is-always" : ""}`}>{email}</p>
          <button type="button" role="menuitem" onClick={() => void onSignOut()}>
            <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M10 4H5v16h5M15 8l4 4-4 4M19 12H9" />
            </svg>
            Sign out
          </button>
        </div>
      ) : null}
    </div>
  );
}
