"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";

export type MenuItem = {
  label: string;
  href?: string;
  onSelect?: () => void;
  danger?: boolean;
};

/** A "⋯" button that opens a short list of actions. Closes on Escape or an outside click. */
export default function ActionMenu({ label, items }: { label: string; items: MenuItem[] }) {
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
    <div className="ps-menu" ref={ref}>
      <button type="button" className="ps-menu__button" aria-label={label} aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
        <svg viewBox="0 0 24 24" width="22" height="22" fill="currentColor" aria-hidden="true">
          <circle cx="5" cy="12" r="1.6" />
          <circle cx="12" cy="12" r="1.6" />
          <circle cx="19" cy="12" r="1.6" />
        </svg>
      </button>
      {open ? (
        <div className="ps-menu__list" role="menu">
          {items.map((item) =>
            item.href ? (
              <Link key={item.label} href={item.href} role="menuitem" className={item.danger ? "is-danger" : undefined} onClick={() => setOpen(false)}>
                {item.label}
              </Link>
            ) : (
              <button
                key={item.label}
                type="button"
                role="menuitem"
                className={item.danger ? "is-danger" : undefined}
                onClick={() => {
                  setOpen(false);
                  item.onSelect?.();
                }}
              >
                {item.label}
              </button>
            )
          )}
        </div>
      ) : null}
    </div>
  );
}
