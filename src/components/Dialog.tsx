"use client";

import { useEffect, useId, useRef, useState } from "react";

type DialogBaseProps = {
  open: boolean;
  title: string;
  description?: string;
  busy?: boolean;
  error?: string | null;
  onCancel: () => void;
};

/**
 * Native <dialog>-based modal shell shared by every Arcana confirmation/
 * form dialog. Handles showModal/close, Escape, focus trap and focus
 * return via the browser's own dialog semantics, and restores focus to
 * the element that had it before opening.
 */
function DialogShell({
  open,
  titleId,
  onCancel,
  children,
}: {
  open: boolean;
  titleId: string;
  onCancel: () => void;
  children: React.ReactNode;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const returnFocus = useRef<HTMLElement | null>(null);

  useEffect(() => {
    const dlg = ref.current;
    if (!dlg) return;
    if (open && !dlg.open) {
      returnFocus.current = document.activeElement as HTMLElement | null;
      dlg.showModal();
    } else if (!open && dlg.open) {
      dlg.close();
      returnFocus.current?.focus?.();
    }
  }, [open]);

  return (
    <dialog
      ref={ref}
      aria-labelledby={titleId}
      className="dialog"
      onCancel={(e) => {
        e.preventDefault();
        onCancel();
      }}
      onClose={() => {
        if (open) onCancel();
      }}
    >
      {children}
    </dialog>
  );
}

/** Confirm a destructive or non-destructive action. No free-text input. */
export function ConfirmDialog({
  open,
  title,
  description,
  confirmLabel,
  danger,
  busy,
  error,
  onConfirm,
  onCancel,
}: DialogBaseProps & {
  confirmLabel: string;
  danger?: boolean;
  onConfirm: () => void;
}) {
  const titleId = useId();
  const confirmRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (open) confirmRef.current?.focus();
  }, [open]);

  return (
    <DialogShell open={open} titleId={titleId} onCancel={onCancel}>
      <form
        method="dialog"
        className="dialog__body"
        onSubmit={(e) => {
          e.preventDefault();
          if (!busy) onConfirm();
        }}
      >
        <h2 id={titleId} className="dialog__title">{title}</h2>
        {description ? <p className="dialog__desc">{description}</p> : null}
        {error ? <p className="notice notice--error" role="alert">{error}</p> : null}
        <div className="dialog__actions">
          <button type="button" className="btn btn-secondary" onClick={onCancel} disabled={busy}>
            Cancel
          </button>
          <button
            ref={confirmRef}
            type="submit"
            className={danger ? "btn btn-danger" : "btn btn-primary"}
            disabled={busy}
          >
            {busy ? "Working…" : confirmLabel}
          </button>
        </div>
      </form>
    </DialogShell>
  );
}

/** Replaces window.prompt: a single labelled text field plus Cancel/Save. */
export function InputDialog({
  open,
  title,
  description,
  label,
  initialValue,
  placeholder,
  maxLength,
  confirmLabel = "Save",
  busy,
  error,
  onConfirm,
  onCancel,
}: DialogBaseProps & {
  label: string;
  initialValue: string;
  placeholder?: string;
  maxLength?: number;
  confirmLabel?: string;
  onConfirm: (value: string) => void;
}) {
  const titleId = useId();
  const inputId = useId();
  const inputRef = useRef<HTMLInputElement>(null);
  const [value, setValue] = useState(initialValue);

  useEffect(() => {
    if (open) {
      setValue(initialValue);
      // Focus after the dialog paints so showModal has already run.
      const t = window.setTimeout(() => inputRef.current?.select(), 0);
      return () => window.clearTimeout(t);
    }
  }, [open, initialValue]);

  const trimmed = value.trim();
  const invalid = trimmed.length === 0;

  return (
    <DialogShell open={open} titleId={titleId} onCancel={onCancel}>
      <form
        method="dialog"
        className="dialog__body"
        onSubmit={(e) => {
          e.preventDefault();
          if (!busy && !invalid) onConfirm(trimmed);
        }}
      >
        <h2 id={titleId} className="dialog__title">{title}</h2>
        {description ? <p className="dialog__desc">{description}</p> : null}
        <div>
          <label className="field-label" htmlFor={inputId}>{label}</label>
          <input
            ref={inputRef}
            id={inputId}
            className="field"
            autoComplete="off"
            maxLength={maxLength}
            placeholder={placeholder}
            value={value}
            onChange={(e) => setValue(e.target.value)}
            aria-invalid={invalid || undefined}
          />
        </div>
        {error ? <p className="notice notice--error" role="alert">{error}</p> : null}
        <div className="dialog__actions">
          <button type="button" className="btn btn-secondary" onClick={onCancel} disabled={busy}>
            Cancel
          </button>
          <button type="submit" className="btn btn-primary" disabled={busy || invalid}>
            {busy ? "Saving…" : confirmLabel}
          </button>
        </div>
      </form>
    </DialogShell>
  );
}

export type DialogAction = {
  label: string;
  onSelect: () => void;
  danger?: boolean;
  disabled?: boolean;
  /** Visually separated from the actions above it (e.g. a destructive one). */
  separated?: boolean;
};

/**
 * A short list of actions for a row that has more choices than fit
 * comfortably inline (e.g. a subscription's Rename/Remove pack/Cancel).
 * Replaces a reflowing row of buttons with one small, consistent "Manage"
 * entry point.
 */
export function ActionsDialog({
  open,
  title,
  actions,
  onCancel,
}: {
  open: boolean;
  title: string;
  actions: DialogAction[];
  onCancel: () => void;
}) {
  const titleId = useId();
  return (
    <DialogShell open={open} titleId={titleId} onCancel={onCancel}>
      <div className="dialog__body">
        <h2 id={titleId} className="dialog__title">{title}</h2>
        <div className="dialog__menu">
          {actions.map((action, i) => (
            <button
              key={action.label}
              type="button"
              className={`dialog__menu-item ${action.danger ? "text-danger" : ""}`.trim()}
              disabled={action.disabled}
              onClick={action.onSelect}
              style={action.separated && i > 0 ? { marginTop: "var(--space-4)", borderTop: "1px solid var(--border)", paddingTop: "var(--space-6)" } : undefined}
            >
              {action.label}
            </button>
          ))}
        </div>
        <div className="dialog__actions">
          <button type="button" className="btn btn-secondary" onClick={onCancel}>
            Close
          </button>
        </div>
      </div>
    </DialogShell>
  );
}
