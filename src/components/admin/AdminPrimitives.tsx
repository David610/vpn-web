"use client";

import type { ButtonHTMLAttributes, LabelHTMLAttributes, ReactNode, TableHTMLAttributes } from "react";

/**
 * Small shared visual layer for the admin area. Admin keeps its own precise
 * vocabulary (node/relay/exit/canary/drain/revision/lifecycle) and stays
 * information-dense — these are structural/visual primitives only, built
 * from the same Arcana tokens (src/app/globals.css `:root`, wired into
 * Tailwind by tailwind.config.js: bg/bg-alt/bg-panel/fg/fg-2/fg-3/border/
 * accent/danger, radius sm/md/lg) and, where a matching global rule already
 * exists (`.btn`, `.field`, `.notice`, `.table`, `.text-danger`), reusing it
 * rather than inventing a parallel system. Replace only repeated generic
 * dashboard primitives (cards, one-off fields/buttons, ad-hoc borders) —
 * do not force every admin page onto these just to remove Tailwind.
 */

// ── Page / section structure ────────────────────────────────────────────

export function AdminPage({
  title,
  description,
  actions,
  children,
}: {
  title: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  children?: ReactNode;
}) {
  return (
    <div>
      <div className="mb-6 flex flex-wrap items-baseline justify-between gap-x-4 gap-y-2">
        <div>
          <h1 className="text-xl font-semibold text-fg">{title}</h1>
          {description ? <p className="mt-1 text-xs text-fg-3">{description}</p> : null}
        </div>
        {actions}
      </div>
      {children}
    </div>
  );
}

/** A labeled group of content, ruled off like the rest of Arcana rather than boxed in a card. */
export function AdminSection({
  label,
  action,
  className,
  children,
}: {
  label?: ReactNode;
  action?: ReactNode;
  className?: string;
  children: ReactNode;
}) {
  return (
    <section className={`mb-8 ${className ?? ""}`}>
      {label || action ? (
        <div className="mb-2 flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 border-b border-border pb-1">
          {label ? <h2 className="font-mono text-xs uppercase tracking-wide text-fg-3">{label}</h2> : <span />}
          {action}
        </div>
      ) : null}
      {children}
    </section>
  );
}

// ── Metrics ──────────────────────────────────────────────────────────────

/** Thin-border metric cell (no shadow/giant radius) for dashboard-style counts. */
export function AdminMetric({ label, value }: { label: string; value: number | string }) {
  return (
    <div className="rounded-sm border border-border bg-bg-alt px-4 py-3">
      <div className="font-mono text-2xl font-semibold tabular-nums text-fg">{value}</div>
      <div className="mt-1 text-xs text-fg-3">{label}</div>
    </div>
  );
}

export function AdminMetricGrid({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={`grid grid-cols-2 gap-3 md:grid-cols-4 ${className ?? ""}`}>{children}</div>;
}

/** One large bordered value+label cell for the prominent top-of-page metric row. */
export function AdminMetricLarge({ label, value }: { label: string; value: number | string }) {
  return (
    <div className="admin-metric">
      <p className="admin-metric__value">{value}</p>
      <p className="admin-metric__label">{label}</p>
    </div>
  );
}

/**
 * The 4-5 numbers that matter most (accounts, live subscriptions, device
 * capacity, nodes online, …) at higher visual weight than everything else
 * on the page — a bordered strip, not one more card in an equal-weight
 * grid. Everything that isn't headline-worthy belongs in an AdminSection
 * below instead of here.
 */
export function AdminMetricRow({ children, count }: { children: ReactNode; count?: 4 | 5 }) {
  return <div className={`admin-metrics ${count === 5 ? "admin-metrics--5" : ""}`.trim()}>{children}</div>;
}

// ── Form controls ────────────────────────────────────────────────────────

/** Dense admin input: `.admin-input` (see the Admin block at the end of globals.css). */
export const adminInputClass = "admin-input";
/** Dense admin select, same visual treatment plus the shared dropdown affordance. */
export const adminSelectClass = "admin-select";

export function AdminField({
  label,
  htmlFor,
  hint,
  className,
  children,
  ...rest
}: {
  label: ReactNode;
  hint?: ReactNode;
  children: ReactNode;
} & LabelHTMLAttributes<HTMLLabelElement>) {
  return (
    <label htmlFor={htmlFor} className={`block text-xs ${className ?? ""}`} {...rest}>
      <span className="admin-label">{label}</span>
      {children}
      {hint ? <span className="mt-1 block text-fg-3">{hint}</span> : null}
    </label>
  );
}

// ── Buttons ──────────────────────────────────────────────────────────────

type AdminButtonVariant = "primary" | "secondary" | "danger" | "link";

const VARIANT_CLASS: Record<AdminButtonVariant, string> = {
  primary: "btn btn-primary",
  secondary: "btn btn-secondary",
  danger: "btn btn-danger",
  link: "btn-link",
};

/** Reuses the site-wide `.btn`/`.btn-danger`/`.btn-link` rules; `size="sm"` adds `.btn-sm` for dense rows. */
export function AdminButton({
  variant = "secondary",
  size = "sm",
  className,
  ...props
}: {
  variant?: AdminButtonVariant;
  size?: "sm" | "md";
} & ButtonHTMLAttributes<HTMLButtonElement>) {
  const sizeClass = variant !== "link" && size === "sm" ? "btn-sm" : "";
  return <button className={`${VARIANT_CLASS[variant]} ${sizeClass} ${className ?? ""}`.trim()} {...props} />;
}

// ── Tables ───────────────────────────────────────────────────────────────

/**
 * Scrollable frame around a dense operational table. Horizontal scroll is
 * fine (admin needs density, not artificial whitespace) but it must stay
 * discoverable: a visible border plus a keyboard-focusable scroll region,
 * not a silently clipped table.
 */
export function AdminTableWrap({ children, label }: { children: ReactNode; label?: string }) {
  return (
    <div
      className="table-wrap rounded-sm border border-border"
      role="region"
      aria-label={label ?? "Table, scroll horizontally for more columns"}
      tabIndex={0}
    >
      {children}
    </div>
  );
}

/** Reuses the shared `.table` rule (mono uppercase headers, thin rules, `.num` for right-aligned figures). */
export function AdminTable({ className, ...props }: TableHTMLAttributes<HTMLTableElement>) {
  return <table className={`table ${className ?? ""}`.trim()} {...props} />;
}

// ── Notices ──────────────────────────────────────────────────────────────

/** Reuses the shared `.notice`/`.notice--error` rule instead of ad-hoc colored boxes. */
export function AdminNotice({
  tone = "default",
  children,
}: {
  tone?: "default" | "error";
  children: ReactNode;
}) {
  return (
    <p className={`notice ${tone === "error" ? "notice--error" : ""}`.trim()} role={tone === "error" ? "alert" : "status"}>
      {children}
    </p>
  );
}

// ── Status ───────────────────────────────────────────────────────────────

// StatusBadge already implements the Arcana monochrome status-label pattern
// (weight/fill/outline only, never hue) — re-exported here so admin pages
// have one import surface for the primitives layer.
export { StatusBadge as AdminStatus } from "./StatusBadge";
