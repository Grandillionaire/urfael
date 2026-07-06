'use strict';
// Transparency-log tests. This is cryptographic code, so the bar is: every inclusion proof recomputes the SIGNED
// root for EVERY entry, consistency holds across a growing log, and every tamper (mutated entry, deleted/reordered
// entry, forged signature) is provably detected. RFC-6962 vectors are pinned against externally-known SHA-256 values.
const { test } = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');
const tlog = require('../tlog');
const chain = require('../audit-chain');
const seal = require('../seal');

// ── helpers ─────────────────────────────────────────────────────────────────────────────────────────────────────
// a real Ledger-of-Record chain of N entries, exactly as daemon.appendChain writes them, as JSONL strings.
function buildLedger(n) {
  const lines = []; let prevH = chain.GENESIS;
  for (let i = 0; i < n; i++) {
    const e = chain.makeEntry({ seq: i, t: '2026-07-06T00:00:0' + (i % 10), kind: 'turn', payload: { i, model: 'sonnet', in: i * 3, out: i * 7 } }, prevH);
    lines.push(JSON.stringify(e)); prevH = e.h;
  }
  return lines;
}
const KP = seal.generateKeypair();
const KEYS = { privatePem: KP.privatePem, publicPem: KP.publicPem, keyName: 'urfael-seal-' + seal.fingerprint(KP.publicPem) };
const ORIGIN = 'urfael-ledger-test';
const rootHex = (leaves) => tlog.rootFromLeafHashes(leaves).toString('hex');

// ── RFC 6962 vector sanity ──────────────────────────────────────────────────────────────────────────────────────
test('tlog: empty tree hashes to SHA-256("") (the RFC 6962 empty-tree value)', () => {
  assert.equal(tlog.rootFromLeafHashes([]).toString('hex'), 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
});

test('tlog: a single leaf is SHA-256(0x00 || data) — an empty leaf is SHA-256(0x00)', () => {
  assert.equal(tlog.leafHashBytes(Buffer.alloc(0)).toString('hex'), '6e340b9cffb37a989ca544e6bb780a2c78901d3fb33738768511a30617afa01d');
  // MTH of one leaf == that leaf's hash (no interior node)
  const one = tlog.leafHashBytes(Buffer.from('a'));
  assert.equal(tlog.rootFromLeafHashes([one]).toString('hex'), one.toString('hex'));
  assert.equal(tlog.mthOfData([Buffer.from('a')]).toString('hex'), one.toString('hex'));
});

test('tlog: a known small tree is stable AND matches manual node composition (independent of the tree code)', () => {
  const [a, b, c, d] = ['a', 'b', 'c', 'd'].map((x) => Buffer.from(x));
  // pinned regression vectors (computed independently); the split point for n=3 is 2 → ((a,b),c)
  assert.equal(tlog.mthOfData([a, b, c]).toString('hex'), '36642e73c2540ab121e3a6bf9545b0a24982cd830eb13d3cd19de3ce6c021ec1');
  assert.equal(tlog.mthOfData([a, b, c, d]).toString('hex'), '33376a3bd63e9993708a84ddfe6c28ae58b83505dd1fed711bd924ec5a6239f0');
  // manual composition using the raw prefixes, no tlog tree helper involved
  const sha = (...bufs) => { const h = crypto.createHash('sha256'); for (const x of bufs) h.update(x); return h.digest(); };
  const lf = (x) => sha(Buffer.from([0x00]), x), nd = (l, r) => sha(Buffer.from([0x01]), l, r);
  assert.equal(tlog.mthOfData([a, b, c]).toString('hex'), nd(nd(lf(a), lf(b)), lf(c)).toString('hex'));
  assert.equal(tlog.splitPoint(3), 2); assert.equal(tlog.splitPoint(4), 2); assert.equal(tlog.splitPoint(5), 4); assert.equal(tlog.splitPoint(2), 1);
});

test('tlog: a leaf hashes the SAME canonical bytes the audit chain commits to (key-order independent)', () => {
  const e1 = { seq: 0, t: 'T', kind: 'turn', payloadDigest: 'ab', prevH: '0', h: 'ff' };
  const e2 = { h: 'ff', prevH: '0', payloadDigest: 'ab', kind: 'turn', t: 'T', seq: 0 }; // same fields, shuffled
  assert.equal(tlog.entryLeafHash(e1).toString('hex'), tlog.entryLeafHash(e2).toString('hex'));
  assert.equal(tlog.entryLeafHash(e1).toString('hex'), tlog.leafHashBytes(Buffer.from(chain.canonicalJSON(e1))).toString('hex'));
  assert.equal(tlog.entryLeafHash(e1).toString('hex'), tlog.entryLeafHash(JSON.stringify(e2)).toString('hex')); // object or JSONL line → same leaf
});

// ── inclusion: EVERY entry, against the SIGNED checkpoint ────────────────────────────────────────────────────────
test('tlog: an inclusion proof recomputes the signed root for EVERY entry of a multi-entry log', () => {
  for (const n of [1, 2, 3, 5, 7, 8, 13]) {
    const lines = buildLedger(n);
    const leaves = tlog.leafHashesFromLines(lines);
    const cp = tlog.checkpointFromLeafHashes(leaves, ORIGIN, KEYS.privatePem, KEYS.keyName);
    const cpv = tlog.verifyCheckpoint(cp.note, KEYS.publicPem);
    assert.equal(cpv.ok, true, 'checkpoint self-verifies at n=' + n);
    assert.equal(cpv.treeSize, n);
    for (let m = 0; m < n; m++) {
      const path = tlog.inclusionPath(leaves, m);
      // (a) recompute against the raw root
      assert.equal(tlog.verifyInclusion(leaves[m], m, n, path, cp.root), true, 'entry ' + m + '/' + n + ' verifies against root');
      // (b) recompute against the root parsed out of the SIGNED checkpoint
      assert.ok(tlog.rootFromInclusion(leaves[m], m, n, path).equals(cpv.rootBuf), 'entry ' + m + '/' + n + ' → signed root');
      // (c) the full self-contained bundle verifies offline
      const bundle = tlog.buildInclusionBundle(lines, m, ORIGIN, KEYS);
      assert.equal(bundle.ok, true);
      const v = tlog.verifyInclusionBundle(bundle, KEYS.publicPem);
      assert.ok(v.ok && v.sigOk && v.leafOk && v.rootOk, 'bundle for entry ' + m + '/' + n + ' verifies (' + v.reason + ')');
      // and it verifies with NO key passed (uses the embedded published key)
      assert.equal(tlog.verifyInclusionBundle(bundle).ok, true);
    }
  }
});

test('tlog: a too-short or wrong-position inclusion path is rejected (fail-closed)', () => {
  const leaves = tlog.leafHashesFromLines(buildLedger(7));
  const root = tlog.rootFromLeafHashes(leaves);
  const path = tlog.inclusionPath(leaves, 3);
  assert.equal(tlog.verifyInclusion(leaves[3], 3, 7, path.slice(0, path.length - 1), root), false); // truncated path
  assert.equal(tlog.verifyInclusion(leaves[3], 4, 7, path, root), false);                            // wrong index
  assert.equal(tlog.rootFromInclusion(leaves[0], 5, 3, []), null);                                   // index >= size
  assert.throws(() => tlog.inclusionPath(leaves, 99));                                               // out-of-range generation
  assert.equal(tlog.buildInclusionBundle(buildLedger(3), 9, ORIGIN, KEYS).ok, false);                // out-of-range bundle
});

// ── consistency: append-only across a GROWING log ───────────────────────────────────────────────────────────────
test('tlog: a consistency proof holds between every pair of checkpoints of a growing log', () => {
  const N = 13;
  const full = tlog.leafHashesFromLines(buildLedger(N));
  for (let second = 1; second <= N; second++) {
    const bigLeaves = full.slice(0, second);
    const secondRoot = tlog.rootFromLeafHashes(bigLeaves);
    for (let first = 1; first <= second; first++) {
      const firstRoot = tlog.rootFromLeafHashes(full.slice(0, first));
      const proof = tlog.consistencyProof(bigLeaves, first);
      assert.equal(tlog.verifyConsistency(first, second, proof, firstRoot, secondRoot), true,
        'consistency ' + first + '→' + second + ' must hold');
    }
  }
});

test('tlog: two real checkpoints of the same growing ledger are provably append-only', () => {
  const linesA = buildLedger(4);
  const linesB = buildLedger(9); // a superset — the log only grew
  const leavesA = tlog.leafHashesFromLines(linesA), leavesB = tlog.leafHashesFromLines(linesB);
  const cpA = tlog.checkpointFromLeafHashes(leavesA, ORIGIN, KEYS.privatePem, KEYS.keyName);
  const cpB = tlog.checkpointFromLeafHashes(leavesB, ORIGIN, KEYS.privatePem, KEYS.keyName);
  assert.ok(tlog.verifyCheckpoint(cpA.note, KEYS.publicPem).ok && tlog.verifyCheckpoint(cpB.note, KEYS.publicPem).ok);
  const proof = tlog.consistencyProof(leavesB, cpA.treeSize);
  assert.equal(tlog.verifyConsistency(cpA.treeSize, cpB.treeSize, proof, cpA.root, cpB.root), true);
});

// ── TAMPER: a mutated entry fails its inclusion proof against the signed root ────────────────────────────────────
test('tlog: a TAMPERED entry (mutated payloadDigest) fails to reproduce the signed root', () => {
  const lines = buildLedger(6);
  const j = 2;
  const bundle = tlog.buildInclusionBundle(lines, j, ORIGIN, KEYS); // signed over the ORIGINAL tree
  assert.equal(tlog.verifyInclusionBundle(bundle, KEYS.publicPem).ok, true);
  // an auditor is handed the same signed checkpoint + path but the entry's content was changed
  const tampered = { ...bundle, entry: { ...bundle.entry, payloadDigest: 'deadbeef' + String(bundle.entry.payloadDigest).slice(8) } };
  const v1 = tlog.verifyInclusionBundle(tampered, KEYS.publicPem);
  assert.equal(v1.ok, false); assert.equal(v1.leafOk, false); assert.equal(v1.reason, 'leaf_mismatch');
  // even if the forger also updates leafHash to match the mutated entry, the path can no longer reach the signed root
  const tampered2 = { ...tampered, leafHash: tlog.entryLeafHash(tampered.entry).toString('base64') };
  const v2 = tlog.verifyInclusionBundle(tampered2, KEYS.publicPem);
  assert.equal(v2.ok, false); assert.equal(v2.leafOk, true); assert.equal(v2.rootOk, false); assert.equal(v2.reason, 'root_mismatch');
  // and directly: the mutated leaf under the original path does not equal the original signed root
  const leaves = tlog.leafHashesFromLines(lines);
  const path = tlog.inclusionPath(leaves, j);
  const mutatedLeaf = tlog.entryLeafHash(tampered.entry);
  assert.equal(tlog.verifyInclusion(mutatedLeaf, j, lines.length, path, tlog.rootFromLeafHashes(leaves)), false);
});

// ── TAMPER: a deleted / reordered / rewritten entry breaks the consistency proof (append-only violation) ─────────
test('tlog: a DELETED prefix entry breaks the consistency proof', () => {
  const lines = buildLedger(9);
  const leaves = tlog.leafHashesFromLines(lines);
  const first = 4;
  const firstRoot = tlog.rootFromLeafHashes(leaves.slice(0, first)); // the honestly-published older root
  // the newer tree DROPPED entry 1 (which is below `first`) — history was rewritten, not merely appended
  const del = leaves.slice(); del.splice(1, 1);
  const delRoot = tlog.rootFromLeafHashes(del);
  const forgedProof = tlog.consistencyProof(del, first); // best-effort proof from the doctored tree
  assert.equal(tlog.verifyConsistency(first, del.length, forgedProof, firstRoot, delRoot), false);
});

test('tlog: a REORDERED / REWRITTEN prefix entry breaks the consistency proof', () => {
  const leaves = tlog.leafHashesFromLines(buildLedger(9));
  const first = 5, second = 9;
  const firstRoot = tlog.rootFromLeafHashes(leaves.slice(0, first));
  // reorder two entries BELOW first (swap 1 and 3) in the larger tree
  const swapped = leaves.slice(); const tmp = swapped[1]; swapped[1] = swapped[3]; swapped[3] = tmp;
  const swappedRoot = tlog.rootFromLeafHashes(swapped);
  assert.equal(tlog.verifyConsistency(first, second, tlog.consistencyProof(swapped, first), firstRoot, swappedRoot), false);
  // rewrite one prefix entry's bytes (leaf) in the larger tree
  const rewritten = leaves.slice(); rewritten[2] = tlog.leafHashBytes(Buffer.from('rewritten payload'));
  const rewrittenRoot = tlog.rootFromLeafHashes(rewritten);
  assert.equal(tlog.verifyConsistency(first, second, tlog.consistencyProof(rewritten, first), firstRoot, rewrittenRoot), false);
  // a mangled proof (a flipped byte in one path node) also fails
  const good = tlog.consistencyProof(leaves.slice(0, second), first);
  const bad = good.map((b, i) => (i === 0 ? Buffer.concat([Buffer.from([b[0] ^ 0xff]), b.slice(1)]) : b));
  assert.equal(tlog.verifyConsistency(first, second, bad, firstRoot, tlog.rootFromLeafHashes(leaves.slice(0, second))), false);
});

// ── checkpoint signature + signed-note format ───────────────────────────────────────────────────────────────────
test('tlog: a checkpoint with a FORGED signature fails signature verification', () => {
  const leaves = tlog.leafHashesFromLines(buildLedger(5));
  const cp = tlog.checkpointFromLeafHashes(leaves, ORIGIN, KEYS.privatePem, KEYS.keyName);
  assert.equal(tlog.verifyCheckpoint(cp.note, KEYS.publicPem).ok, true);
  // a different key can't verify it
  const other = seal.generateKeypair();
  assert.equal(tlog.verifyCheckpoint(cp.note, other.publicPem).ok, false);
  // a signature the forger minted with THEIR key, spliced onto the same body, fails under the real published key
  const forgedNote = cp.body + '\n— urfael-seal-forged ' + seal.sign(other.privatePem, cp.body) + '\n';
  assert.equal(tlog.verifyCheckpoint(forgedNote, KEYS.publicPem).ok, false);
  // a body altered after signing (tree-size or root bumped) no longer verifies
  const altered = cp.note.replace('\n' + cp.treeSize + '\n', '\n' + (cp.treeSize + 1) + '\n');
  assert.equal(tlog.verifyCheckpoint(altered, KEYS.publicPem).ok, false);
  // and a bundle carrying a forged checkpoint is rejected before any root math
  const bundle = tlog.buildInclusionBundle(buildLedger(5), 1, ORIGIN, KEYS);
  const bad = { ...bundle, checkpoint: forgedNote };
  assert.equal(tlog.verifyInclusionBundle(bad, KEYS.publicPem).ok, false);
});

test('tlog: the checkpoint is exact C2SP signed-note format (message, blank line, "— name sig")', () => {
  const leaves = tlog.leafHashesFromLines(buildLedger(3));
  const cp = tlog.checkpointFromLeafHashes(leaves, ORIGIN, KEYS.privatePem, KEYS.keyName);
  const lines = cp.note.split('\n');
  assert.equal(lines[0], ORIGIN);              // origin
  assert.equal(lines[1], '3');                 // tree size
  assert.equal(lines[2], cp.root.toString('base64')); // base64(root)
  assert.equal(lines[3], '');                  // the blank separator line
  assert.match(lines[4], /^— urfael-seal-[0-9a-f]{16} [A-Za-z0-9+/]+=*$/); // "— <key-name> <base64 sig>"
  // the signature is over the MESSAGE body only (3 lines + newline), not the whole note
  const parsed = tlog.parseCheckpoint(cp.note);
  assert.equal(parsed.body, ORIGIN + '\n3\n' + cp.root.toString('base64') + '\n');
  assert.equal(seal.verify(KEYS.publicPem, parsed.body, parsed.sigs[0].sig), true);
  assert.equal(parsed.origin, ORIGIN); assert.equal(parsed.treeSize, 3);
});

test('tlog: parse/verify are fail-closed on malformed checkpoints (never throw)', () => {
  assert.equal(tlog.parseCheckpoint('garbage'), null);
  assert.equal(tlog.parseCheckpoint(''), null);
  assert.equal(tlog.parseCheckpoint('o\nnotanumber\ncm9vdA==\n\n— k s\n'), null);           // non-numeric size
  assert.equal(tlog.parseCheckpoint('o\n3\nzzz\n\n— k s\n'), null);                          // root not 32 bytes
  assert.equal(tlog.verifyCheckpoint('garbage', KEYS.publicPem).ok, false);
  assert.equal(tlog.verifyCheckpoint(null, KEYS.publicPem).ok, false);
  // a well-formed body with NO signature line is "unsigned", not valid
  const body = tlog.checkpointBody(ORIGIN, 2, tlog.rootFromLeafHashes(tlog.leafHashesFromLines(buildLedger(2))));
  assert.equal(tlog.verifyCheckpoint(body + '\n', KEYS.publicPem).reason, 'unsigned');
});
