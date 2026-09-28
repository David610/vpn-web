// Resend's HTTP API via plain fetch — no SDK dependency, works
// identically under the Workers runtime. Sending is best-effort: a
// failure here must never fail the request that triggered it, since the
// job's status update (already committed by the caller) is the part
// that actually matters.

/**
 * Delivers a member invitation.
 *
 * acceptUrl carries the only copy of the plaintext invite token — the
 * database holds nothing but its SHA-256 hash — so it must never be logged.
 * The error paths below deliberately record status codes and Resend's own
 * response, never the URL that was sent.
 */
export async function sendMemberInvite(env, { to, inviterEmail, acceptUrl, expiresAt }) {
  if (!env.RESEND_API_KEY) {
    console.error("resend: RESEND_API_KEY not configured, cannot send member invite");
    return;
  }
  const expiresOn = new Date(expiresAt).toUTCString();
  const from = inviterEmail ? `${inviterEmail} has` : "You have been";
  try {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${env.RESEND_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from: env.ALERT_FROM_EMAIL || "onboarding@resend.dev",
        to,
        subject: "You have been invited to an Arcana VPN plan",
        text:
          `${from} invited you to join their Arcana VPN plan.\n\n` +
          `Accept the invitation:\n${acceptUrl}\n\n` +
          `This link expires on ${expiresOn}. If you were not expecting this, ignore this email.`,
      }),
    });
    if (!res.ok) {
      console.error("resend: failed to send member invite:", res.status, await res.text());
    }
  } catch (err) {
    console.error("resend: failed to send member invite:", err.message);
  }
}
// The agent supplies `error` (and, indirectly, `userId`) over an
// unauthenticated-content channel: it's the provisioning agent's own
// free-text failure message, not something we generated. Treating it as
// trusted enough to paste verbatim into an email body is how F-28 happened.
// Strip control/formatting characters (CRLF header injection, escape
// sequences) and cap the length so one runaway agent error can't turn into
// an oversized or malformed email.
function sanitizeForEmailBody(value, maxLength = 500) {
  if (typeof value !== "string") return "unknown";
  // eslint-disable-next-line no-control-regex
  const stripped = value.replace(/[\r\n\x00-\x08\x0b\x0c\x0e-\x1f]/g, " ").trim();
  if (!stripped) return "unknown";
  return stripped.length > maxLength ? `${stripped.slice(0, maxLength)}…` : stripped;
}

// User ids are opaque UUIDs already, but we still avoid putting the full
// value in a third-party alert email verbatim -- truncate to a prefix long
// enough to correlate against admin/audit logs without being the full
// identifier.
function truncateUserId(userId) {
  if (typeof userId !== "string" || !userId) return "unknown";
  return `${userId.slice(0, 8)}…`;
}

export async function sendFailureAlert(env, { jobId, jobType, userId, error }) {
  if (!env.RESEND_API_KEY) {
    console.error("resend: RESEND_API_KEY not configured, cannot send failure alert");
    return;
  }
  // F-28: no hard-coded personal fallback address. If the operator hasn't
  // configured where alerts go, fail closed (log only) rather than send
  // customer/user identifiers and raw agent error text to whoever happens
  // to be hard-coded into the source.
  const alertTo = env.ALERT_TO_EMAIL;
  if (!alertTo) {
    console.error("resend: ALERT_TO_EMAIL not configured, cannot send failure alert (job", jobId, ")");
    return;
  }
  try {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${env.RESEND_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from: env.ALERT_FROM_EMAIL || "onboarding@resend.dev",
        to: alertTo,
        subject: `Arcana provisioning job failed: ${sanitizeForEmailBody(jobType, 80)} (job ${jobId})`,
        text: `Job ${jobId} (${sanitizeForEmailBody(jobType, 80)}) failed.\nUser: ${truncateUserId(userId)}\nError: ${sanitizeForEmailBody(error)}`,
      }),
    });
    if (!res.ok) {
      console.error("resend: failed to send failure alert:", res.status, await res.text());
    }
  } catch (err) {
    console.error("resend: failed to send failure alert:", err.message);
  }
}
