import { describe, it, expect, vi, beforeEach } from "vitest";
import { sendFailureAlert } from "../resend.js";

describe("sendFailureAlert (F-28)", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    global.fetch = vi.fn().mockResolvedValue({ ok: true, text: () => Promise.resolve("") });
  });

  it("does not send, and does not hard-code a personal address, when ALERT_TO_EMAIL is unset", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    await sendFailureAlert(
      { RESEND_API_KEY: "key" },
      { jobId: "job-1", jobType: "CREATE_USER", userId: "user-1", error: "boom" }
    );
    expect(global.fetch).not.toHaveBeenCalled();
    expect(errorSpy).toHaveBeenCalled();
  });

  it("sends to the configured ALERT_TO_EMAIL", async () => {
    await sendFailureAlert(
      { RESEND_API_KEY: "key", ALERT_TO_EMAIL: "ops@example.com" },
      { jobId: "job-1", jobType: "CREATE_USER", userId: "user-1", error: "boom" }
    );
    expect(global.fetch).toHaveBeenCalledTimes(1);
    const body = JSON.parse(global.fetch.mock.calls[0][1].body);
    expect(body.to).toBe("ops@example.com");
    expect(body.to).not.toContain("icloud.com");
  });

  it("truncates the raw user id instead of including it verbatim", async () => {
    await sendFailureAlert(
      { RESEND_API_KEY: "key", ALERT_TO_EMAIL: "ops@example.com" },
      { jobId: "job-1", jobType: "CREATE_USER", userId: "11111111-2222-3333-4444-555555555555", error: "boom" }
    );
    const body = JSON.parse(global.fetch.mock.calls[0][1].body);
    expect(body.text).not.toContain("11111111-2222-3333-4444-555555555555");
    expect(body.text).toContain("11111111");
  });

  it("strips control characters and caps length in untrusted agent error text", async () => {
    const malicious = `boom\r\nBcc: attacker@evil.example\n${"x".repeat(1000)}`;
    await sendFailureAlert(
      { RESEND_API_KEY: "key", ALERT_TO_EMAIL: "ops@example.com" },
      { jobId: "job-1", jobType: "CREATE_USER", userId: "user-1", error: malicious }
    );
    const body = JSON.parse(global.fetch.mock.calls[0][1].body);
    expect(body.text).not.toContain("\r\n");
    expect(body.text).not.toContain("\n\nBcc:");
    expect(body.text.length).toBeLessThan(600);
  });
});
