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
      className="w-full max-w-md border border-black bg-white p-0 text-black backdrop:bg-black/40"
    >
      <form
        method="dialog"
        className="space-y-4 p-5"
        onSubmit={(e) => {
          e.preventDefault();
          if (matches && !busy) onConfirm();
        }}
      >
        <h2 id={titleId} className="text-base font-semibold">{title}</h2>
        <p className="text-sm text-gray-700">{description}</p>
        {children}
        <div>
          <label htmlFor={inputId} className="grid text-xs text-gray-600">
            Type <code className="font-mono font-semibold text-black">{expected}</code> to confirm
          </label>
          <input
            id={inputId}
            className="mt-1 w-full border border-gray-400 px-2 py-1 font-mono text-sm"
            autoComplete="off"
            value={typed}
            onChange={(e) => setTyped(e.target.value)}
          />
        </div>
        <div className="flex justify-end gap-2 border-t border-gray-200 pt-4">
          <button type="button" className="border border-gray-400 px-3 py-1 text-sm" onClick={onCancel}>
            Cancel
          </button>
          <button
            type="submit"
            disabled={!matches || busy}
            className="border border-black bg-black px-3 py-1 text-sm text-white disabled:opacity-40"
          >
            {busy ? "Working…" : actionLabel}
          </button>
        </div>
      </form>
    </dialog>
  );
}
