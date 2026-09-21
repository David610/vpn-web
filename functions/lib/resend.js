// Resend's HTTP API via plain fetch — no SDK dependency, works
// identically under the Workers runtime. Sending is best-effort: a
// failure here must never fail the request that triggered it, since the
// job's status update (already committed by the caller) is the part
// that actually matters.
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
