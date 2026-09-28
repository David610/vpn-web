import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { passwordGrant, refreshGrant, signUp } from "../gotrue.js";

const env = {
  SUPABASE_URL: "https://supabase.test",
  SUPABASE_ANON_KEY: "anon-key",
  SUPABASE_SERVICE_ROLE_KEY: "service-role-key",
};

beforeEach(() => {
  vi.spyOn(console, "error").mockImplementation(() => {});
  global.fetch = vi.fn(async () => ({
    ok: true,
    status: 200,
    json: async () => ({ access_token: "token" }),
  }));
});

afterEach(() => vi.restoreAllMocks());

describe("gotrue call()", () => {
  // F-27: env.SUPABASE_ANON_KEY ?? env.SUPABASE_SERVICE_ROLE_KEY used to hand
  // the privileged service-role key to GoTrue's public `apikey` header
  // whenever the anon key was missing/misconfigured. Public-facing auth
  // calls must fail closed instead.
  it("uses SUPABASE_ANON_KEY as the apikey header", async () => {
    await passwordGrant(env, "user@example.com", "hunter2-hunter2");
    const [, options] = global.fetch.mock.calls[0];
    expect(options.headers.apikey).toBe("anon-key");
  });

  it("throws instead of falling back to the service-role key when the anon key is missing", async () => {
    const badEnv = { ...env, SUPABASE_ANON_KEY: undefined };
    await expect(passwordGrant(badEnv, "user@example.com", "hunter2-hunter2")).rejects.toThrow(
      /SUPABASE_ANON_KEY/
    );
    await expect(refreshGrant(badEnv, "refresh-token")).rejects.toThrow(/SUPABASE_ANON_KEY/);
    await expect(signUp(badEnv, "user@example.com", "hunter2-hunter2")).rejects.toThrow(
      /SUPABASE_ANON_KEY/
    );
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it("never sends the service-role key as apikey even if both are set and anon is empty string", async () => {
    const badEnv = { ...env, SUPABASE_ANON_KEY: "" };
    await expect(passwordGrant(badEnv, "user@example.com", "hunter2-hunter2")).rejects.toThrow(
      /SUPABASE_ANON_KEY/
    );
  });
});
