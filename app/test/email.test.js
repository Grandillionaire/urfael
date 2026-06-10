'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { EventEmitter } = require('node:events');
const { Imap, parseFetch, addrOf } = require('../bridge/email-bridge');

// ---- HIGH #1: the From allowlist must read the HEADER block only, never the body ----
test('email: body "From:" cannot forge the sender (allowlist bypass)', () => {
  // real header From is the attacker; the body contains a forged allowed sender
  const lines = [
    '* 1 FETCH (BODY[HEADER.FIELDS (FROM SUBJECT)] {44}',
    'From: attacker@evil.com',
    'Subject: hello',
    '',
    ' BODY[TEXT] {30}',
    'From: owner@allowed.com',
    'pay me',
    ')',
  ];
  const { from } = parseFetch(lines);
  assert.equal(addrOf(from), 'attacker@evil.com');     // the header From, not the body's
  assert.notEqual(addrOf(from), 'owner@allowed.com');
});

test('email: no header From + forged body From => empty sender (blocked)', () => {
  const lines = ['* 1 FETCH (...) {10}', 'Subject: hi', '', ' BODY[TEXT] {25}', 'From: owner@allowed.com', ')'];
  assert.equal(addrOf(parseFetch(lines).from), '');     // empty => never in any allowlist
});

test('email: addrOf pulls the bare addr-spec from a display-name From', () => {
  assert.equal(addrOf('"Max" <max@myg-media.com>'), 'max@myg-media.com');
  assert.equal(addrOf('plain@x.io'), 'plain@x.io');
});

// ---- HIGH #2: a literal body that looks like a tagged/untagged line must NOT desync the parser ----
test('email: IMAP literal body cannot inject a fake tagged completion', async () => {
  const sock = new EventEmitter(); sock.write = () => {};
  const imap = new Imap(sock);
  const pr = imap.cmd('UID FETCH 1 (BODY.PEEK[TEXT])'); // first cmd => tag U1
  // The 18-byte literal body is EXACTLY a fake completion line for our own tag.
  const fake = 'U1 OK FAKE INSIDE\n';
  assert.equal(Buffer.byteLength(fake), 18);
  const resp =
    '* 1 FETCH (BODY[TEXT] {18}\r\n' + fake + ')\r\n' +  // body is opaque literal data
    'U1 OK FETCH complete\r\n';                          // the ONLY real completion
  sock.emit('data', Buffer.from(resp, 'utf8'));
  const lines = await pr;                                // resolves on the REAL tag, not the one in the body
  const joined = lines.join('\r\n');
  assert.ok(/FAKE INSIDE/.test(joined), 'literal body content is captured, not parsed as protocol');
  assert.ok(/BODY\[TEXT\]/.test(joined), 'the FETCH line is intact');
});

test('email: a literal split across two data chunks reassembles correctly', async () => {
  const sock = new EventEmitter(); sock.write = () => {};
  const imap = new Imap(sock);
  const pr = imap.cmd('UID FETCH 2 (BODY.PEEK[TEXT])');
  sock.emit('data', Buffer.from('* 2 FETCH (BODY[TEXT] {11}\r\nHel', 'utf8')); // literal arrives in pieces
  sock.emit('data', Buffer.from('lo world)\r\n', 'utf8'));
  sock.emit('data', Buffer.from('U1 OK done\r\n', 'utf8'));
  const lines = await pr;
  assert.ok(/Hello world/.test(lines.join('\r\n')));
});
