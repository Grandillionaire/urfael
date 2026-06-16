'use strict';
// Sovereign Seal — an owner ed25519 keypair signs the Ledger of Record's chain head, so the tamper-evident
// activity record also carries a cryptographic IDENTITY: "the holder of THIS key attested to the record ending
// at <chainHead> (seq N) at <time>." HONEST SCOPE: a seal proves authorship + integrity of the RECORD at that
// moment — NOT that any claim inside it is true. Pure crypto (ed25519 signatures are deterministic), so sign/
// verify are directly unit-testable; the daemon owns key storage (private key 0600, public key published in git).
const crypto = require('crypto');

// Returns PEM strings (portable, git-committable public key; 0600 private key).
function generateKeypair() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  return {
    publicPem: publicKey.export({ type: 'spki', format: 'pem' }),
    privatePem: privateKey.export({ type: 'pkcs8', format: 'pem' }),
  };
}
function sign(privatePem, message) {
  return crypto.sign(null, Buffer.from(String(message)), privatePem).toString('base64'); // ed25519: algorithm is null
}
function verify(publicPem, message, sigB64) {
  try { return crypto.verify(null, Buffer.from(String(message)), publicPem, Buffer.from(String(sigB64), 'base64')); }
  catch { return false; }
}
// A short, stable identity for the public key (sha256 of its DER), so a seal names WHICH key signed it.
function fingerprint(publicPem) {
  try {
    const der = crypto.createPublicKey(publicPem).export({ type: 'spki', format: 'der' });
    return crypto.createHash('sha256').update(der).digest('hex').slice(0, 16);
  } catch { return ''; }
}
// The canonical message that gets signed: binds the chain head + seq + time + key fingerprint, so a signature
// can't be replayed onto a different head or identity. Deterministic field order (NOT key-sorted JSON needed —
// this exact string is what both sign and verify hash, so it just has to be stable).
function sealMessage(s) {
  return 'urfael-seal/v1\nchainHead=' + (s.chainHead || '') + '\nseq=' + (s.seq == null ? '' : s.seq) + '\nt=' + (s.t || '') + '\nfp=' + (s.fp || '');
}

module.exports = { generateKeypair, sign, verify, fingerprint, sealMessage };
