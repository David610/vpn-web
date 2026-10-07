import { describe, it, expect } from "vitest";
import { signInErrorMessage } from "../auth-errors";

describe("signInErrorMessage", () => {
  it("keeps credential failures generic so they cannot be used to enumerate accounts", () => {
    expect(signInErrorMessage({ status: 400, name: "AuthApiError", message: "Invalid login credentials" })).toBe(
      "Invalid email or password.",
    );
    expect(signInErrorMessage({ status: 400, name: "AuthApiError", message: "Email not confirmed" })).toBe(
      "Invalid email or password.",
    );
  });

  // Found on a real deployment built without Supabase settings: the browser
  // client could not reach any server, and the form told the user their
  // password was wrong.
  it("does not blame the password when the sign-in service cannot be reached", () => {
    const unreachable = "We can't reach the sign-in service right now. Check your connection and try again.";
    expect(signInErrorMessage({ status: 0, name: "AuthRetryableFetchError", message: "Failed to fetch" })).toBe(unreachable);
    expect(signInErrorMessage({ name: "AuthRetryableFetchError", message: "fetch failed" })).toBe(unreachable);
    expect(signInErrorMessage({ status: 502, name: "AuthApiError", message: "Bad gateway" })).toBe(unreachable);
    expect(signInErrorMessage({ status: 503, name: "AuthApiError", message: "unavailable" })).toBe(unreachable);
  });

  it("tells the user to wait when they are rate limited", () => {
    expect(signInErrorMessage({ status: 429, name: "AuthApiError", message: "over_request_rate_limit" })).toBe(
      "Too many attempts. Wait a moment and try again.",
    );
  });
});
