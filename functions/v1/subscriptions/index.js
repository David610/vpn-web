import { onRequestPost as createCheckout } from "../../api/create-checkout-session.js";
import { readV1Json, v1Error, v1Json } from "../../lib/v1-http.js";

/**
 * POST /v1/subscriptions — { name }. Payment continues on the website:
 * responds 201 { checkout_url }. The first subscription gets the one-time
 * trial when it is still available; later ones never do.
 */
export async function onRequestPost({ env, request }) {
  const { body, error } = await readV1Json(request);
  if (error) return error;
  const forward = new Request(request.url, {
    method: "POST",
    headers: { Authorization: request.headers.get("Authorization") ?? "", "Content-Type": "application/json" },
    body: JSON.stringify({ trial: false, name: body.name }),
  });
  const res = await createCheckout({ env, request: forward });
  const data = await res.json().catch(() => ({}));
  if (res.ok && typeof data.url === "string") return v1Json({ checkout_url: data.url }, 201);
  if (res.status === 401) return v1Json({ message: "Please log in again." }, 401);
  if (data.code === "reauth_required") {
    return v1Error(422, "For your security, log in again before subscribing.", "reauth_required");
  }
  if (res.status >= 500) return v1Error(503, "Arcana is temporarily unavailable.");
  return v1Error(res.status === 400 ? 400 : 409, data.error ?? "Could not start the payment.");
}
