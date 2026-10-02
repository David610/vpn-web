import { describe, expect, it } from "vitest";
import { selectCompatibilityPublication } from "../compatibility-publication.js";

const credential = { credential_id: "cred_A" };
const a = { node_id: "node-a", hop: 1, priority: 100 };
const b = { node_id: "node-b", hop: 1, priority: 10 };

describe("compatibility publication", () => {
  it("preserves priority publication in explicit legacy rollout mode", () => {
    const selected = selectCompatibilityPublication({
      credentials: [credential], targets: [b, a], proofs: [], mode: "legacy", privacyClass: "fast",
    });
    expect(selected.exitTarget.node_id).toBe("node-b");
  });

  it("keeps acknowledged A while higher-priority healthy B is pending", () => {
    const selected = selectCompatibilityPublication({
      credentials: [credential], targets: [b, a], mode: "enforce", privacyClass: "fast",
      proofs: [{ node_id: "node-a", credential_id: "cred_A", required_revision: 4, applied_revision: 4 }],
    });
    expect(selected.exitTarget.node_id).toBe("node-a");
  });

  it("moves to B only after B's required revision is applied", () => {
    const selected = selectCompatibilityPublication({
      credentials: [credential], targets: [b, a], mode: "enforce", privacyClass: "fast",
      proofs: [
        { node_id: "node-a", credential_id: "cred_A", required_revision: 4, applied_revision: 5 },
        { node_id: "node-b", credential_id: "cred_A", required_revision: 6, applied_revision: 6 },
      ],
    });
    expect(selected.exitTarget.node_id).toBe("node-b");
  });

  it("does not silently downgrade Privacy+ to a Fast hop", () => {
    expect(selectCompatibilityPublication({ credentials: [credential], targets: [a], proofs: [
      { node_id: "node-a", credential_id: "cred_A" },
    ], mode: "enforce", privacyClass: "privacy_plus" })).toBeNull();
  });
});
