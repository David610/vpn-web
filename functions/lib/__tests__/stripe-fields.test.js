import { describe, it, expect } from "vitest";
import {
  getInvoiceLinePeriodEnd,
  applyLegacyExpiryGrace,
  LEGACY_NODE_EXPIRY_GRACE_MS,
} from "../stripe-fields.js";

describe("getInvoiceLinePeriodEnd (F-19)", () => {
  const OLD_END = 1893000000; // an earlier period end
  const NEW_END = 1893456000; // 2030-01-01T00:00:00Z — the real new period end

  it("picks the single line's period end when there is only one line", () => {
    const invoice = { lines: { data: [{ period: { end: NEW_END } }] } };
    expect(getInvoiceLinePeriodEnd(invoice)).toBe(NEW_END);
  });

  it("a proration line first never shortens the resolved period end", () => {
    // Stripe does not guarantee line order. A combined invoice (proration +
    // renewal, e.g. a mid-cycle pack purchase or upgrade) can list the
    // proration line — whose period ends at the OLD period boundary — before
    // the renewal line. Reading position [0] would silently regress expiry.
    const invoice = {
      lines: {
        data: [
          { period: { end: OLD_END } }, // proration adjustment, old boundary
          { period: { end: NEW_END } }, // the actual renewal line
        ],
      },
    };
    expect(getInvoiceLinePeriodEnd(invoice)).toBe(NEW_END);
  });

  it("still resolves correctly when the renewal line happens to come first", () => {
    const invoice = {
      lines: {
        data: [{ period: { end: NEW_END } }, { period: { end: OLD_END } }],
      },
    };
    expect(getInvoiceLinePeriodEnd(invoice)).toBe(NEW_END);
  });

  it("falls back to invoice.period_end when no line carries a numeric period", () => {
    const invoice = { lines: { data: [{}] }, period_end: NEW_END };
    expect(getInvoiceLinePeriodEnd(invoice)).toBe(NEW_END);
  });

  it("returns null when nothing is discoverable", () => {
    expect(getInvoiceLinePeriodEnd({})).toBeNull();
  });
});

describe("applyLegacyExpiryGrace (F-19/C-04)", () => {
  it("adds exactly 72 hours", () => {
    expect(LEGACY_NODE_EXPIRY_GRACE_MS).toBe(72 * 60 * 60 * 1000);
    expect(applyLegacyExpiryGrace("2030-01-01T00:00:00.000Z")).toBe(
      "2030-01-04T00:00:00.000Z"
    );
  });

  it("passes through null/invalid input unchanged rather than throwing", () => {
    expect(applyLegacyExpiryGrace(null)).toBeNull();
    expect(applyLegacyExpiryGrace("not-a-date")).toBe("not-a-date");
  });
});
