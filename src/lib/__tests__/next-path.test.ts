import { describe, it, expect } from "vitest";
import { safeNextPath } from "../next-path";

describe("safeNextPath", () => {
  it("returns the fallback when no next is present", () => {
    expect(safeNextPath("")).toBe("/dashboard/");
    expect(safeNextPath("?other=1")).toBe("/dashboard/");
  });

  it("honours a same-origin path", () => {
    expect(safeNextPath("?next=%2Finvite%2F%3Ftoken%3Dabc")).toBe("/invite/?token=abc");
  });

  it.each([
    ["absolute URL", "?next=https%3A%2F%2Fevil.test"],
    ["protocol-relative", "?next=%2F%2Fevil.test"],
    ["backslash-relative", "?next=%2F%5Cevil.test"],
    ["scheme-relative with credentials", "?next=https%3A%2F%2Fuser%40evil.test"],
    ["javascript scheme", "?next=javascript%3Aalert(1)"],
    ["bare host", "?next=evil.test"],
  ])("refuses %s", (_label, search) => {
    // A redirect right after a successful login is the moment a user is most
    // likely to trust whatever appears next, so anything off-origin must
    // fall back rather than be followed.
    expect(safeNextPath(search)).toBe("/dashboard/");
  });

  it("accepts a caller-supplied fallback", () => {
    expect(safeNextPath("?next=https%3A%2F%2Fevil.test", "/")).toBe("/");
  });

  // F-14: control characters and their encoded forms get collapsed by URL
  // parsers into protocol-relative redirects. Each of these must fall back.
  it.each([
    ["raw tab before host", "?next=/%09/evil.test".replace("%09", "\t")],
    ["raw newline before host", "?next=/%0a/evil.test".replace("%0a", "\n")],
    ["encoded tab", "?next=%2F%09%2Fevil.test"],
    ["encoded tab (percent-09)", "?next=%2F%2Fevil.test%09"],
    ["tab-then-slashes bypass", "?next=/\t/evil.test"],
    ["double slash", "?next=//evil.test"],
    ["backslash-escaped double slash", "?next=/\\evil.test"],
    ["percent-encoded tab then encoded slash", "?next=%09%2Fevil.test"],
    ["double-encoded protocol-relative", "?next=/%2F%2Fevil.test"],
    ["encoded backslash", "?next=%2F%5Cevil.test"],
  ])("refuses control-character bypass: %s", (_label, search) => {
    expect(safeNextPath(search)).toBe("/dashboard/");
  });
});
