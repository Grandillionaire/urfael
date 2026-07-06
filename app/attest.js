'use strict';
// app/attest.js — PURE assembly + rendering for `urfael attest`, the seal-anchored Attestation Report. It composes facts
// that are each INDEPENDENTLY verifiable (the Ledger of Record hash-chain, the ed25519 seal over its head, and the
// security posture in force) into one human- and machine-readable bundle a reviewer, auditor, or client can keep.
//
// The honesty contract is the whole point: the report attests to the INTEGRITY and AUTHORSHIP of the record and to the
// posture in force, NOT that any claim inside the record is true, and NOT an absolute guarantee that a packet can never
// leave the machine. It states the deny-policy in force; it is not a per-packet runtime capture. Overclaiming here
// would hand a researcher a way to publicly break it, so the wording is scoped precisely and tested against drift.

const crypto = require('crypto');

const SCOPE = {
  proves: [
    'The Ledger of Record is an unbroken sha256 hash chain, so any edit, deletion, or reorder of past actions is detectable.',
    'The owner ed25519 key signed the ledger head, so the record is authentic and history below the seal was not rewritten.',
    'A signed transparency-log checkpoint (RFC 6962 Merkle root, C2SP signed-note) lets a third party verify that N actions are present, in order, with none deleted, from an inclusion or consistency proof, without seeing their contents.',
    'The security posture in force: the brain opens no inbound TCP port (a 0600 unix socket only), and untrusted turns run a read-only profile with no shell, no write, no network egress, and a credential-deny boundary.',
  ],
  doesNotProve: [
    'That any individual claim recorded inside the ledger is true. The seal proves authorship and integrity of the record, not the truth of its contents.',
    'An absolute guarantee of zero egress. It states the no-egress deny-policy that is in force, not a per-packet runtime capture of every turn.',
  ],
};

// buildReport(parts, isoNow) -> the attestation object. parts = { subject, ledger, seal, posture }.
function buildReport(parts, isoNow) {
  const p = parts || {};
  return {
    kind: 'urfael-attestation',
    version: 1,
    generated: String(isoNow || ''),
    subject: p.subject || 'this Urfael instance',
    ledger: p.ledger || { verified: false },
    seal: p.seal || { present: false, valid: false },
    checkpoint: p.checkpoint || null,   // the signed transparency-log checkpoint (null when the daemon is unreachable)
    posture: p.posture || {},
    scope: SCOPE,
  };
}

// a one-line verdict for the top of the report and for the JSON.
function verdict(report) {
  const r = report || {};
  const lok = !!(r.ledger && r.ledger.verified);
  const seal = r.seal || {};
  if (lok && seal.present && seal.valid && seal.headStillInChain !== false) return 'ATTESTED';
  if (lok && !seal.present) return 'LEDGER INTACT (unsealed)';
  return 'NOT ATTESTED';
}

// a stable fingerprint of the report body, so two renders of the same facts are comparable (and so a bundle can be
// referenced by hash). Excludes nothing; it is sha256 of the canonical JSON.
function fingerprint(report) {
  // buildReport constructs keys in a fixed order, so a plain stringify is deterministic AND reflects nested content.
  return crypto.createHash('sha256').update(JSON.stringify(report)).digest('hex');
}

function bullets(list, mark) { return list.map((x) => '  ' + mark + ' ' + x).join('\n'); }

// human-readable report text. Mirrors SCOPE exactly; uses no absolute-guarantee language.
function render(report, opts) {
  const r = report || {};
  const dim = (opts && opts.plain) ? (s) => s : (s) => s;          // colour is applied by the caller, kept plain here
  const v = verdict(r);
  const L = r.ledger || {}, S = r.seal || {}, P = r.posture || {}, C = r.checkpoint || null;
  const lines = [];
  lines.push('URFAEL ATTESTATION  ' + v);
  lines.push('generated ' + (r.generated || '').replace('T', ' ').slice(0, 19) + '   subject: ' + r.subject);
  lines.push('report id ' + fingerprint(r).slice(0, 16));
  lines.push('');
  lines.push('Ledger of Record');
  lines.push(L.verified
    ? '  intact: ' + (L.count || 0) + ' entries, chain verified through seq ' + (L.through != null ? L.through : '-') + (L.head ? ', head ' + String(L.head).slice(0, 16) : '')
    : '  NOT VERIFIED' + (L.reason ? ': ' + L.reason : '') + (L.brokenSeq != null ? ' (first break at seq ' + L.brokenSeq + ')' : ''));
  lines.push('');
  lines.push('Sovereign Seal');
  if (!S.present) lines.push('  none yet (run `urfael seal` to sign the ledger head)');
  else if (S.valid) lines.push('  valid: key ' + (S.fp || '?') + ' signed through seq ' + (S.seq != null ? S.seq : '-')
    + (S.headStillInChain === true ? '  (sealed head still matches the ledger)'
      : S.headStillInChain === false ? '  [WARNING: sealed head no longer matches the ledger]'
        : '  (chain-prefix re-check unavailable)'));
  else lines.push('  DOES NOT VERIFY' + (S.reason ? ' (' + S.reason + ')' : ''));
  lines.push('');
  lines.push('Transparency Log');
  if (!C) lines.push('  none (start the brain to publish a signed checkpoint:  urfael attest checkpoint)');
  else lines.push('  signed checkpoint: ' + (C.treeSize != null ? C.treeSize : '-') + ' entries, RFC 6962 root ' + String(C.root || '').slice(0, 16)
    + (C.fp ? ', signer ' + C.fp : '') + '\n  a third party can verify inclusion/consistency proofs against it without seeing the contents');
  lines.push('');
  lines.push('Posture in force');
  lines.push('  inbound TCP port: ' + (P.noInboundPort ? 'none (0600 unix socket only)' : 'unknown'));
  lines.push('  untrusted turns:  ' + (P.untrustedProfile || 'read-only, no shell, no write, no egress, credential-deny'));
  if (P.mode) lines.push('  mode:             ' + P.mode);
  lines.push('');
  lines.push('What this proves');
  lines.push(bullets(SCOPE.proves, '+'));
  lines.push('What this deliberately does NOT prove');
  lines.push(bullets(SCOPE.doesNotProve, '-'));
  return lines.join('\n');
}

module.exports = { SCOPE, buildReport, verdict, fingerprint, render };
