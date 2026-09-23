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
export async function sendFailureAlert(env, { jobId, jobType, userId, error }) {
  if (!env.RESEND_API_KEY) {
    console.error("resend: RESEND_API_KEY not configured, cannot send failure alert");
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
        to: "platte-kantig.0o@icloud.com",
        subject: `Arcana provisioning job failed: ${jobType} (job ${jobId})`,
        text: `Job ${jobId} (${jobType}) failed.\nUser: ${userId ?? "unknown"}\nError: ${error}`,
      }),
    });
    if (!res.ok) {
      console.error("resend: failed to send failure alert:", res.status, await res.text());
    }
  } catch (err) {
    console.error("resend: failed to send failure alert:", err.message);
  }
}
