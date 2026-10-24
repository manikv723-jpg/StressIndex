/**
 * Connect a registered friend to a SYNTHETIC Fitbit in the Junction sandbox.
 *
 * This is the closest you can get to a real device without owning one. Junction
 * creates a fake-but-real connection: it fires genuine `provider.connection.created`
 * and heart-rate webhooks at your endpoint, and backfills 30 days of 1-minute
 * heart-rate samples that the real timeseries endpoint will serve.
 *
 * It exercises the ACTUAL production pipeline — Junction's servers, real webhook
 * signatures, the real HR extraction path — unlike DEMO_MODE (which never touches
 * Junction) or scripts/mock-webhook.js (which forges the request locally).
 *
 * What it is NOT: live. Junction simulates new activity only every couple of
 * hours, so the board will populate from backfill and then sit still. Use
 * DEMO_MODE for a board that visibly moves.
 *
 * Usage:
 *   1. DEMO_MODE=false npm start
 *   2. register a friend at /admin, copy their vital user id
 *   3. node scripts/demo-connect.js <vital_user_id>
 *
 * Note: demo users expire after 7 days and count toward the 50-user sandbox cap.
 * A user with a real connection can't also take a demo one — use a fresh friend.
 */

import 'dotenv/config';
import { JunctionClient, JunctionEnvironment } from '@junction-api/sdk';

const userId = process.argv[2];
const provider = process.argv[3] ?? 'fitbit'; // demo supports: fitbit, apple_health_kit, oura, freestyle_libre

if (!userId) {
  console.error('Usage: node scripts/demo-connect.js <vital_user_id> [provider]');
  console.error('Get the id from /admin after registering a friend.');
  process.exit(1);
}
if (!process.env.VITAL_API_KEY) {
  console.error('VITAL_API_KEY is not set in .env');
  process.exit(1);
}

const client = new JunctionClient({
  apiKey: process.env.VITAL_API_KEY,
  environment:
    process.env.VITAL_ENV === 'production' ? JunctionEnvironment.Production : JunctionEnvironment.Sandbox,
});

const res = await client.link.connectDemoProvider({ userId, provider });
console.log(`✅ ${res.detail ?? JSON.stringify(res)}`);

// Prove the synthetic data is actually queryable, so a silent empty board later
// is unambiguous — it would be our bug, not a missing connection.
const startDate = new Date(Date.now() - 2 * 24 * 3600 * 1000).toISOString().slice(0, 10);
const series = await client.vitals.heartrate({ userId, startDate }).catch((e) => {
  console.error('heartrate query failed:', e?.statusCode, JSON.stringify(e?.body ?? e?.message));
  return [];
});

const samples = (Array.isArray(series) ? series : [])
  .flatMap((s) => (Array.isArray(s?.data) ? s.data : [s]))
  .filter((s) => Number.isFinite(s?.value));

if (!samples.length) {
  console.log('⚠️  No heart-rate samples yet — backfill can take a few seconds. Re-run to re-check.');
  process.exit(0);
}

const latest = samples.reduce((a, b) => (new Date(a.timestamp) > new Date(b.timestamp) ? a : b));
console.log(`   ${samples.length} HR samples available (1-minute granularity)`);
console.log(`   latest: ${latest.value} bpm @ ${new Date(latest.timestamp).toISOString()}`);
console.log('\nThe 60s poller will pull this onto the board within a minute.');
console.log('Webhooks for this connection also fire at your endpoint if it is reachable (ngrok).');
