"use client";

import { useEffect, useId, useRef, useState } from "react";

/**
 * Modal confirm for destructive fleet actions: the admin must type the
 * exact node id before the action button enables.
 */
export function TypedConfirmDialog({
  open,
  title,
  description,
  expected,
  actionLabel,
  busy,
  onConfirm,
  onCancel,
  children,
}: {
  open: boolean;
  title: string;
  description: string;
  expected: string;
  actionLabel: string;
  busy?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
  children?: React.ReactNode;
}) {
  const [typed, setTyped] = useState("");
  const ref = useRef<HTMLDialogElement>(null);
  const inputId = useId();
  const titleId = useId();

  useEffect(() => {
    const dlg = ref.current;
    if (!dlg) return;
    if (open && !dlg.open) {
      setTyped("");
      if (typeof dlg.showModal === "function") dlg.showModal();
      else dlg.setAttribute("open", "");
    } else if (!open && dlg.open) {
      dlg.close();
    }
  }, [open]);

  const matches = typed === expected;

  return (
    <dialog
      ref={ref}
      aria-labelledby={titleId}
      onCancel={(e) => {
        e.preventDefault();
        onCancel();
      }}
      className="w-full max-w-md border border-[color:var(--border-strong)] bg-bg p-0 text-fg backdrop:bg-black/40"
    >
      <form
        method="dialog"
        className="space-y-4 p-5"
        onSubmit={(e) => {
          e.preventDefault();
          if (matches && !busy) onConfirm();
        }}
      >
        <h2 id={titleId} className="text-base font-semibold text-fg">{title}</h2>
        <p className="text-sm text-fg-2">{description}</p>
        {children}
        <div>
          <label htmlFor={inputId} className="grid text-xs text-fg-3">
            Type <code className="font-mono font-semibold text-fg">{expected}</code> to confirm
          </label>
          <input
            id={inputId}
            className="admin-input mt-1 font-mono"
            autoComplete="off"
            value={typed}
            onChange={(e) => setTyped(e.target.value)}
          />
        </div>
        <div className="flex justify-end gap-2 border-t border-border pt-4">
          <button type="button" className="btn btn-secondary btn-sm" onClick={onCancel}>
            Cancel
          </button>
          <button
            type="submit"
            disabled={!matches || busy}
            className="btn btn-primary btn-sm disabled:opacity-40"
          >
            {busy ? "Working…" : actionLabel}
          </button>
        </div>
      </form>
    </dialog>
  );
}
