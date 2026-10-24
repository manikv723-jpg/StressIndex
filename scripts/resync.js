/**
 * Force a resync now instead of waiting for the 60s poller.
 *
 * ⚠️ ORDER MATTERS. This script only refreshes the Junction←Fitbit-cloud hop.
 * It cannot reach anyone's watch. The full chain is:
 *
 *   Air --BLE, continuous--> phone --~15min timer--> Fitbit cloud --> Junction --> board
 *                                   ^^^^^^^^^^^^^^^
 *                                   THE bottleneck
 *
 * Only opening the Google Health app on the phone forces that middle hop (the
 * band syncs whenever the app is opened and the band is nearby). Running this
 * without doing that just re-fetches the same stale sample — verified: a resync
 * with no app-open returned a reading that was still 593 seconds old.
 *
 * So: open Google Health on the phone FIRST, then run this.
 *
 * Usage: npm run resync
 */

import 'dotenv/config';

const port = Number(process.env.PORT) || 8080;
const url = `http://localhost:${port}/api/resync`;

const res = await fetch(url, { method: 'POST' }).catch((err) => {
  console.error(`Could not reach ${url} — is the server running?\n  ${err.message}`);
  process.exit(1);
});

const data = await res.json();
if (!res.ok) {
  console.error(`${res.status}:`, data.error ?? JSON.stringify(data));
  process.exit(1);
}

if (!data.friends?.length) {
  console.log('No friends registered yet.');
  process.exit(0);
}

console.log(`refreshed ${data.refreshed} · updated ${data.updated}`);
if (data.failed?.length) console.log(`failed: ${data.failed.join(', ')}`);
console.log('');

for (const f of data.friends) {
  const hr = f.latestHR == null ? '—' : `${f.latestHR} bpm`;
  const age = f.secondsAgo == null ? 'never synced' : `${f.secondsAgo}s ago`;
  // Call out stale data explicitly — a silently old number is the failure mode
  // here, and it looks identical to a fresh one on the board.
  const stale = f.secondsAgo != null && f.secondsAgo > 120 ? '  ← STALE: open Google Health on the phone' : '';
  console.log(`  ${f.name.padEnd(10)} ${hr.padEnd(8)} ${String(f.score).padStart(3)}  ${age}${stale}`);
}
