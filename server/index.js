/**
 * Stress Index — Express app, routes, static serving.
 *
 * One long-running process holds the whole party in memory. Deploy to Railway or
 * Render (persistent), never Vercel/Lambda (stateless — every request could land
 * on a fresh, empty instance and the board would flicker between friends).
 */

import 'dotenv/config';
import crypto from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';

import {
  getLeaderboard,
  upsertFriend,
  allFriends,
  friendCount,
  resetPeaks,
  setLinkCode,
  getFriendByLinkCode,
  getHistory,
  loadState,
  getRoster,
  getScoreboard,
  removeFriend,
  enablePersistence,
} from './store.js';
import { startDemo, triggerGoal, isDemoRunning } from './demo.js';
import { startMatchSim, matchState, restartMatchSim, isMatchSimRunning } from './matchsim.js';
import { join as signalJoin, relay as signalRelay, status as signalStatus } from './signal.js';
import {
  initJunction,
  createUserAndLink,
  createLinkToken,
  verifyWebhookSignature,
  handleWebhookEvent,
  startHeartRatePolling,
  pollOnce,
  HR_WINDOW_HOURS,
} from './junction.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, '..', 'public');

const PORT = Number(process.env.PORT) || 8080;
const DEMO_MODE = process.env.DEMO_MODE === 'true';
// Scripted 75s Argentina v England for recording. Implies DEMO-like behaviour:
// it seeds fake fans, so it must never write to the persisted roster either.
const MATCH_SIM = process.env.MATCH_SIM === 'true';
const API_KEY = process.env.VITAL_API_KEY;
const WEBHOOK_SECRET = process.env.VITAL_WEBHOOK_SECRET;
const POLL_HR = process.env.POLL_HEART_RATE !== 'false'; // fallback poller, on by default
// Explicit public origin for shareable links (tunnel or deployed domain).
// Trailing slash stripped so `${PUBLIC_URL}/j/x` never becomes `//j/x`.
const PUBLIC_URL = (process.env.PUBLIC_URL || '').trim().replace(/\/+$/, '');

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', true); // Railway/Render sit behind a proxy; needed for correct shortUrl host

const slugify = (name) =>
  name.toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'friend';

/** LAN IPv4 — the address a phone on the same wifi can actually reach. */
function lanAddress() {
  for (const iface of Object.values(os.networkInterfaces()).flat()) {
    if (iface && iface.family === 'IPv4' && !iface.internal) return iface.address;
  }
  return null;
}

/**
 * Base URL to put in links we hand to other people's phones.
 *
 * Order matters:
 *  1. PUBLIC_URL — an explicit override, and the ONLY reliable answer when a
 *     tunnel is involved. Without it the base is derived from the Host header,
 *     so opening /admin on localhost while cloudflared is running mints
 *     `http://192.168.x.x:8090/j/...` links — which look fine on the laptop and
 *     are unreachable from any phone that isn't on the same wifi. Set it once and
 *     it no longer matters which URL you happen to have open.
 *  2. The Host header — correct when deployed behind a proxy, or when you did
 *     open /admin through the tunnel.
 *  3. LAN IP — last resort. `localhost` in a shared link resolves to the
 *     FRIEND's own phone, so it's never right to hand out.
 */
function publicBase(req) {
  if (PUBLIC_URL) return PUBLIC_URL;
  const host = req.get('host') ?? '';
  if (/^(localhost|127\.0\.0\.1|\[::1\])(:|$)/i.test(host)) {
    const lan = lanAddress();
    if (lan) return `http://${lan}:${PORT}`;
  }
  return `${req.protocol}://${host}`;
}

/** True when a base URL can't be opened from outside this wifi. */
function isLanOnly(base) {
  return /^https?:\/\/(localhost|127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/i.test(base);
}

/** Minimal styled error page — these get opened on a friend's phone, not by us. */
function linkErrorPage(title, detail) {
  return `<!doctype html><meta name=viewport content="width=device-width,initial-scale=1">
<body style="margin:0;min-height:100vh;display:grid;place-items:center;background:#0A130F;color:#DCE7E0;font-family:ui-sans-serif,-apple-system,system-ui,sans-serif;text-align:center;padding:24px">
<div><div style="font-size:40px;margin-bottom:14px">📡</div>
<h1 style="font-size:20px;font-weight:640;margin:0 0 8px">${title}</h1>
<p style="color:#879A8F;font-size:14px;line-height:1.6;margin:0;max-width:30ch">${detail}</p></div>`;
}

// ---------------------------------------------------------------------------
// WEBHOOK — must be mounted BEFORE express.json()
// ---------------------------------------------------------------------------
//
// Signature verification hashes the EXACT bytes Junction sent. express.json()
// would parse and discard them, and JSON.parse -> JSON.stringify does not
// round-trip to identical bytes (key order, whitespace, unicode escapes), so
// every signature would fail. express.raw() hands us the untouched Buffer.

app.post('/api/junction/webhook', express.raw({ type: '*/*', limit: '2mb' }), (req, res) => {
  const check = verifyWebhookSignature(req.body, req.headers, WEBHOOK_SECRET);
  if (!check.ok) {
    console.warn(`[webhook] rejected: ${check.reason}`);
    return res.status(401).json({ error: 'invalid signature', reason: check.reason });
  }

  // Signature is good. Respond 200 immediately and do the work after — Junction
  // retries on slow/erroring endpoints with exponential backoff, and a stalled
  // webhook endpoint gets throttled. Nothing here is slow today, but this keeps
  // that true if the handler ever grows.
  res.status(200).json({ ok: true });

  try {
    const payload = JSON.parse(req.body.toString('utf8'));
    const result = handleWebhookEvent(payload);
    if (result.handled !== 'ignored') {
      console.log(`[webhook] ${result.handled}`, result.detail ?? '');
    }
  } catch (err) {
    // A malformed body from a correctly-signed sender is not worth a 500 the
    // client will never see — we already replied 200.
    console.warn(`[webhook] bad payload: ${err?.message ?? err}`);
  }
});

// JSON parsing for everything else.
app.use(express.json());

// ---------------------------------------------------------------------------
// API
// ---------------------------------------------------------------------------

/** The board. Polled by the frontend every 4s. */
app.get('/api/leaderboard', (_req, res) => {
  const match = MATCH_SIM ? matchState() : { running: false };
  res.json({
    friends: getLeaderboard(),
    demo: DEMO_MODE,
    match,
    // Sides only exist in the scripted match — the board colours the allegiance
    // tag from this rather than inventing one.
    scoreboard: MATCH_SIM ? getScoreboard().map((r) => ({ ...r, side: match.sides?.[r.name] ?? null })) : null,
  });
});

/** Composure scoreboard: who kept their nerve, who cracked. */
app.get('/api/scoreboard', (_req, res) => {
  const match = MATCH_SIM ? matchState() : { running: false };
  res.json({
    match,
    rows: getScoreboard().map((r) => ({ ...r, side: match.sides?.[r.name] ?? null })),
  });
});

/** Replay the scripted clip from 0 — for taking another recording. */
app.post('/api/match/restart', (_req, res) => {
  if (!MATCH_SIM) return res.status(404).json({ error: 'match sim is off' });
  resetPeaks(); // otherwise the old peaks decide the scoreboard forever
  res.json(restartMatchSim());
});

/**
 * Trend series for the match chart. `?minutes=` scopes the window (default 120 —
 * a football match plus a little).
 *
 * This is where the cloud path's 3-6 minute lag stops mattering: for looking BACK
 * at what the match did to everyone, a few minutes of delay is irrelevant. The
 * data is fully backfilled from Junction, so the chart is complete even if the
 * server only started at half-time.
 */
app.get('/api/history', (req, res) => {
  const minutes = Math.min(720, Math.max(5, Number(req.query.minutes) || 120));
  const since = Date.now() - minutes * 60_000;
  const friends = getHistory(since);
  res.json({
    minutes,
    since,
    now: Date.now(),
    demo: DEMO_MODE,
    friends: friends.filter((f) => f.points.length > 0),
  });
});

/**
 * Register a friend: create a Junction user, mint a Link token, store them as
 * pending, and hand back the Link URL for them to connect their watch.
 */
app.post('/api/connect', async (req, res) => {
  const { name, age, restingHR, provider } = req.body ?? {};

  const parsedAge = Number(age);
  const parsedResting = Number(restingHR);

  if (!name || typeof name !== 'string' || !name.trim()) {
    return res.status(400).json({ error: 'name is required' });
  }
  // Bounds keep the Karvonen denominator sane: age >= 100 would make maxHR <= 120,
  // and a restingHR at or above maxHR divides by zero.
  if (!Number.isFinite(parsedAge) || parsedAge < 10 || parsedAge > 99) {
    return res.status(400).json({ error: 'age must be between 10 and 99' });
  }
  if (!Number.isFinite(parsedResting) || parsedResting < 30 || parsedResting > 120) {
    return res.status(400).json({ error: 'restingHR must be between 30 and 120' });
  }
  if (parsedResting >= 220 - parsedAge) {
    return res.status(400).json({ error: 'restingHR must be below max HR (220 - age)' });
  }
  if (!API_KEY) {
    return res.status(503).json({ error: 'VITAL_API_KEY is not set — cannot create Junction users' });
  }

  try {
    // Reserve the short code up front so the post-connect landing page can be
    // told WHO just connected.
    const code = `${slugify(name)}-${crypto.randomBytes(2).toString('hex')}`;
    const base = publicBase(req);
    const redirectUrl = `${base}/joined?c=${encodeURIComponent(code)}`;

    const { vitalUserId, clientUserId, linkWebUrl } = await createUserAndLink(
      name.trim(),
      provider,
      redirectUrl,
    );

    upsertFriend({
      vitalUserId,
      name: name.trim(),
      age: parsedAge,
      restingHR: parsedResting,
      device: 'pending', // the webhook (or the poller) fills this in once they connect
      // Remembered so /j/<code> re-mints the SAME provider-specific link. Without
      // this, the short link would silently fall back to the picker — the friend
      // gets a different flow from the one you chose for them.
      preferredProvider: provider || null,
    });

    // Short, non-expiring link to share. See store.js for why the raw Junction
    // URL can't be the thing you WhatsApp to people.
    setLinkCode(code, vitalUserId);
    const shortPath = `/j/${code}`;

    console.log(`[connect] ${name.trim()} -> ${vitalUserId}  (${shortPath})`);
    res.json({
      vitalUserId,
      clientUserId,
      name: name.trim(),
      shortPath,
      shortUrl: `${base}${shortPath}`,
      // Tell the UI when this link can't leave the wifi, so it can say so rather
      // than letting you WhatsApp a dead link to six people.
      lanOnly: isLanOnly(base),
      linkWebUrl, // still returned so "Open here" works instantly on this machine
    });
  } catch (err) {
    console.error('[connect] failed:', err?.message ?? err);
    res.status(502).json({ error: 'Junction rejected the request', detail: err?.message ?? String(err) });
  }
});

/**
 * Adopt an EXISTING Junction user onto the board.
 *
 * Two real needs: (1) someone already connected their device under a user id we
 * don't have a profile for, and (2) the store is in-memory, so a server restart
 * forgets everyone — but the Junction users and their device connections survive.
 * Without this, a restart mid-party would mean asking everyone to re-link their
 * watch, which is not a thing you can ask a room to do.
 *
 * Body: { vitalUserId, name, age, restingHR }
 */
app.post('/api/adopt', async (req, res) => {
  const { vitalUserId, name, age, restingHR } = req.body ?? {};
  const parsedAge = Number(age);
  const parsedResting = Number(restingHR);

  if (!vitalUserId || typeof vitalUserId !== 'string') {
    return res.status(400).json({ error: 'vitalUserId is required' });
  }
  if (!name?.trim()) return res.status(400).json({ error: 'name is required' });
  if (!Number.isFinite(parsedAge) || parsedAge < 10 || parsedAge > 99) {
    return res.status(400).json({ error: 'age must be between 10 and 99' });
  }
  if (!Number.isFinite(parsedResting) || parsedResting < 30 || parsedResting > 120) {
    return res.status(400).json({ error: 'restingHR must be between 30 and 120' });
  }
  if (parsedResting >= 220 - parsedAge) {
    return res.status(400).json({ error: 'restingHR must be below max HR (220 - age)' });
  }

  upsertFriend({
    vitalUserId,
    name: name.trim(),
    age: parsedAge,
    restingHR: parsedResting,
    device: 'pending', // the poller resolves this from Junction on its next tick
  });

  const code = `${slugify(name)}-${crypto.randomBytes(2).toString('hex')}`;
  setLinkCode(code, vitalUserId);

  console.log(`[adopt] ${name.trim()} <- ${vitalUserId}`);
  res.json({ vitalUserId, name: name.trim(), shortUrl: `${publicBase(req)}/j/${code}` });
});

// ---------------------------------------------------------------------------
// WATCH ALONG — WebRTC signalling
// ---------------------------------------------------------------------------
//
// The screen video goes peer-to-peer and never through this process. These routes
// only pass SDP/ICE between host and viewers. See server/signal.js.

const ROOM = 'match'; // one party, one room

/** SSE stream: GET /api/signal/:role/:peerId */
app.get('/api/signal/:role/:peerId', (req, res) => {
  const role = req.params.role === 'host' ? 'host' : 'viewer';
  signalJoin(req, res, ROOM, req.params.peerId, role);
});

/** POST /api/signal/:peerId — relay an SDP/ICE message to `to` (or to the host). */
app.post('/api/signal/:peerId', (req, res) => {
  const { to, type, payload } = req.body ?? {};
  if (!type) return res.status(400).json({ error: 'type is required' });
  const ok = signalRelay(ROOM, req.params.peerId, to, type, payload ?? {});
  // 202 not 404: a peer vanishing mid-negotiation is normal, not an error worth
  // throwing in the sender's face.
  res.status(ok ? 200 : 202).json({ delivered: ok });
});

/** Is anyone sharing right now, and how many are watching. */
app.get('/api/watch/status', (req, res) => {
  res.json({ ...signalStatus(ROOM), watchUrl: `${publicBase(req)}/watch` });
});

/**
 * Everything the admin dashboard needs in one call: the roster with live
 * connection status, each friend's own link, and the shareable board/trends URLs.
 */
app.get('/api/friends', (req, res) => {
  const base = publicBase(req);
  res.json({
    demo: DEMO_MODE,
    lanOnly: isLanOnly(base),
    board: `${base}/`,
    trends: `${base}/trends`,
    // How far back the poller looks — so the UI can say "no reading in the last
    // Nh" instead of implying a first reading is imminent.
    windowHours: HR_WINDOW_HOURS,
    friends: getRoster().map((f) => ({
      ...f,
      shortUrl: f.linkCode ? `${base}/j/${f.linkCode}` : null,
    })),
  });
});

/** Drop someone from the board. Their Junction user and connection survive. */
app.delete('/api/friends/:vitalUserId', (req, res) => {
  const ok = removeFriend(req.params.vitalUserId);
  if (!ok) return res.status(404).json({ error: 'unknown friend' });
  console.log(`[admin] removed ${req.params.vitalUserId}`);
  res.json({ ok: true });
});

/**
 * Status for one friend, by their short code. Drives the post-connect page so a
 * friend sees THEIR OWN card land, not the whole room's leaderboard.
 */
app.get('/api/me/:code', (req, res) => {
  const friend = getFriendByLinkCode(req.params.code);
  if (!friend) return res.status(404).json({ error: 'unknown link code' });
  const row = getLeaderboard().find((f) => f.name === friend.name);
  res.json({
    name: friend.name,
    device: friend.device,
    connected: friend.device !== 'pending',
    latestHR: row?.latestHR ?? null,
    score: row?.score ?? 0,
    state: row?.state ?? null,
    secondsAgo: row?.secondsAgo ?? null,
  });
});

/**
 * Short link: /j/<code> -> a freshly-minted Junction Link URL.
 *
 * This is the URL you actually send people. The code never expires; the Junction
 * token behind it is created on the spot, so a link sent yesterday still works
 * at kickoff (the raw token would have died after 60 minutes).
 */
app.get('/j/:code', async (req, res) => {
  const friend = getFriendByLinkCode(req.params.code);
  if (!friend) {
    return res.status(404).send(linkErrorPage('Link not found', 'This link is unknown — the server may have restarted. Ask for a new one.'));
  }
  try {
    const linkWebUrl = await createLinkToken(
      friend.vitalUserId,
      friend.preferredProvider,
      `${publicBase(req)}/joined?c=${encodeURIComponent(req.params.code)}`,
    );
    res.redirect(302, linkWebUrl);
  } catch (err) {
    console.error(`[/j] ${friend.name}: ${err?.message ?? err}`);
    res.status(502).send(linkErrorPage('Junction is not responding', 'Could not create a connect link right now. Try again in a moment.'));
  }
});

/**
 * Force a resync now instead of waiting for the 60s poller.
 *
 * Asks Junction to re-pull from each provider, then immediately polls. Note this
 * cannot reach anyone's watch — see refreshUser() in junction.js for why the
 * phone still has to open its health app for the freshest number.
 */
app.post('/api/resync', async (req, res) => {
  const friends = allFriends();
  if (!friends.length) return res.json({ ok: true, refreshed: 0, note: 'no friends registered' });
  if (!API_KEY) return res.status(503).json({ error: 'VITAL_API_KEY is not set' });

  const poll = await pollOnce(allFriends(), { force: true });

  console.log(`[resync] refreshed ${poll.refreshed}/${friends.length}, updated ${poll.updated}`);
  res.json({ ok: true, ...poll, friends: getLeaderboard() });
});

/** Half-time reset — clears peak bpm so the second half races fresh. */
app.post('/api/reset-peaks', (_req, res) => {
  resetPeaks();
  res.json({ ok: true });
});

// --- Demo-only routes ------------------------------------------------------

app.get('/api/demo/status', (_req, res) => {
  // MATCH_SIM suppresses the demo controls even when DEMO_MODE is also set (it is,
  // in .env): the scripted match has its own restart, and a random "goal" spike
  // fired mid-take would corrupt the recording it's meant to showcase.
  res.json({ demo: DEMO_MODE && !MATCH_SIM, running: isDemoRunning(), friends: friendCount() });
});

app.post('/api/demo/goal', (_req, res) => {
  // Guard, not just a UI concern: with DEMO_MODE=false this must not exist as a
  // way to shove fake arousal into a real board. Blocked during MATCH_SIM too —
  // the timeline owns the drama there.
  if (!DEMO_MODE || MATCH_SIM) return res.status(404).json({ error: 'demo mode is off' });
  res.json({ ok: true, ...triggerGoal() });
});

// ---------------------------------------------------------------------------
// STATIC
// ---------------------------------------------------------------------------

app.get('/', (_req, res) => res.sendFile(path.join(PUBLIC_DIR, 'index.html')));
// /admin IS the console now — dashboard left, shared screen right. The old
// single-column dashboard stays reachable at /admin/simple for a phone.
app.get('/admin', (_req, res) => res.sendFile(path.join(PUBLIC_DIR, 'console.html')));
app.get('/admin/simple', (_req, res) => res.sendFile(path.join(PUBLIC_DIR, 'admin.html')));
app.get('/trends', (_req, res) => res.sendFile(path.join(PUBLIC_DIR, 'trends.html')));
app.get('/joined', (_req, res) => res.sendFile(path.join(PUBLIC_DIR, 'joined.html')));
app.get('/watch', (_req, res) => res.sendFile(path.join(PUBLIC_DIR, 'watch.html')));
app.use(express.static(PUBLIC_DIR));

// ---------------------------------------------------------------------------
// BOOT
// ---------------------------------------------------------------------------

initJunction({ apiKey: API_KEY, env: process.env.VITAL_ENV, region: process.env.VITAL_REGION });

// Restore friends before anything can serve a request — a restart must not lose
// people who already connected their watch.
//
// Demo mode neither loads nor saves: its six fake friends would overwrite the real
// roster on disk (they did, once), and a demo board seeded with real friends would
// be equally wrong.
if (!DEMO_MODE && !MATCH_SIM) {
  enablePersistence(true);
  const restored = loadState();
  if (restored.friends) {
    console.log(`[store] restored ${restored.friends} friend(s), ${restored.codes} link(s) from disk`);
  }
}

if (MATCH_SIM) {
  startMatchSim();
} else if (DEMO_MODE) {
  startDemo();
} else if (API_KEY && POLL_HR) {
  // Fallback only — webhooks are primary. See junction.js.
  startHeartRatePolling({ intervalMs: 60_000, friendsFn: allFriends });
  console.log('[poll] auto: polling HR every 60s, nudging Junction to re-pull every 3min');
}

// 0.0.0.0 so phones on the same wifi can reach it — the default binding would
// only accept connections from this machine, and the whole point is sharing links.
const server = app.listen(PORT, '0.0.0.0', () => {
  const lan = lanAddress();
  console.log(`\n  Stress Index  ->  http://localhost:${PORT}`);
  console.log(`  Admin         ->  http://localhost:${PORT}/admin`);
  if (PUBLIC_URL) {
    console.log(`  Shared links  ->  ${PUBLIC_URL}/j/…   (public ✓)`);
  } else if (lan) {
    console.log(`  Shared links  ->  http://${lan}:${PORT}/j/…   (SAME WIFI ONLY)`);
    console.log(`                    phones on mobile data can't open these. For a public link:`);
    console.log(`                    cloudflared tunnel --url http://localhost:${PORT}`);
    console.log(`                    then restart with PUBLIC_URL=https://<tunnel> npm start`);
  }
  console.log(`  Mode          ->  ${MATCH_SIM ? 'MATCH SIM (scripted 75s Argentina v England)' : DEMO_MODE ? 'DEMO (simulated friends)' : 'LIVE (real Junction data only)'}`);
  if (!DEMO_MODE && !API_KEY) console.log('  ⚠  VITAL_API_KEY not set — /api/connect will fail');
  if (!WEBHOOK_SECRET) console.log('  ⚠  VITAL_WEBHOOK_SECRET not set — all webhooks will 401');
  console.log('');
});

// A port clash 10 minutes before kickoff should not greet you with a stack trace.
server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`\n  ✗ Port ${PORT} is already in use.`);
    console.error(`    Free it, or start on another port:  PORT=8090 npm start\n`);
    process.exit(1);
  }
  throw err;
});
