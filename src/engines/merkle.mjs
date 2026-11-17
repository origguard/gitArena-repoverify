import { createHash } from 'node:crypto';
import { canonicalJson } from './evidence.mjs';

/**
 * Arbre de Merkle SHA-256 à séparation de domaine — Runbook II §10
 * 0x00 préfixe les feuilles, 0x01 préfixe les nœuds internes (anti-confusion feuille/nœud).
 * 100 % Natif Node.js ESM.
 */

const sha256Hex = data => createHash('sha256').update(data, 'utf8').digest('hex');

export function leafHash(leafObj) {
  return sha256Hex(`\x00${canonicalJson(leafObj)}`);
}

export function nodeHash(leftHex, rightHex) {
  return sha256Hex(`\x01${leftHex}${rightHex}`);
}

export function buildTree(leaves) {
  if (!Array.isArray(leaves) || leaves.length === 0) {
    return { levels: [], root: null };
  }
  let level = leaves.map(leafHash);
  const levels = [level];
  while (level.length > 1) {
    const next = [];
    for (let i = 0; i < level.length; i += 2) {
      const l = level[i];
      const r = level[i + 1] ?? level[i];
      next.push(nodeHash(l, r));
    }
    levels.push(next);
    level = next;
  }
  return { levels, root: level[0] };
}

export function inclusionProof(levels, index) {
  if (!Array.isArray(levels) || levels.length === 0 || index < 0 || index >= levels[0].length) {
    return [];
  }
  const path = [];
  let cursor = index;
  for (let d = 0; d < levels.length - 1; d++) {
    const sib = cursor ^ 1;
    path.push({
      dir: cursor % 2 === 0 ? 'R' : 'L',
      hash: levels[d][sib] ?? levels[d][cursor]
    });
    cursor >>= 1;
  }
  return path;
}

export function verifyProof(leafObj, path, claimedRoot) {
  if (!claimedRoot || !Array.isArray(path)) {
    return { valid: false, recomputed: null };
  }
  let h = leafHash(leafObj);
  for (const step of path) {
    if (!step || !step.hash || (step.dir !== 'R' && step.dir !== 'L')) {
      return { valid: false, recomputed: null };
    }
    h = step.dir === 'R' ? nodeHash(h, step.hash) : nodeHash(step.hash, h);
  }
  return { valid: h === claimedRoot, recomputed: h };
}
