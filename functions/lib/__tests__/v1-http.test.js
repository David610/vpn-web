import { describe, it, expect } from "vitest";
import { fromService, sessionBody } from "../v1-http.js";

describe("fromService", () => {
  it("never answers 404 for a missing item (the app reads 404 as 'not offered')", async () => {
    const res = fromService({ status: 404, body: { error: "Device not found." } });
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ message: "Device not found." });
  });

  it("never answers 403 for a rejected action (the app reads 403 as signed out)", async () => {
    const res = fromService({ status: 403, body: { error: "That password is not correct." } });
    expect(res.status).toBe(422);
  });

  it("answers 204 on success", () => {
    expect(fromService({ status: 200, body: { ok: true } }).status).toBe(204);
  });
});

describe("sessionBody", () => {
  it("has the login contract's fields", () => {
    const body = sessionBody(
      { access_token: "a", refresh_token: "r", expires_at: 1893456000, user: { email: "x@y.z" } },
      "sess"
    );
    expect(body).toEqual({
      account: { email: "x@y.z" },
      device_session_id: "sess",
      access_token: "a",
      access_expires_at: "2030-01-01T00:00:00.000Z",
      refresh_token: "r",
    });
  });
});
