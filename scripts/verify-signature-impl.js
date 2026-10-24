/**
 * Cross-check our hand-rolled Svix verification against the OFFICIAL Svix SDK.
 *
 * server/junction.js verifies webhook signatures with ~15 lines of node:crypto
 * instead of depending on the Svix SDK at runtime. That is only defensible if it
 * is provably identical to the real thing — so this script signs payloads with
 * the official SDK and asserts our verifier agrees, then asserts it rejects every
 * tampering case.
 *
 * Run:  npm i -D svix && node scripts/verify-signature-impl.js
 */

import crypto from 'node:crypto';
import { Webhook } from 'svix';
import { verifyWebhookSignature } from '../server/junction.js';

const secretRaw = crypto.randomBytes(24).toString('base64');
const secret = `whsec_${secretRaw}`;
const wh = new Webhook(secret);

let pass = 0;
let fail = 0;
const check = (name, cond) => {
  cond ? pass++ : fail++;
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}`);
};

const body = JSON.stringify({
  event_type: 'daily.data.heart_rate.created',
  user_id: 'f1e2d3c4-0000-0000-0000-000000000001',
  data: { data: [{ timestamp: '2026-07-15T20:31:00Z', value: 142, unit: 'bpm' }] },
});

const msgId = 'msg_2abc';
const now = Math.floor(Date.now() / 1000);

// The official SDK produces the signature header we must accept.
const signature = wh.sign(msgId, new Date(now * 1000), body);
const headers = { 'svix-id': msgId, 'svix-timestamp': String(now), 'svix-signature': signature };

// 1. Happy path — the SDK's own signature must verify.
check('accepts a signature produced by the official Svix SDK', verifyWebhookSignature(body, headers, secret).ok);

// 2. Our verifier must agree with the SDK's verifier on the same input.
let sdkAccepted = true;
try { wh.verify(body, headers); } catch { sdkAccepted = false; }
check('agrees with Svix SDK verdict (both accept)', sdkAccepted === verifyWebhookSignature(body, headers, secret).ok);

// 3. Secret without the whsec_ prefix (dashboard copy-paste variant).
check('accepts secret with whsec_ prefix stripped', verifyWebhookSignature(body, headers, secretRaw).ok);

// 4. Tampered body must fail.
check('rejects tampered body', !verifyWebhookSignature(body.replace('142', '999'), headers, secret).ok);

// 5. Wrong secret must fail.
check('rejects wrong secret', !verifyWebhookSignature(body, headers, `whsec_${crypto.randomBytes(24).toString('base64')}`).ok);

// 6. Tampered signature must fail.
check('rejects tampered signature', !verifyWebhookSignature(body, { ...headers, 'svix-signature': 'v1,YWJj' }, secret).ok);

// 7. Missing headers must fail (not throw).
check('rejects missing headers', !verifyWebhookSignature(body, {}, secret).ok);

// 8. Replay: an old timestamp must fail even with a valid signature for it.
const oldTs = now - 60 * 60;
const oldSig = wh.sign(msgId, new Date(oldTs * 1000), body);
check('rejects replayed old timestamp', !verifyWebhookSignature(body, { 'svix-id': msgId, 'svix-timestamp': String(oldTs), 'svix-signature': oldSig }, secret).ok);

// 9. Multi-signature header (secret rotation) — must match ANY valid v1 sig.
check('accepts multi-sig header during rotation', verifyWebhookSignature(body, { ...headers, 'svix-signature': `v1,YWJj ${signature}` }, secret).ok);

// 10. svix-id is part of signed content — changing it must fail.
check('rejects mismatched svix-id', !verifyWebhookSignature(body, { ...headers, 'svix-id': 'msg_other' }, secret).ok);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
