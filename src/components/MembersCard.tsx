"use client";

import { useCallback, useEffect, useState, type FormEvent } from "react";
import type { Session } from "@supabase/supabase-js";

type Member = {
  userId: string;
  email: string | null;
  role: string;
  joinedAt: string;
  isYou: boolean;
};

type Invite = {
  id: number;
  email: string;
  expiresAt: string;
  createdAt: string;
};

export export type AccountInfo = {
  accountId: string;
  role: string;
  subscription: { status: string; source?: "stripe" | "admin_grant" } | null;
  seats: { included: number; extra: number; limit: number; used: number; available: number };
  members: Member[];
  invites: Invite[];
};

const ROW: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  gap: "var(--space-3)",
  paddingBlock: "var(--space-3)",
  borderBottom: "1px solid var(--border-soft)",
};

/**
 * Seat management for the signed-in user's plan.
 *
 * Renders nothing until the account loads and nothing at all for an account
 * with no subscription — there are no seats to manage before there is
 * something to share. Members see the roster read-only; only the owner gets
 * the invite form and the remove controls, mirroring what the API enforces
 * rather than relying on the UI to be the gate.
 */
export function MembersCard({
  session,
  initialAccount,
}: {
  session: Session;
  initialAccount?: AccountInfo | null;
}) {
  const [account, setAccount] = useState<AccountInfo | null>(initialAccount ?? null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [email, setEmail] = useState("");
  const [inviting, setInviting] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/account", {
        headers: { Authorization: `Bearer ${session.access_token}` },
      });
      if (!res.ok) throw new Error("load failed");
      setAccount(await res.json());
      setLoadError(null);
    } catch {
      setLoadError("Could not load your plan members.");
    }
  }, [session.access_token]);

  useEffect(() => {
    if (!initialAccount) load();
  }, [initialAccount, load]);

  async function handleInvite(e: FormEvent) {
    e.preventDefault();
    setActionError(null);
    setNotice(null);
    setInviting(true);
    try {
      const res = await fetch("/api/account/invites", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${session.access_token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ email }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || "Could not send the invitation.");
      setNotice(`Invitation sent to ${data.invite.email}.`);
      setEmail("");
      await load();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : "Something went wrong.");
    } finally {
      setInviting(false);
    }
  }

  async function changeSeats(nextExtra: number) {
    if (!account) return;
    setActionError(null);
    setNotice(null);
    setBusyId("seats");
    try {
      const res = await fetch("/api/account/seats", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${session.access_token}`,
          "Content-Type": "application/json",
        },
        // Absolute, not a delta: a double-click sets the same total rather
        // than buying twice.
        body: JSON.stringify({ quantity: nextExtra }),
      });
      const data = await res.json().catch(() => ({}));
      if (res.status === 403 && data.code === "reauth_required") {
        window.location.href = "/login/?next=/dashboard/&reauth=1";
        return;
      }
      if (!res.ok) throw new Error(data.error || "Could not change your seats.");
      setNotice(
        nextExtra > account.seats.extra
          ? "Seat added. Your next invoice is prorated."
          : "Seat released. Your next invoice is prorated."
      );
      await load();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : "Something went wrong.");
    } finally {
      setBusyId(null);
    }
  }

  async function revokeInvite(invite: Invite) {
    setActionError(null);
    setNotice(null);
    setBusyId(`invite-${invite.id}`);
    try {
      const res = await fetch(`/api/account/invites/${invite.id}`, {
        method: "DELETE",
        headers: { Authorization: `Bearer ${session.access_token}` },
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || "Could not withdraw the invitation.");
      await load();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : "Something went wrong.");
    } finally {
      setBusyId(null);
    }
  }

  async function removeMember(member: Member) {
    const prompt = member.isYou
      ? "Leave this plan? You will lose VPN access immediately."
      : `Remove ${member.email ?? "this member"}? They will lose VPN access immediately.`;
    if (!window.confirm(prompt)) return;

    setActionError(null);
    setNotice(null);
    setBusyId(`member-${member.userId}`);
    try {
      const res = await fetch(`/api/account/members/${member.userId}`, {
        method: "DELETE",
        headers: { Authorization: `Bearer ${session.access_token}` },
      });
      const data = await res.json().catch(() => ({}));
      if (res.status === 403 && data.code === "reauth_required") {
        window.location.href = "/login/?next=/dashboard/&reauth=1";
        return;
      }
      if (!res.ok) throw new Error(data.error || "Could not remove that member.");
      if (member.isYou) {
        // They just left the plan their VPN config came from; the rest of
        // the dashboard is now stale.
        window.location.reload();
        return;
      }
      await load();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : "Something went wrong.");
    } finally {
      setBusyId(null);
    }
  }

  if (loadError) {
    return (
      <div className="dm-card" style={{ maxWidth: "26rem", marginTop: "var(--space-6)" }}>
        <div className="dm-card-header">
          <span className="dm-card-title">Plan members</span>
        </div>
        <div style={{ padding: "var(--space-6)" }}>
          <p className="field-error">{loadError}</p>
        </div>
      </div>
    );
  }

  // Nothing to manage before there is a plan to share.
  if (!account || !account.subscription) return null;

  const isOwner = account.role === "owner";
  const { seats } = account;

  return (
    <div className="dm-card" style={{ maxWidth: "26rem", marginTop: "var(--space-6)" }}>
      <div className="dm-card-header">
        <span className="dm-card-title">Plan members</span>
        <span className="tag">
          {seats.used} of {seats.limit} seats
        </span>
      </div>
      <div style={{ padding: "var(--space-6)" }}>
        <p className="section-sub">
          {account.subscription.source === "admin_grant"
            ? `Support access currently allows ${seats.limit} seats.`
            : `Your plan includes ${seats.included} seats${seats.extra > 0 ? `, plus ${seats.extra} paid extra seats` : ""}.`} Everyone on it
          gets their own VPN configuration.
        </p>

        <div style={{ marginTop: "var(--space-4)" }}>
          {account.members.map((m) => (
            <div key={m.userId} style={ROW}>
              <div style={{ minWidth: 0 }}>
                <p
                  className="text-tiny"
                  style={{
                    margin: 0,
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                    color: "var(--fg)",
                  }}
                >
                  {m.email ?? m.userId}
                </p>
                <span className="tag" style={{ marginTop: "var(--space-1)" }}>
                  {m.role === "owner" ? "Owner" : "Member"}
                  {m.isYou ? " · You" : ""}
                </span>
              </div>
              {/* The owner cannot be removed — an account with no owner has
                  nobody to bill — but a member can always leave. */}
              {m.role !== "owner" && (isOwner || m.isYou) && (
                <button
                  type="button"
                  className="btn btn-secondary"
                  disabled={busyId === `member-${m.userId}`}
                  onClick={() => removeMember(m)}
                >
                  {busyId === `member-${m.userId}`
                    ? "Removing…"
                    : m.isYou
                      ? "Leave"
                      : "Remove"}
                </button>
              )}
            </div>
          ))}

          {account.invites.map((i) => (
            <div key={i.id} style={ROW}>
              <div style={{ minWidth: 0 }}>
                <p
                  className="text-tiny"
                  style={{
                    margin: 0,
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                    color: "var(--fg-2)",
                  }}
                >
                  {i.email}
                </p>
                <span className="tag" style={{ marginTop: "var(--space-1)" }}>
                  Invited · expires {new Date(i.expiresAt).toLocaleDateString()}
                </span>
              </div>
              {isOwner && (
                <button
                  type="button"
                  className="btn btn-secondary"
                  disabled={busyId === `invite-${i.id}`}
                  onClick={() => revokeInvite(i)}
                >
                  {busyId === `invite-${i.id}` ? "Withdrawing…" : "Withdraw"}
                </button>
              )}
            </div>
          ))}
        </div>

        {isOwner && (
          <form onSubmit={handleInvite} style={{ marginTop: "var(--space-4)" }}>
            <label className="field-label" htmlFor="invite-email">
              Invite someone
            </label>
            <div style={{ display: "flex", gap: "var(--space-2)", alignItems: "center" }}>
              <input
                id="invite-email"
                type="email"
                required
                autoComplete="off"
                className="field"
                placeholder="name@example.com"
                style={{ flex: 1 }}
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                disabled={seats.available === 0}
                aria-invalid={actionError ? "true" : undefined}
              />
              <button
                type="submit"
                className="btn btn-primary"
                disabled={inviting || seats.available === 0}
              >
                {inviting ? "Sending…" : "Invite"}
              </button>
            </div>
            {seats.available === 0 && (
              <p className="text-tiny" style={{ marginTop: "var(--space-2)" }}>
                {account.subscription.source === "admin_grant"
                  ? "All granted seats are in use. Free one by removing a member or withdrawing an invitation."
                  : "All seats are in use. Add a seat below, or free one by removing a member or withdrawing an invitation."}
              </p>
            )}
          </form>
        )}

        {isOwner && account.subscription.source !== "admin_grant" && (
          <div
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              gap: "var(--space-3)",
              marginTop: "var(--space-4)",
              paddingTop: "var(--space-4)",
              borderTop: "1px solid var(--border-soft)",
            }}
          >
            <div>
              <p className="text-tiny" style={{ margin: 0, color: "var(--fg)" }}>
                Extra seats
              </p>
              <span className="tag" style={{ marginTop: "var(--space-1)" }}>
                {seats.extra} beyond the {seats.included} included
              </span>
            </div>
            <div style={{ display: "flex", gap: "var(--space-2)" }}>
              <button
                type="button"
                className="btn btn-secondary"
                disabled={busyId === "seats" || seats.extra === 0}
                onClick={() => changeSeats(seats.extra - 1)}
                aria-label="Release a seat"
              >
                −
              </button>
              <button
                type="button"
                className="btn btn-secondary"
                disabled={busyId === "seats"}
                onClick={() => changeSeats(seats.extra + 1)}
                aria-label="Add a seat"
              >
                +
              </button>
            </div>
          </div>
        )}

        {actionError && (
          <p className="field-error" style={{ marginTop: "var(--space-3)" }}>
            {actionError}
          </p>
        )}
        {notice && (
          <p className="text-tiny" style={{ marginTop: "var(--space-3)" }}>
            {notice}
          </p>
        )}
      </div>
    </div>
  );
}
