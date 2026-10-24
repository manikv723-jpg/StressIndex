import fs from 'node:fs';
import path from 'node:path';

/**
 * Friend store + stress math.
 *
 * This is ONE long-running process for ONE event. There is no database on purpose:
 * a watch party lasts ~2 hours and 50 users max (Junction sandbox cap), so a Map is
 * the right size of hammer. Restarting the server wipes the board — that's fine, and
 * it's exactly why this must NOT be deployed to a serverless platform (Vercel/Lambda),
 * where each request may hit a different, empty instance.
 */

/** @type {Map<string, Friend>} keyed by Junction (Vital) user_id */
const friends = new Map();

/**
 * Short link code -> vitalUserId.
 *
 * Junction's own Link URL is a ~900-character signed JWT that expires after 60
 * MINUTES. Both of those make it useless for a real party: you can't WhatsApp a
 * 900-char link, and you can't send it the day before because it's dead by
 * kickoff. So we hand out `/j/<code>` instead and mint a fresh Junction token at
 * the moment the friend actually taps it. The code never expires; the token is
 * always seconds old.
 */
const linkCodes = new Map();

/**
 * Heart-rate history for trend lines — vitalUserId -> Map<epochMs, bpm>.
 *
 * Keyed by timestamp rather than an array because the poller re-fetches an
 * overlapping 6-hour window every 60s: the same samples arrive again and again,
 * and a Map dedupes them for free on the sample's own timestamp. Append to an
 * array instead and a 2-hour match becomes hundreds of thousands of duplicates.
 */
const history = new Map();

/**
 * Cap per friend. A 2h match at Junction's 1-minute resolution is ~120 points;
 * the demo simulator pushes every 3-8s, so ~1,800. 5,000 leaves room for a long
 * match plus extra time without letting a runaway session eat memory.
 */
const MAX_HISTORY = 5000;

/** Monotonic counter handing out stable chart colour slots. See upsertFriend. */
let nextColorIndex = 0;

// ---------------------------------------------------------------------------
// PERSISTENCE
// ---------------------------------------------------------------------------
//
// The brief said in-memory, no database — and for heart-rate history that's still
// right (it re-fetches from Junction in one poll). But friend PROFILES and their
// link codes cannot be ephemeral: a friend authorises their watch once, and that
// connection lives in Junction forever. If a restart forgets who they are, they
// vanish from the board and there is NO way to get them back except re-registering
// them — which mints a NEW Junction user and makes them re-authorise a watch they
// already connected. A real person got deleted by a restart before this existed.
//
// A ~2KB JSON file is not a database; it's a save file. Loss of it is survivable
// (re-adopt from Junction), so writes are best-effort and never block a request.

const STATE_FILE = process.env.STATE_FILE || path.join(process.cwd(), '.data', 'friends.json');
let saveTimer = null;

/**
 * Persistence is OFF until enabled — DEMO_MODE must never write.
 *
 * The simulator calls upsertFriend for its six fake friends, so with saving on by
 * default a single `DEMO_MODE=true npm start` overwrites the save file with
 * Arjun/Priya/Dev/… and destroys every real friend and link. That happened.
 */
let persistEnabled = false;

export function enablePersistence(on) {
  persistEnabled = !!on;
}

/** Debounced, best-effort save. Never throws into a request path. */
function scheduleSave() {
  if (!persistEnabled || saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    try {
      fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
      // Profiles + codes only. History is deliberately NOT persisted: the poller
      // rebuilds it from Junction's 6h window within a minute, so writing it would
      // be megabytes of churn for data we can just ask for.
      const payload = {
        v: 1,
        friends: [...friends.values()].map(({ latestHR, peakHR, lastSyncAt, ...profile }) => profile),
        linkCodes: [...linkCodes.entries()],
      };
      fs.writeFileSync(STATE_FILE, JSON.stringify(payload, null, 2));
    } catch (err) {
      console.warn(`[store] could not save state: ${err?.message ?? err}`);
    }
  }, 400);
  saveTimer.unref?.();
}

/** Restore friends + link codes from disk. Call once at boot. */
export function loadState() {
  try {
    if (!fs.existsSync(STATE_FILE)) return { friends: 0 };
    const raw = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    for (const f of raw.friends ?? []) {
      if (!f?.vitalUserId) continue;
      friends.set(f.vitalUserId, {
        device: 'pending',
        latestHR: null,
        peakHR: 0,
        lastSyncAt: null,
        ...f,
      });
      // Keep colour slots stable across restarts, or everyone's line changes hue.
      if (Number.isFinite(f.colorIndex)) nextColorIndex = Math.max(nextColorIndex, f.colorIndex + 1);
    }
    for (const [code, uid] of raw.linkCodes ?? []) linkCodes.set(code, uid);
    return { friends: friends.size, codes: linkCodes.size };
  } catch (err) {
    console.warn(`[store] could not load state: ${err?.message ?? err}`);
    return { friends: 0 };
  }
}

/**
 * @typedef {Object} Friend
 * @property {string} vitalUserId  Junction user id — the key everything joins on
 * @property {string} name
 * @property {string} device       'whoop' | 'fitbit' | 'apple' | 'pending'
 * @property {number} age
 * @property {number} restingHR
 * @property {number} maxHR        derived: 220 - age
 * @property {number|null} latestHR
 * @property {number} peakHR
 * @property {number|null} lastSyncAt  epoch ms of the last reading we accepted
 */

// ---------------------------------------------------------------------------
// STRESS MATH  (tweak here)
// ---------------------------------------------------------------------------

/**
 * Karvonen heart-rate reserve.
 *
 * Why reserve and not raw bpm: a raw-bpm leaderboard just ranks people by
 * cardiovascular fitness — the unfit friend sitting still "wins" over the
 * marathon runner mid-meltdown. Heart-rate RESERVE measures how far each person
 * has travelled from their OWN resting HR toward their OWN theoretical max, so a
 * score of 60 means the same *fraction of personal headroom burned* for everyone.
 *
 *   maxHR   = 220 - age                                  (Fox formula)
 *   reserve = (latestHR - restingHR) / (maxHR - restingHR)
 *   score   = clamp(reserve * 100, 0, 100)
 *
 * Worked example (also asserted in the README):
 *   age 30 -> maxHR 190; restingHR 60; latestHR 125
 *   reserve = (125 - 60) / (190 - 60) = 65 / 130 = 0.5
 *   score   = 50  -> "Tense"
 *
 * @param {number} latestHR
 * @param {number} restingHR
 * @param {number} maxHR
 * @returns {number} 0-100, rounded
 */
export function stressScore(latestHR, restingHR, maxHR) {
  const denominator = maxHR - restingHR;

  // Guard: a resting HR at or above max HR is nonsense data (bad age/restingHR
  // input). Return 0 rather than dividing by zero and poisoning the board with NaN.
  if (!Number.isFinite(denominator) || denominator <= 0) return 0;

  const reserve = (latestHR - restingHR) / denominator;
  return Math.round(clamp(reserve * 100, 0, 100));
}

/** States are the human-readable bands over the 0-100 score. */
export function stressState(score) {
  if (score < 30) return 'Calm';
  if (score < 55) return 'Tense';
  if (score < 78) return 'Stressed';
  return 'Meltdown';
}

function clamp(n, min, max) {
  return Math.min(max, Math.max(min, n));
}

// ---------------------------------------------------------------------------
// STORE
// ---------------------------------------------------------------------------

/**
 * Create or update a friend profile. Called at registration (with a pending
 * device) and again from the webhook once we learn which device they connected.
 *
 * Merges rather than replaces, so a later provider-connected webhook can set the
 * device without clobbering live HR readings that already arrived.
 *
 * @param {Partial<Friend> & { vitalUserId: string }} profile
 */
export function upsertFriend(profile) {
  const existing = friends.get(profile.vitalUserId);
  const merged = {
    device: 'pending',
    latestHR: null,
    peakHR: 0,
    lastSyncAt: null,
    // Stable chart colour slot, assigned once at first registration.
    // Colour must follow the PERSON, never their position in a list — if the
    // chart derived colour from array index, one friend dropping out (or having
    // no data yet) would repaint everyone below them, and a reader who learned
    // "Priya is blue" is now being lied to.
    colorIndex: existing?.colorIndex ?? nextColorIndex++,
    ...existing,
    ...profile,
  };

  // maxHR is always derived from age — never trust a caller-supplied maxHR.
  merged.maxHR = 220 - merged.age;

  friends.set(profile.vitalUserId, merged);
  scheduleSave();
  return merged;
}

/**
 * Record a heart-rate reading.
 *
 * Ignores readings for unknown users (someone connected a device but never
 * registered) and non-finite HR values, so a malformed webhook can never
 * corrupt the board.
 *
 * Out-of-order guard: providers batch-sync, so an older sample can arrive after
 * a newer one. We only move latestHR forward in time — but peakHR still absorbs
 * every valid sample, because a late-arriving spike is still a real spike.
 *
 * @param {string} vitalUserId
 * @param {number} heartRate
 * @param {number|string|Date} ts  timestamp of the sample
 */
export function pushReading(vitalUserId, heartRate, ts) {
  const friend = friends.get(vitalUserId);
  if (!friend) return false;
  if (!Number.isFinite(heartRate) || heartRate <= 0) return false;

  const at = ts ? new Date(ts).getTime() : Date.now();
  if (!Number.isFinite(at)) return false;

  if (friend.lastSyncAt === null || at >= friend.lastSyncAt) {
    friend.latestHR = heartRate;
    friend.lastSyncAt = at;
  }

  if (heartRate > friend.peakHR) friend.peakHR = heartRate;

  recordHistory(vitalUserId, heartRate, at);
  return true;
}

/**
 * Add one sample to the trend history. Safe to call with samples we already have —
 * same timestamp just overwrites.
 */
function recordHistory(vitalUserId, heartRate, at) {
  let series = history.get(vitalUserId);
  if (!series) {
    series = new Map();
    history.set(vitalUserId, series);
  }
  series.set(at, heartRate);

  // Evict oldest first. Map preserves insertion order, not time order, so sort
  // by the key — out-of-order arrivals are normal here (providers batch-sync).
  if (series.size > MAX_HISTORY) {
    const oldest = [...series.keys()].sort((a, b) => a - b).slice(0, series.size - MAX_HISTORY);
    for (const k of oldest) series.delete(k);
  }
}

/**
 * Bulk-ingest a provider's timeseries into history WITHOUT touching latestHR.
 *
 * The poller fetches a 6-hour window of 1-minute samples every cycle but only used
 * to keep the newest one — the rest was thrown away. That's the entire trend line,
 * discarded. This keeps all of it, so a match chart is fully backfilled even if the
 * server started at half-time. latestHR is left to pushReading, which has the
 * out-of-order guard.
 *
 * @param {string} vitalUserId
 * @param {Array<{heartRate:number, timestamp:any}>} samples
 * @returns {number} count of samples stored
 */
export function ingestHistory(vitalUserId, samples) {
  if (!friends.has(vitalUserId) || !Array.isArray(samples)) return 0;
  let n = 0;
  for (const s of samples) {
    const hr = Number(s?.heartRate ?? s?.value);
    if (!Number.isFinite(hr) || hr <= 0) continue;
    const at = new Date(s?.timestamp).getTime();
    if (!Number.isFinite(at)) continue;
    recordHistory(vitalUserId, hr, at);
    n++;
  }
  return n;
}

/**
 * Trend series for every friend, oldest→newest, with the stress score computed
 * per sample (the same Karvonen maths the live board uses).
 *
 * @param {number} sinceMs epoch ms lower bound
 */
export function getHistory(sinceMs = 0) {
  return [...friends.values()].map((f) => {
    const series = history.get(f.vitalUserId) ?? new Map();
    const points = [...series.entries()]
      .filter(([t]) => t >= sinceMs)
      .sort((a, b) => a[0] - b[0])
      .map(([t, hr]) => ({
        t,
        hr,
        score: stressScore(hr, f.restingHR, f.maxHR),
      }));

    return {
      name: f.name,
      device: f.device,
      colorIndex: f.colorIndex,
      restingHR: f.restingHR,
      maxHR: f.maxHR,
      peakHR: f.peakHR || null,
      points,
    };
  });
}

/**
 * The board. Sorted by score DESC (most rattled first).
 *
 * Friends with no reading yet score 0 and sort last, but they still appear —
 * seeing "waiting for first sync" beats a friend silently missing from the TV.
 */
export function getLeaderboard() {
  const now = Date.now();

  return [...friends.values()]
    .map((f) => {
      const score = f.latestHR === null ? 0 : stressScore(f.latestHR, f.restingHR, f.maxHR);
      return {
        name: f.name,
        device: f.device,
        score,
        latestHR: f.latestHR,
        peakHR: f.peakHR || null,
        state: stressState(score),
        // Clamped at 0: a sample can legitimately carry a timestamp slightly
        // ahead of our clock (provider timezone offsets, clock skew, and
        // sandbox synthetic data which stamps samples to the end of the day).
        // Unclamped this goes negative and the TV reads "synced -26278s ago".
        secondsAgo:
          f.lastSyncAt === null ? null : Math.max(0, Math.floor((now - f.lastSyncAt) / 1000)),
      };
    })
    .sort((a, b) => b.score - a.score || a.name.localeCompare(b.name)); // name breaks ties so order is stable
}

/** Reset peak bpm — e.g. at half-time, so the second half gets a fresh peak race. */
export function resetPeaks() {
  for (const f of friends.values()) f.peakHR = 0;
}

/**
 * Full roster for the admin dashboard: who exists, whether their watch is
 * actually connected, and how fresh their data is.
 *
 * `stale` is the number that matters operationally. A friend can be perfectly
 * connected and still show nothing on the board because their PHONE hasn't
 * pushed to the provider's cloud in hours — that looks identical to "broken"
 * unless the dashboard says so out loud.
 */
export function getRoster() {
  const now = Date.now();
  return [...friends.values()]
    .map((f) => {
      const secondsAgo = f.lastSyncAt === null ? null : Math.max(0, Math.floor((now - f.lastSyncAt) / 1000));
      return {
        vitalUserId: f.vitalUserId,
        name: f.name,
        age: f.age,
        restingHR: f.restingHR,
        device: f.device,
        connected: f.device !== 'pending',
        linkCode: f.linkCode ?? null,
        colorIndex: f.colorIndex,
        latestHR: f.latestHR,
        score: f.latestHR === null ? 0 : stressScore(f.latestHR, f.restingHR, f.maxHR),
        secondsAgo,
        // >15 min means their phone has stopped syncing, not that we're broken.
        stale: secondsAgo !== null && secondsAgo > 900,
        everSynced: f.lastSyncAt !== null,
      };
    })
    .sort((a, b) => Number(b.connected) - Number(a.connected) || a.name.localeCompare(b.name));
}

/**
 * Composure scoreboard — who cracked.
 *
 * Ranked on PEAK score, not average: the game is "who kept their nerve", and one
 * moment of blind panic is exactly the thing that should cost you. Averaging would
 * let someone who flatlined at 90 for one second look identical to someone mildly
 * tense throughout.
 *
 * composure = 100 − peakScore, so higher is better and the LOSER is whoever hit
 * the highest high. Peak comes from peakHR, which survives even if their latest
 * reading has gone stale.
 */
export function getScoreboard() {
  const rows = [...friends.values()].map((f) => {
    const series = history.get(f.vitalUserId);
    const scores = series
      ? [...series.values()].map((hr) => stressScore(hr, f.restingHR, f.maxHR))
      : [];
    const peakScore = f.peakHR ? stressScore(f.peakHR, f.restingHR, f.maxHR) : 0;
    const avgScore = scores.length
      ? Math.round(scores.reduce((a, b) => a + b, 0) / scores.length)
      : 0;
    return {
      name: f.name,
      device: f.device,
      colorIndex: f.colorIndex,
      restingHR: f.restingHR,
      latestHR: f.latestHR,
      peakHR: f.peakHR || null,
      peakScore,
      avgScore,
      composure: Math.max(0, 100 - peakScore),
      samples: scores.length,
    };
  });

  // Most composed first. Ties break on average, then name, so the order is stable
  // rather than jittering between polls.
  rows.sort((a, b) => b.composure - a.composure || a.avgScore - b.avgScore || a.name.localeCompare(b.name));

  return rows.map((r, i) => ({
    ...r,
    rank: i + 1,
    // Only crown a loser once someone has actually spiked — at 0-0 everyone is
    // "most composed" and calling a loser would be noise.
    loser: i === rows.length - 1 && rows.length > 1 && r.peakScore > 0,
    winner: i === 0 && rows.length > 1 && r.peakScore > 0,
  }));
}

/** Remove a friend from the board (does not delete their Junction user). */
export function removeFriend(vitalUserId) {
  const f = friends.get(vitalUserId);
  if (!f) return false;
  if (f.linkCode) linkCodes.delete(f.linkCode);
  friends.delete(vitalUserId);
  history.delete(vitalUserId);
  scheduleSave();
  return true;
}

/** Register a short link code for a friend. */
export function setLinkCode(code, vitalUserId) {
  linkCodes.set(code, vitalUserId);
  // Mirror onto the friend so the dashboard can show each person's own link
  // without scanning the whole code map.
  const f = friends.get(vitalUserId);
  if (f) f.linkCode = code;
  scheduleSave();
}

/** Resolve a short link code back to the friend it belongs to. */
export function getFriendByLinkCode(code) {
  const vitalUserId = linkCodes.get(code);
  return vitalUserId ? friends.get(vitalUserId) : undefined;
}

/** Internal helpers used by the demo simulator and the HR poller. */
export function getFriend(vitalUserId) {
  return friends.get(vitalUserId);
}

export function allFriends() {
  return [...friends.values()];
}

export function friendCount() {
  return friends.size;
}
