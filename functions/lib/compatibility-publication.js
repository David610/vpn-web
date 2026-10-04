/** Pure make-before-break selection over priority-ordered physical targets. */
export function selectCompatibilityPublication({ credentials, targets, proofs, mode, privacyClass }) {
  const neededHops = privacyClass === "privacy_plus" ? [1, 2] : [1];
  const byHop = new Map();
  for (const hop of neededHops) {
    const hopCredentials = credentials.filter((candidate) => candidate.hop === hop);
    const hopNodeIds = new Set(targets.filter((target) => target.hop === hop).map((target) => target.node_id));
    const credential = mode === "legacy" ? hopCredentials[0] : hopCredentials.find((candidate) =>
      proofs.some((proof) => proof.credential_id === candidate.credential_id && hopNodeIds.has(proof.node_id)));
    if (!credential) return null;
    const liveNodes = mode === "legacy" ? hopNodeIds : new Set(proofs
      .filter((proof) => proof.credential_id === credential.credential_id).map((proof) => proof.node_id));
    const liveTarget = targets.find((target) => target.hop === hop && liveNodes.has(target.node_id));
    if (!liveTarget) return null;
    byHop.set(hop, { credential, target: liveTarget });
  }
  const exitHop = privacyClass === "privacy_plus" ? 2 : 1;
  return {
    exitCredential: byHop.get(exitHop).credential,
    exitTarget: byHop.get(exitHop).target,
    entryCredential: privacyClass === "privacy_plus" ? byHop.get(1).credential : null,
    entryTarget: privacyClass === "privacy_plus" ? byHop.get(1).target : null,
  };
}
