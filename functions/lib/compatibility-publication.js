/** Pure make-before-break selection over priority-ordered physical targets. */
export function selectCompatibilityPublication({ credentials, targets, proofs, mode, privacyClass }) {
  const exitHop = privacyClass === "privacy_plus" ? 2 : 1;
  const exitNodeIds = new Set(targets.filter((target) => target.hop === exitHop).map((target) => target.node_id));
  const credential = mode === "legacy" ? credentials[0] : credentials.find((candidate) => proofs.some((proof) =>
    proof.credential_id === candidate.credential_id && exitNodeIds.has(proof.node_id)));
  if (!credential) return null;
  const liveNodes = mode === "legacy" ? new Set(targets.map((target) => target.node_id)) : new Set(proofs
    .filter((proof) => proof.credential_id === credential.credential_id).map((proof) => proof.node_id));
  const liveTargets = targets.filter((target) => liveNodes.has(target.node_id));
  const exitTarget = liveTargets.find((target) => target.hop === exitHop);
  if (!exitTarget) return null;
  return { credential, liveTargets, exitTarget };
}
