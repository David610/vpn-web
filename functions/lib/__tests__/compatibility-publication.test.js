import { describe, expect, it } from "vitest";
import { selectCompatibilityPublication } from "../compatibility-publication.js";

const exitCred = { credential_id: "cred_A", hop: 1 };
const a = { node_id: "node-a", hop: 1, priority: 100 };
const b = { node_id: "node-b", hop: 1, priority: 10 };

describe("compatibility publication", () => {
  it("preserves priority publication in explicit legacy rollout mode", () => {
    const selected = selectCompatibilityPublication({
      credentials: [exitCred], targets: [b, a], proofs: [], mode: "legacy", privacyClass: "fast",
    });
    expect(selected.exitTarget.node_id).toBe("node-b");
    expect(selected.exitCredential).toBe(exitCred);
    expect(selected.entryCredential).toBeNull();
    expect(selected.entryTarget).toBeNull();
  });

  it("keeps acknowledged A while higher-priority healthy B is pending", () => {
    const selected = selectCompatibilityPublication({
      credentials: [exitCred], targets: [b, a], mode: "enforce", privacyClass: "fast",
      proofs: [{ node_id: "node-a", credential_id: "cred_A", required_revision: 4, applied_revision: 4 }],
    });
    expect(selected.exitTarget.node_id).toBe("node-a");
  });

  it("moves to B only after B's required revision is applied", () => {
    const selected = selectCompatibilityPublication({
      credentials: [exitCred], targets: [b, a], mode: "enforce", privacyClass: "fast",
      proofs: [
        { node_id: "node-a", credential_id: "cred_A", required_revision: 4, applied_revision: 5 },
        { node_id: "node-b", credential_id: "cred_A", required_revision: 6, applied_revision: 6 },
      ],
    });
    expect(selected.exitTarget.node_id).toBe("node-b");
  });

  it("does not silently downgrade Privacy+ to a Fast hop", () => {
    expect(selectCompatibilityPublication({ credentials: [exitCred], targets: [a], proofs: [
      { node_id: "node-a", credential_id: "cred_A" },
    ], mode: "enforce", privacyClass: "privacy_plus" })).toBeNull();
  });

  describe("privacy_plus (two independently-scoped credentials, one per hop)", () => {
    const entryCred = { credential_id: "cred_entry", hop: 1 };
    const exitCred2 = { credential_id: "cred_exit", hop: 2 };
    const entryTarget = { node_id: "node-entry", hop: 1, priority: 100 };
    const exitTarget = { node_id: "node-exit", hop: 2, priority: 100 };

    it("selects the entry credential for hop 1 and the exit credential for hop 2, never crossed", () => {
      const selected = selectCompatibilityPublication({
        credentials: [entryCred, exitCred2], targets: [entryTarget, exitTarget], mode: "legacy", privacyClass: "privacy_plus",
      });
      expect(selected.entryCredential).toBe(entryCred);
      expect(selected.exitCredential).toBe(exitCred2);
      expect(selected.entryTarget.node_id).toBe("node-entry");
      expect(selected.exitTarget.node_id).toBe("node-exit");
    });

    it("make-before-break applies independently per hop under enforce mode", () => {
      // Entry has rotated to a new node/credential and acknowledged; exit
      // has not yet acknowledged its own rotation and must stay on its
      // currently-live credential -- one hop's rollout never blocks or
      // leaks into the other's.
      const entryOld = { credential_id: "cred_entry_old", hop: 1 };
      const entryNew = { credential_id: "cred_entry_new", hop: 1 };
      const exitLive = { credential_id: "cred_exit_live", hop: 2 };
      const exitPending = { credential_id: "cred_exit_pending", hop: 2 };
      const entryOldTarget = { node_id: "node-entry-old", hop: 1, priority: 50 };
      const entryNewTarget = { node_id: "node-entry-new", hop: 1, priority: 10 };
      const exitTarget2 = { node_id: "node-exit", hop: 2, priority: 100 };
      const selected = selectCompatibilityPublication({
        credentials: [entryOld, entryNew, exitLive, exitPending],
        targets: [entryOldTarget, entryNewTarget, exitTarget2],
        mode: "enforce", privacyClass: "privacy_plus",
        proofs: [
          { node_id: "node-entry-new", credential_id: "cred_entry_new" },
          { node_id: "node-exit", credential_id: "cred_exit_live" },
        ],
      });
      expect(selected.entryCredential.credential_id).toBe("cred_entry_new");
      expect(selected.entryTarget.node_id).toBe("node-entry-new");
      expect(selected.exitCredential.credential_id).toBe("cred_exit_live");
      expect(selected.exitTarget.node_id).toBe("node-exit");
    });

    it("is null when the entry hop has no live credential even though the exit hop does", () => {
      expect(selectCompatibilityPublication({
        credentials: [exitCred2], targets: [entryTarget, exitTarget], mode: "legacy", privacyClass: "privacy_plus",
      })).toBeNull();
    });

    it("is null when the exit hop has no live credential even though the entry hop does", () => {
      expect(selectCompatibilityPublication({
        credentials: [entryCred], targets: [entryTarget, exitTarget], mode: "legacy", privacyClass: "privacy_plus",
      })).toBeNull();
    });
  });
});
