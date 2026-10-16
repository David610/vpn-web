import { afterEach, describe, expect, it, vi } from "vitest";
import { decryptSecret, encryptSecret } from "../crypto.js";

const KEY_A = "00".repeat(32);
const KEY_B = "ff".repeat(32);

afterEach(() => vi.restoreAllMocks());

describe("AES key import cache", () => {
  it("imports a given key once however many secrets it handles", async () => {
    const spy = vi.spyOn(crypto.subtle, "importKey");
    const sealed = await Promise.all(Array.from({ length: 20 }, (_, i) => encryptSecret(`secret-${i}`, KEY_A)));
    for (const [i, { ciphertext, nonce }] of sealed.entries()) {
      expect(await decryptSecret(ciphertext, nonce, KEY_A)).toBe(`secret-${i}`);
    }
    expect(spy.mock.calls.filter(([, , alg]) => alg === "AES-GCM")).toHaveLength(1);
  });

  it("keeps different keys apart and still fails closed on a wrong key", async () => {
    const { ciphertext, nonce } = await encryptSecret("x", KEY_A);
    await expect(decryptSecret(ciphertext, nonce, KEY_B)).rejects.toBeDefined();
    expect(await decryptSecret(ciphertext, nonce, KEY_A)).toBe("x");
  });

  it("does not cache a failed import", async () => {
    await expect(encryptSecret("x", "not-hex")).rejects.toBeDefined();
    expect(await encryptSecret("x", KEY_B)).toHaveProperty("ciphertext");
  });
});
