'use strict';
// app/tlog.js — the Transparency Log: turns the Ledger of Record's PRIVATE hash chain into a THIRD-PARTY-VERIFIABLE
// proof. Today `urfael audit --verify` re-walks the whole linear chain (only the owner can, and a machine could in
// principle rewrite history under a re-signed head). This module publishes a tiny signed CHECKPOINT — an RFC 6962
// Merkle root over the SAME ledger entries, signed by the seal.js ed25519 key in C2SP signed-note format — from which
// an auditor verifies "these N actions happened, in order, nothing deleted" WITHOUT seeing any contents:
//   • an INCLUSION proof shows one entry is in the log (revealing only that entry + opaque sibling hashes), and
//   • a CONSISTENCY proof shows an older checkpoint's tree is a PREFIX of a newer one (append-only: nothing deleted
//     or rewritten below it).
// This is the format Sigstore Rekor v2 adopted (C2SP tlog-tiles + signed-note). Zero-dep (node:crypto only), pure,
// fail-closed on the verify paths. Credits: RFC 6962 (Certificate Transparency) for the Merkle construction, and the
// C2SP tlog-tiles / signed-note specifications (CC-BY-4.0) for the checkpoint format.
const crypto = require('crypto');
const seal = require('./seal');
const { canonicalJSON } = require('./audit-chain'); // the SAME canonical bytes the chain commits to → leaves match

// RFC 6962 domain separation: a leaf is prefixed 0x00, an interior node 0x01. This keeps a leaf hash from ever
// colliding with an interior hash (a second-preimage defense that a plain concat tree lacks).
const LEAF_PREFIX = 0x00;
const NODE_PREFIX = 0x01;

function sha(...bufs) { const h = crypto.createHash('sha256'); for (const b of bufs) h.update(b); return h.digest(); }
// leaf hash = SHA-256(0x00 || leaf_data);  interior = SHA-256(0x01 || left || right)
function leafHashBytes(data) { return sha(Buffer.from([LEAF_PREFIX]), Buffer.isBuffer(data) ? data : Buffer.from(String(data))); }
function nodeHash(left, right) { return sha(Buffer.from([NODE_PREFIX]), left, right); }

// The RFC 6962 leaf DATA for a ledger entry is its canonical bytes — canonicalJSON(entry) — so anyone holding the
// entry recomputes the identical leaf regardless of on-disk JSON key order. Accepts a parsed object or a JSONL string.
function entryBytes(entry) {
  const obj = typeof entry === 'string' ? JSON.parse(entry) : entry;
  return Buffer.from(canonicalJSON(obj), 'utf8');
}
function entryLeafHash(entry) { return leafHashBytes(entryBytes(entry)); }
// Parse JSONL ledger lines into their leaf hashes (throws on bad JSON — callers verify the chain first / wrap it).
function leafHashesFromLines(lines) { return (lines || []).map((ln) => leafHashBytes(entryBytes(ln))); }

// largest power of two STRICTLY less than n (RFC 6962's split point k for n > 1).
function splitPoint(n) { let k = 1; while (k * 2 < n) k <<= 1; return k; }
function isPowerOfTwo(n) { return n > 0 && (n & (n - 1)) === 0; }
function eq(a, b) { return Buffer.isBuffer(a) && Buffer.isBuffer(b) && a.length === b.length && crypto.timingSafeEqual(a, b); }

// RFC 6962 §2.1  Merkle Tree Hash (MTH) over an array of precomputed LEAF HASHES.
//   MTH({})    = SHA-256("")              (the empty tree)
//   MTH(d[0])  = the single leaf hash
//   MTH(D[n])  = SHA-256(0x01 || MTH(D[0:k]) || MTH(D[k:n])),  k = split point
function rootFromLeafHashes(leafHashes) {
  const n = leafHashes.length;
  if (n === 0) return sha(Buffer.alloc(0));
  if (n === 1) return leafHashes[0];
  const k = splitPoint(n);
  return nodeHash(rootFromLeafHashes(leafHashes.slice(0, k)), rootFromLeafHashes(leafHashes.slice(k)));
}
// convenience: MTH over raw leaf DATA buffers (used by the RFC vector tests).
function mthOfData(dataArray) { return rootFromLeafHashes((dataArray || []).map(leafHashBytes)); }

// RFC 6962 §2.1.1  the audit PATH for leaf index m in a tree of `leafHashes.length` leaves: the sibling hashes from
// the leaf up to the root, ordered leaf→root. Returns an array of 32-byte Buffers.
function inclusionPath(leafHashes, m) {
  const n = leafHashes.length;
  if (!Number.isInteger(m) || m < 0 || m >= n) throw new RangeError('leaf index ' + m + ' out of range for size ' + n);
  if (n === 1) return [];
  const k = splitPoint(n);
  if (m < k) return inclusionPath(leafHashes.slice(0, k), m).concat([rootFromLeafHashes(leafHashes.slice(k))]);
  return inclusionPath(leafHashes.slice(k), m - k).concat([rootFromLeafHashes(leafHashes.slice(0, k))]);
}

// RFC 9162 §2.1.3.2  recompute the tree root from (leaf hash, index, tree size, audit path). A verifier compares the
// result to the signed checkpoint's root. Returns the recomputed root Buffer, or null on a malformed proof (fail-closed).
function rootFromInclusion(leafHash, m, n, path) {
  if (!Buffer.isBuffer(leafHash) || !Number.isInteger(m) || !Number.isInteger(n) || m < 0 || m >= n || !Array.isArray(path)) return null;
  let fn = m, sn = n - 1;
  let r = leafHash;
  for (const p of path) {
    if (!Buffer.isBuffer(p) || sn === 0) return null; // a bad node, or a path longer than the tree can justify
    if ((fn & 1) === 1 || fn === sn) {
      r = nodeHash(p, r);
      if ((fn & 1) === 0) { while ((fn & 1) === 0 && fn !== 0) { fn >>= 1; sn >>= 1; } }
    } else {
      r = nodeHash(r, p);
    }
    fn >>= 1; sn >>= 1;
  }
  return sn === 0 ? r : null; // sn must be exhausted: too-short a path leaves sn > 0 and is rejected
}
function verifyInclusion(leafHash, m, n, path, root) {
  const r = rootFromInclusion(leafHash, m, n, path);
  return !!r && eq(r, root);
}

// RFC 6962 §2.1.2  the CONSISTENCY proof that the size-`first` tree is a prefix of the size-`n` tree (append-only).
// PROOF(m, D[n]) = SUBPROOF(m, D[n], true).  Returns an array of 32-byte sibling/subtree hashes.
function consistencySubproof(m, leafHashes, b) {
  const n = leafHashes.length;
  if (m === n) return b ? [] : [rootFromLeafHashes(leafHashes)];
  const k = splitPoint(n);
  if (m <= k) return consistencySubproof(m, leafHashes.slice(0, k), b).concat([rootFromLeafHashes(leafHashes.slice(k))]);
  return consistencySubproof(m - k, leafHashes.slice(k), false).concat([rootFromLeafHashes(leafHashes.slice(0, k))]);
}
function consistencyProof(leafHashes, first) {
  const n = leafHashes.length;
  if (!Number.isInteger(first) || first <= 0 || first > n) throw new RangeError('first ' + first + ' out of range for size ' + n);
  if (first === n) return []; // identical trees — nothing to prove
  return consistencySubproof(first, leafHashes, true);
}

// RFC 9162 §2.1.4.2  verify a consistency proof between the size-`first` and size-`second` trees given both roots.
// Fail-closed: any structural mismatch (a deleted/reordered/rewritten entry below `first`) returns false.
function verifyConsistency(first, second, path, firstRoot, secondRoot) {
  if (!Number.isInteger(first) || !Number.isInteger(second) || first <= 0 || second <= 0 || first > second) return false;
  if (!Array.isArray(path) || !Buffer.isBuffer(firstRoot) || !Buffer.isBuffer(secondRoot)) return false;
  if (first === second) return path.length === 0 && eq(firstRoot, secondRoot);
  // §2.1.4.2 step 1: when `first` is an exact power of two the old root is not carried in the proof — prepend it.
  const proof = isPowerOfTwo(first) ? [firstRoot].concat(path) : path.slice();
  if (proof.length === 0 || !proof.every(Buffer.isBuffer)) return false;
  let fn = first - 1, sn = second - 1;
  while (fn & 1) { fn >>= 1; sn >>= 1; } // step 3
  let fr = proof[0], sr = proof[0];      // step 4
  for (let i = 1; i < proof.length; i++) {
    const c = proof[i];
    if (sn === 0) return false;          // step 5a
    if ((fn & 1) === 1 || fn === sn) {
      fr = nodeHash(c, fr);
      sr = nodeHash(c, sr);
      if ((fn & 1) === 0) { while ((fn & 1) === 0 && fn !== 0) { fn >>= 1; sn >>= 1; } }
    } else {
      sr = nodeHash(sr, c);
    }
    fn >>= 1; sn >>= 1;                   // step 5c
  }
  return sn === 0 && eq(fr, firstRoot) && eq(sr, secondRoot); // step 6
}

// ── C2SP signed-note CHECKPOINT ────────────────────────────────────────────────────────────────────────────────
// The checkpoint BODY (the signed-note message) per C2SP tlog-tiles/checkpoint:
//   <origin>\n<tree-size>\n<base64(root-hash)>\n
// The note is: message text, a blank line, then one or more signature lines "— <key-name> <base64(signature)>".
const EM_DASH = '—'; // U+2014 EM DASH, the signature-line marker mandated by the signed-note format
function checkpointBody(origin, treeSize, rootBuf) {
  return String(origin) + '\n' + String(treeSize) + '\n' + rootBuf.toString('base64') + '\n';
}
// sign the checkpoint with the seal ed25519 private key (reuses seal.sign → base64 of the raw ed25519 signature).
function signCheckpoint(origin, treeSize, rootBuf, privatePem, keyName) {
  const body = checkpointBody(origin, treeSize, rootBuf);
  const sig = seal.sign(privatePem, body);
  return { note: body + '\n' + EM_DASH + ' ' + keyName + ' ' + sig + '\n', body, sig, keyName };
}
// build a checkpoint straight from an array of leaf hashes (the whole flow the daemon runs over the verified ledger).
function checkpointFromLeafHashes(leafHashes, origin, privatePem, keyName) {
  const root = rootFromLeafHashes(leafHashes);
  return { ...signCheckpoint(origin, leafHashes.length, root, privatePem, keyName), root, treeSize: leafHashes.length, origin };
}
// parse a signed-note checkpoint back into {origin, treeSize, root(b64), rootBuf, body, sigs:[{name,sig}]}. null if malformed.
function parseCheckpoint(note) {
  if (typeof note !== 'string') return null;
  const sep = note.indexOf('\n\n');                        // the blank line between the message and the signatures
  if (sep < 0) return null;
  const body = note.slice(0, sep + 1);                     // message text, including the newline that ends its last line
  const sigBlock = note.slice(sep + 2);
  const bl = body.split('\n');                             // [origin, treeSize, base64root, '']
  if (bl.length < 4 || bl[0] === '' || bl[1] === '' || bl[2] === '') return null;
  if (!/^\d+$/.test(bl[1])) return null;
  const treeSize = Number(bl[1]);
  if (!Number.isSafeInteger(treeSize)) return null;
  let rootBuf; try { rootBuf = Buffer.from(bl[2], 'base64'); } catch { return null; }
  if (rootBuf.length !== 32) return null;
  const sigs = [];
  for (const ln of sigBlock.split('\n')) {
    if (!ln) continue;
    const m = ln.match(/^— (\S+) (\S+)$/);            // "— <name> <base64sig>"
    if (m) sigs.push({ name: m[1], sig: m[2] });
  }
  return { origin: bl[0], treeSize, root: bl[2], rootBuf, body, sigs };
}
// verify a checkpoint's signature against a published ed25519 public key. Fail-closed (never throws).
function verifyCheckpoint(note, publicPem) {
  const cp = parseCheckpoint(note);
  if (!cp) return { ok: false, reason: 'malformed' };
  if (!cp.sigs.length) return { ok: false, reason: 'unsigned', origin: cp.origin, treeSize: cp.treeSize, root: cp.root };
  const ok = cp.sigs.some((s) => seal.verify(publicPem, cp.body, s.sig));
  return { ok, reason: ok ? 'valid' : 'bad_signature', origin: cp.origin, treeSize: cp.treeSize, root: cp.root, rootBuf: cp.rootBuf };
}

// ── proof bundles (what `urfael attest prove` emits and `urfael attest verify` checks) ───────────────────────────
// A self-contained inclusion-proof bundle for a single entry: it reveals ONLY that entry + the opaque sibling hashes,
// never the rest of the log. `publicKey` is a convenience copy; a real auditor trusts the git-published seal.pub, not
// the key embedded in the proof (a proof could embed any key — the verifier compares against the known one).
function buildInclusionBundle(lines, seqIndex, origin, keys) {
  const leaves = leafHashesFromLines(lines);
  const n = leaves.length;
  if (!Number.isInteger(seqIndex) || seqIndex < 0 || seqIndex >= n) return { ok: false, reason: 'index_out_of_range', size: n };
  const cp = checkpointFromLeafHashes(leaves, origin, keys.privatePem, keys.keyName);
  const path = inclusionPath(leaves, seqIndex);
  return {
    ok: true,
    kind: 'urfael-tlog-inclusion',
    origin,
    checkpoint: cp.note,
    treeSize: n,
    leafIndex: seqIndex,
    entry: typeof lines[seqIndex] === 'string' ? JSON.parse(lines[seqIndex]) : lines[seqIndex], // the ONE revealed entry
    leafHash: leaves[seqIndex].toString('base64'),
    path: path.map((p) => p.toString('base64')),
    publicKey: keys.publicPem,
    keyFingerprint: seal.fingerprint(keys.publicPem),
  };
}
// verify an inclusion bundle offline: (1) the checkpoint signature under `publicPem`, (2) the leaf hash recomputed
// from the revealed entry matches the bundle's leafHash, (3) the audit path recomputes the checkpoint's signed root.
function verifyInclusionBundle(bundle, publicPem) {
  const out = { ok: false, sigOk: false, leafOk: false, rootOk: false };
  if (!bundle || bundle.kind !== 'urfael-tlog-inclusion') { out.reason = 'not_an_inclusion_bundle'; return out; }
  const pub = publicPem || bundle.publicKey;
  if (!pub) { out.reason = 'no_public_key'; return out; }
  const cpv = verifyCheckpoint(bundle.checkpoint, pub);
  out.sigOk = cpv.ok; out.origin = cpv.origin; out.treeSize = cpv.treeSize;
  if (!cpv.ok) { out.reason = 'checkpoint_' + cpv.reason; return out; }
  if (cpv.treeSize !== bundle.treeSize) { out.reason = 'size_mismatch'; return out; }
  let leaf;
  try { leaf = entryLeafHash(bundle.entry); } catch { out.reason = 'bad_entry'; return out; }
  out.leafOk = leaf.toString('base64') === bundle.leafHash;               // the revealed entry really is this leaf
  if (!out.leafOk) { out.reason = 'leaf_mismatch'; return out; }
  let path; try { path = (bundle.path || []).map((s) => Buffer.from(s, 'base64')); } catch { out.reason = 'bad_path'; return out; }
  out.rootOk = verifyInclusion(leaf, bundle.leafIndex, bundle.treeSize, path, cpv.rootBuf); // recompute → signed root
  out.reason = out.rootOk ? 'valid' : 'root_mismatch';
  out.ok = out.sigOk && out.leafOk && out.rootOk;
  return out;
}

module.exports = {
  LEAF_PREFIX, NODE_PREFIX, sha, leafHashBytes, nodeHash, entryBytes, entryLeafHash, leafHashesFromLines,
  splitPoint, isPowerOfTwo, rootFromLeafHashes, mthOfData,
  inclusionPath, rootFromInclusion, verifyInclusion,
  consistencyProof, verifyConsistency,
  checkpointBody, signCheckpoint, checkpointFromLeafHashes, parseCheckpoint, verifyCheckpoint,
  buildInclusionBundle, verifyInclusionBundle,
};
