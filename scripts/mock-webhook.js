/**
 * Send a correctly-signed mock Junction webhook at the running server.
 *
 * Signature verification means you cannot test the webhook path with a plain
 * curl — the request needs real svix-* headers. This signs one for you using the
 * same scheme the server verifies.
 *
 * Usage:
 *   node scripts/mock-webhook.js <vital_user_id> [heart_rate]
 *   node scripts/mock-webhook.js <vital_user_id> --connect whoop
 *   node scripts/mock-webhook.js <vital_user_id> 142 --bad-signature   # expect 401
 *
 * Reads VITAL_WEBHOOK_SECRET and PORT from .env.
 */

import 'dotenv/config';
import crypto from 'node:crypto';

const args = process.argv.slice(2);
const userId = args[0];
const badSig = args.includes('--bad-signature');
const connectIdx = args.indexOf('--connect');
const isConnect = connectIdx !== -1;
const provider = isConnect ? (args[connectIdx + 1] ?? 'whoop') : null;
const heartRate = Number(args[1]) || 142;

if (!userId || userId.startsWith('--')) {
  console.error('Usage: node scripts/mock-webhook.js <vital_user_id> [heart_rate] [--connect <provider>] [--bad-signature]');
  process.exit(1);
}

const secret = process.env.VITAL_WEBHOOK_SECRET;
if (!secret) {
  console.error('VITAL_WEBHOOK_SECRET is not set in .env — the server would 401 anything we send.');
  process.exit(1);
}

const port = Number(process.env.PORT) || 8080;
const url = `http://localhost:${port}/api/junction/webhook`;

// --- payloads -------------------------------------------------------------
// Shapes mirror Junction's documented event structure: a top-level event_type +
// user_id envelope, with TIMESERIES samples nested at $.data.data.

const payload = isConnect
  ? {
      event_type: 'provider.connection.created',
      user_id: userId,
      client_user_id: 'mock-client-user',
      team_id: '00000000-0000-0000-0000-000000000000',
      data: { provider, status: 'connected' },
    }
  : {
      event_type: 'daily.data.heart_rate.created',
      user_id: userId,
      client_user_id: 'mock-client-user',
      team_id: '00000000-0000-0000-0000-000000000000',
      data: {
        user_id: userId,
        source: { provider: 'whoop', type: 'watch' },
        // Deliberately out of chronological order: the server must pick the
        // MOST RECENT sample, not simply the last element of the array.
        data: [
          { timestamp: new Date(Date.now() - 20000).toISOString(), value: heartRate - 11, unit: 'bpm' },
          { timestamp: new Date().toISOString(),                   value: heartRate,      unit: 'bpm' },
          { timestamp: new Date(Date.now() - 40000).toISOString(), value: heartRate - 19, unit: 'bpm' },
        ],
      },
    };

const body = JSON.stringify(payload);

// --- sign (svix scheme) ---------------------------------------------------
const msgId = `msg_${crypto.randomBytes(8).toString('hex')}`;
const timestamp = Math.floor(Date.now() / 1000);
const key = Buffer.from(secret.replace(/^whsec_/, ''), 'base64');
const signature = crypto
  .createHmac('sha256', key)
  .update(`${msgId}.${timestamp}.${body}`)
  .digest('base64');

const sigHeader = badSig ? 'v1,bm90LWEtcmVhbC1zaWduYXR1cmU=' : `v1,${signature}`;

// --- send -----------------------------------------------------------------
const res = await fetch(url, {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'svix-id': msgId,
    'svix-timestamp': String(timestamp),
    'svix-signature': sigHeader,
  },
  body,
}).catch((err) => {
  console.error(`Could not reach ${url} — is the server running?\n  ${err.message}`);
  process.exit(1);
});

const text = await res.text();
console.log(`${res.status} ${res.statusText}  ${text}`);

if (badSig) {
  console.log(res.status === 401 ? '\n✅ correctly rejected the bad signature' : '\n❌ EXPECTED 401');
  process.exit(res.status === 401 ? 0 : 1);
}
console.log(
  isConnect
    ? `\n✅ ${userId} connected as ${provider} — check the board`
    : `\n✅ pushed ${heartRate} bpm for ${userId} — check the board`,
);
