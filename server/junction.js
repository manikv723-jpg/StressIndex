/**
 * Junction (formerly Vital) integration.
 *
 * SDK NOTE — READ BEFORE CHANGING:
 * The build brief specified `@tryvital/vital-node`. Junction's live docs no longer
 * reference that package anywhere; the current TypeScript/Node client is
 * `@junction-api/sdk` (v1.2.0, published 2026-06-05 vs vital-node's 2026-01-14).
 * `JunctionEnvironment.Sandbox` resolves to https://api.sandbox.us.junction.com —
 * exactly the base URL the brief asked for. Verified present on this SDK:
 *   client.user.create({ clientUserId })      -> ClientFacingUser
 *   client.link.token({ userId })             -> { linkToken, linkWebUrl }
 *   client.vitals.heartrate({ userId, startDate, endDate })
 *                                             -> ClientFacingHeartRateTimeseries[]
 * The SDK camelCases its inputs/outputs; the raw webhook JSON is still snake_case.
 */

import crypto from 'node:crypto';
import { JunctionClient, JunctionEnvironment } from '@junction-api/sdk';
import { upsertFriend, pushReading, getFriend, ingestHistory } from './store.js';

// ---------------------------------------------------------------------------
// CLIENT
// ---------------------------------------------------------------------------

let client = null;

/**
 * Region/env come from config, but the SDK folds both into a single enum member
 * (there is no separate `region` option — Sandbox *is* the us sandbox).
 */
function resolveEnvironment(env, region) {
  const key = `${env}:${region}`.toLowerCase();
  switch (key) {
    case 'sandbox:us': return JunctionEnvironment.Sandbox;
    case 'sandbox:eu': return JunctionEnvironment.SandboxEu;
    case 'production:us': return JunctionEnvironment.Production;
    case 'production:eu': return JunctionEnvironment.ProductionEu;
    default:
      throw new Error(`Unsupported VITAL_ENV/VITAL_REGION combo: ${env}/${region}`);
  }
}

export function initJunction({ apiKey, env = 'sandbox', region = 'us' }) {
  if (!apiKey) return null; // demo mode can run with no key at all
  client = new JunctionClient({ apiKey, environment: resolveEnvironment(env, region) });
  return client;
}

export function getClient() {
  if (!client) {
    throw new Error('Junction client not initialised — set VITAL_API_KEY in .env');
  }
  return client;
}

/** Junction provider slug -> our short device name (drives the UI chip colour). */
const PROVIDER_TO_DEVICE = {
  whoop: 'whoop',
  whoop_v2: 'whoop',
  fitbit: 'fitbit',
  apple_health_kit: 'apple', // the enum's real slug; the brief called it APPLE_HEALTH
  apple_health: 'apple',
};

export function providerToDevice(provider) {
  if (!provider) return 'pending';
  return PROVIDER_TO_DEVICE[String(provider).toLowerCase()] ?? String(provider).toLowerCase();
}

/**
 * Providers offered in the Link widget.
 *
 * ONLY CLOUD/OAUTH PROVIDERS CAN GO HERE. Junction splits providers into two
 * kinds and it is not a detail you can paper over:
 *
 *   - OAuth/cloud (fitbit, whoop) — the provider has a REST API Junction polls.
 *     Connectable from a web browser. These work.
 *   - SDK-based (apple_health_kit, health_connect, samsung_health) — the data
 *     lives ON THE DEVICE with no cloud API. Junction reads it only via their
 *     native iOS/Android SDK inside YOUR OWN app.
 *
 * The brief asked for Apple Watch, but `apple_health_kit` is SDK-based: it will
 * happily mint a Link token and then never complete in a browser. Supporting it
 * means shipping a native app with the Junction Health SDK, which is a different
 * product, not a config flag. It is deliberately NOT listed here — showing a
 * device in the widget that can never connect is worse than omitting it.
 *
 * `whoop_v2` is the current WHOOP slug (plain `whoop` is the legacy one); both
 * are listed so an already-linked legacy connection keeps working.
 */
export const ALLOWED_PROVIDERS = ['whoop_v2', 'whoop', 'fitbit'];

// ---------------------------------------------------------------------------
// REGISTRATION
// ---------------------------------------------------------------------------

const slugify = (name) =>
  name.toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'friend';

/**
 * Create a Junction user + a Link token for them.
 *
 * clientUserId must be unique per team. Two friends both called "Dev" would
 * collide, so we suffix a short random tag. If the user already exists Junction
 * 409s — we recover by looking them up, which makes re-registration idempotent
 * instead of a dead end mid-party.
 */
export async function createUserAndLink(name, provider, redirectUrl) {
  const c = getClient();
  const clientUserId = `${slugify(name)}-${crypto.randomBytes(3).toString('hex')}`;

  let vitalUserId;
  try {
    const user = await c.user.create({ clientUserId });
    vitalUserId = user.userId ?? user.userid ?? user.id;
  } catch (err) {
    // Conflict -> the slug is taken; resolve it rather than failing the friend.
    const existing = await c.user.getByClientUserId(clientUserId).catch(() => null);
    if (!existing) throw err;
    vitalUserId = existing.userId ?? existing.id;
  }

  if (!vitalUserId) throw new Error('Junction did not return a user id');

  const linkWebUrl = await createLinkToken(vitalUserId, provider, redirectUrl);
  return { vitalUserId, clientUserId, linkWebUrl };
}

/**
 * Mint a fresh Link URL for an existing user.
 *
 * Called on every tap of a /j/<code> short link. Junction's link tokens are
 * ~900-char JWTs that expire after 60 MINUTES, so we never store or share one —
 * we generate it at the moment the friend opens their link.
 *
 * @param {string} vitalUserId
 * @param {string} [provider] pin the link to one provider — Junction then skips its
 *   own picker and redirects straight into that provider's OAuth. Omit to let the
 *   friend choose from ALLOWED_PROVIDERS in the widget.
 * @param {string} [redirectUrl] absolute URL to land on after authorising. Without
 *   it the friend finishes OAuth and is dumped on Junction's own end screen with
 *   no way back to the party — they've connected and have no idea if it worked.
 */
export async function createLinkToken(vitalUserId, provider, redirectUrl) {
  const c = getClient();
  const usable = provider && ALLOWED_PROVIDERS.includes(provider) ? provider : null;
  const link = await c.link.token({
    userId: vitalUserId,
    // Junction accepts a link token for SDK-only providers (apple_health_kit,
    // health_connect) and then never completes in a browser — so a caller-supplied
    // provider is checked against the allowlist, never passed through raw.
    ...(usable ? { provider: usable } : { filterOnProviders: ALLOWED_PROVIDERS }),
    ...(redirectUrl
      ? {
          redirectUrl,
          // Send failures and closes to the same page rather than leaving a dead
          // tab. Junction appends error params, which /joined reads and explains.
          onError: 'redirect',
          onClose: 'redirect',
        }
      : {}),
  });
  // linkWebUrl is returned fully-formed by the API — do not hand-build this URL.
  return link.linkWebUrl;
}

// ---------------------------------------------------------------------------
// WEBHOOK SIGNATURE VERIFICATION  (tweak here)
// ---------------------------------------------------------------------------
//
// Junction signs webhooks with Svix. Rather than pull in the Svix SDK we verify
// the scheme directly — it is ~15 lines and keeps the dependency list minimal.
// (This implementation is cross-checked byte-for-byte against the official Svix
// SDK's output; see scripts/verify-signature-impl.js.)
//
// Scheme:
//   signedContent = `${svix-id}.${svix-timestamp}.${rawBody}`
//   expected      = base64(HMAC_SHA256(base64decode(secret without 'whsec_'), signedContent))
//   svix-signature = space-separated list of `v1,<sig>` — match ANY of them
//                    (a list appears during secret rotation)
//
// The raw body bytes matter: JSON.parse -> JSON.stringify will not round-trip to
// identical bytes, so index.js gives us the exact Buffer express received.

const SVIX_TOLERANCE_SECONDS = 5 * 60;

/**
 * @param {Buffer|string} rawBody exact bytes as received
 * @param {Record<string,string>} headers
 * @param {string} secret  the `whsec_...` signing secret
 * @returns {{ok: true} | {ok: false, reason: string}}
 */
export function verifyWebhookSignature(rawBody, headers, secret) {
  if (!secret) return { ok: false, reason: 'VITAL_WEBHOOK_SECRET is not set' };

  const id = headers['svix-id'];
  const timestamp = headers['svix-timestamp'];
  const signature = headers['svix-signature'];
  if (!id || !timestamp || !signature) {
    return { ok: false, reason: 'missing svix-id / svix-timestamp / svix-signature' };
  }

  // Replay guard: reject stamps outside a 5-minute window either side.
  const ts = Number(timestamp);
  if (!Number.isFinite(ts)) return { ok: false, reason: 'svix-timestamp is not a number' };
  const drift = Math.abs(Date.now() / 1000 - ts);
  if (drift > SVIX_TOLERANCE_SECONDS) {
    return { ok: false, reason: `svix-timestamp outside tolerance (${Math.round(drift)}s)` };
  }

  // `whsec_` prefix is optional in the dashboard copy-paste; tolerate both.
  const key = Buffer.from(secret.replace(/^whsec_/, ''), 'base64');
  const body = Buffer.isBuffer(rawBody) ? rawBody.toString('utf8') : String(rawBody);
  const signedContent = `${id}.${timestamp}.${body}`;
  const expected = crypto.createHmac('sha256', key).update(signedContent).digest('base64');

  // The header may carry several versioned sigs: "v1,abc v1,def".
  for (const part of signature.split(' ')) {
    const [version, sig] = part.split(',');
    if (version !== 'v1' || !sig) continue;
    if (timingSafeEqual(sig, expected)) return { ok: true };
  }
  return { ok: false, reason: 'no matching v1 signature' };
}

/** Constant-time compare that tolerates length mismatches without throwing. */
function timingSafeEqual(a, b) {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

// ---------------------------------------------------------------------------
// HEART-RATE EXTRACTION  (tweak here)
// ---------------------------------------------------------------------------
//
// Junction's event envelope (snake_case on the wire):
//   { event_type, data: {...}, user_id, client_user_id, team_id }
//
// For TIMESERIES types (heart rate is one) the samples nest one level deeper —
// they live at $.data.data as an array of { timestamp, value, unit }. For SUMMARY
// types the object sits directly at $.data. We accept several shapes because
// providers differ and it is cheaper to be liberal here than to drop a real
// reading mid-match: a missed sample is a friend frozen on the TV.

/** Pull the sample array out of whatever shape the event arrived in. */
function extractSamples(payload) {
  const d = payload?.data;
  if (Array.isArray(d?.data)) return d.data;   // timeseries: $.data.data  <- the normal path
  if (Array.isArray(d)) return d;              // some events put samples at $.data
  if (Array.isArray(payload?.heart_rate)) return payload.heart_rate;
  if (d && typeof d === 'object' && (d.value ?? d.bpm) != null) return [d]; // single sample
  return [];
}

/**
 * Find the MOST RECENT heart-rate sample in a webhook payload.
 * @returns {{heartRate:number, timestamp:string|number|Date}|null}
 */
export function extractLatestHeartRate(payload) {
  const samples = extractSamples(payload);
  if (!samples.length) return null;

  let best = null;
  let bestAt = -Infinity;

  for (const s of samples) {
    // `value` is Junction's field; `bpm`/`heart_rate` are defensive fallbacks.
    const hr = Number(s?.value ?? s?.bpm ?? s?.heart_rate);
    if (!Number.isFinite(hr) || hr <= 0) continue;

    // Unit sanity: if the event declares a non-bpm unit it is not a heart rate.
    const unit = (s?.unit ?? '').toString().toLowerCase();
    if (unit && unit !== 'bpm') continue;

    const raw = s?.timestamp ?? s?.time ?? s?.start ?? s?.end;
    const at = raw ? new Date(raw).getTime() : Date.now();
    if (!Number.isFinite(at)) continue;

    if (at > bestAt) {
      bestAt = at;
      best = { heartRate: Math.round(hr), timestamp: raw ?? new Date(at).toISOString() };
    }
  }
  return best;
}

/** True for any event carrying heart-rate samples. */
function isHeartRateEvent(eventType = '') {
  return /heart_?rate/i.test(eventType) && !/alert|variability|hrv|recovery/i.test(eventType);
}

/** True for provider connection / auth lifecycle events. */
function isConnectionEvent(eventType = '') {
  return /provider\.connection|auth|connected/i.test(eventType);
}

/**
 * Handle one verified webhook event. Never throws — the caller must always 200
 * fast, because Junction retries with exponential backoff and a slow or erroring
 * endpoint gets throttled.
 *
 * @returns {{handled:string, detail?:any}}
 */
export function handleWebhookEvent(payload) {
  const eventType = payload?.event_type ?? payload?.eventType ?? '';
  const userId = payload?.user_id ?? payload?.userId;
  if (!userId) return { handled: 'ignored', detail: 'no user_id' };

  // --- Provider connected: finalise the friend and set their device chip. ---
  if (isConnectionEvent(eventType)) {
    const provider =
      payload?.data?.provider ??
      payload?.data?.source?.provider ??
      payload?.data?.source_slug ??
      payload?.provider;

    const device = providerToDevice(provider);
    if (getFriend(userId)) {
      upsertFriend({ vitalUserId: userId, device });
      return { handled: 'connected', detail: { userId, device } };
    }
    // Connected before registering at /admin — nothing to attach it to yet.
    return { handled: 'ignored', detail: 'unknown user connected' };
  }

  // --- Data event: pull the newest HR sample and push it. ---
  if (isHeartRateEvent(eventType)) {
    const sample = extractLatestHeartRate(payload);
    if (!sample) return { handled: 'ignored', detail: 'no HR in payload' };

    const ok = pushReading(userId, sample.heartRate, sample.timestamp);
    return ok
      ? { handled: 'reading', detail: { userId, hr: sample.heartRate } }
      : { handled: 'ignored', detail: 'unknown user or bad reading' };
  }

  return { handled: 'ignored', detail: `unhandled event_type: ${eventType}` };
}

// ---------------------------------------------------------------------------
// HR POLLING FALLBACK
// ---------------------------------------------------------------------------

/**
 * Optional per-user poll of the heart-rate timeseries.
 *
 * Webhooks are primary, but provider sync cadence is unpredictable — if a friend's
 * watch batches for minutes, their card freezes. This backstop asks Junction
 * directly every ~60s so the board still moves.
 *
 * IT MUST NOT DEPEND ON WEBHOOKS. An earlier version skipped friends whose device
 * was still `pending`, but `device` is only set BY the connection webhook — so
 * running without a public webhook URL (any local run without ngrok) meant the
 * fallback skipped everyone forever and the board stayed empty even though the
 * heart rate was sitting in Junction, queryable. A fallback that needs the thing
 * it is a fallback for is not a fallback. We now poll every friend and resolve
 * the device ourselves.
 *
 * Deliberately quiet: a failing poll logs and moves on. It must never take the
 * party down.
 */
export function startHeartRatePolling({ intervalMs = 60_000, friendsFn }) {
  const timer = setInterval(() => pollOnce(friendsFn(), { autoRefresh: true }), intervalMs);
  timer.unref?.();
  return timer;
}

/**
 * How often to ask Junction to go re-pull from the provider.
 *
 * Not every poll: refresh() is heavy (Junction calls Fitbit synchronously — measured
 * ~6s) and pointless at 60s intervals, because the phone→cloud hop upstream only
 * moves every ~15 min. Refreshing faster than the data can change is just load.
 * 3 min is comfortably inside that window while staying cheap.
 */
const REFRESH_EVERY_MS = 180_000;

/**
 * How far back to ask for heart rate.
 *
 * Deliberately NOT wider. A stale reading must never reach the live board — a
 * 32-hour-old bpm is not someone's current heart rate, and showing it would be
 * worse than showing nothing. The dashboard reports the silence instead.
 */
export const HR_WINDOW_HOURS = 6;

/** vitalUserId -> epoch ms of last refresh() we issued. */
const lastRefreshAt = new Map();

/**
 * One pass over the given friends: refresh if due, resolve device if unknown,
 * pull latest HR.
 *
 * `autoRefresh` is what means NOBODY EVER TOUCHES A TERMINAL. The server asks
 * Junction to re-pull on its own cadence; friends only ever open their health app.
 * /api/resync calls this with force:true to refresh everyone immediately.
 */
export async function pollOnce(friends, { autoRefresh = false, force = false } = {}) {
  if (!client) return { polled: 0, updated: 0, refreshed: 0 };

  // Recent window only — a watch party does not span dates, and a narrow
  // window keeps the response small.
  const startDate = new Date(Date.now() - HR_WINDOW_HOURS * 3600_000).toISOString();
  let updated = 0;
  let refreshed = 0;

  // --- Phase 1: refresh everyone who's due, ALL AT ONCE, and wait. ---
  //
  // These must complete BEFORE we read, or the read below returns the pre-refresh
  // sample and the fresh one sits unseen until the next tick — up to 60s of lag
  // we simply gave away. Refreshes run in parallel (each takes ~6s serially, so a
  // room of 6 would blow past the poll interval otherwise) and failures are
  // ignored: a refresh that didn't land just means we read slightly older data.
  // Deliberately NOT gated on `device !== 'pending'`: device is resolved down in
  // phase 2, so gating here would skip every freshly-registered friend on the very
  // pass where a refresh matters most — the same "gated on state that isn't set
  // yet" bug that once left the whole board empty. A refresh for an unconnected
  // user just rejects, and allSettled swallows it. Cheap to be wrong here.
  const due = friends.filter((f) => {
    if (!(autoRefresh || force)) return false;
    const last = lastRefreshAt.get(f.vitalUserId) ?? 0;
    return force || Date.now() - last > REFRESH_EVERY_MS;
  });

  if (due.length) {
    for (const f of due) lastRefreshAt.set(f.vitalUserId, Date.now());
    await Promise.allSettled(due.map((f) => refreshUser(f.vitalUserId)));
    refreshed = due.length;
  }

  // --- Phase 2: read. ---
  for (const friend of friends) {
    try {
      // If we never saw a connection webhook, ask Junction who they connected.
      if (friend.device === 'pending') {
        const device = await resolveDevice(friend.vitalUserId);
        if (device) upsertFriend({ vitalUserId: friend.vitalUserId, device });
      }

      const series = await client.vitals.heartrate({ userId: friend.vitalUserId, startDate });
      // The endpoint returns timeseries entries; flatten whatever comes back.
      const samples = (Array.isArray(series) ? series : []).flatMap((s) =>
        Array.isArray(s?.data) ? s.data : [s],
      );

      // Keep the WHOLE window, not just the newest sample — this is the trend
      // line. Junction hands back ~6h of 1-minute samples on every call and we
      // used to bin all but one of them.
      ingestHistory(
        friend.vitalUserId,
        samples.map((s) => ({ heartRate: Number(s?.value), timestamp: s?.timestamp })),
      );

      const latest = extractLatestHeartRate({ data: { data: samples } });
      if (latest && pushReading(friend.vitalUserId, latest.heartRate, latest.timestamp)) {
        updated++;
        // Log the AGE of the sample, not just the value — age is the only number
        // that tells you whether the phone→cloud hop is moving. A bpm that never
        // changes looks identical to a bpm that's frozen.
        const ageS = Math.max(0, Math.round((Date.now() - new Date(latest.timestamp)) / 1000));
        console.log(`[poll] ${friend.name}: ${latest.heartRate}bpm (sample ${ageS}s old)`);
      }
    } catch (err) {
      console.warn(`[poll] ${friend.name}: ${err?.message ?? err}`);
    }
  }
  if (refreshed) console.log(`[poll] nudged Junction to re-pull for ${refreshed} friend(s)`);
  return { polled: friends.length, updated, refreshed };
}

/**
 * Ask Junction to go re-pull from the provider right now, rather than waiting for
 * its own schedule.
 *
 * IMPORTANT — this only refreshes the JUNCTION←FITBIT-CLOUD hop. It cannot reach
 * the watch. The chain is:
 *
 *   Air --BLE--> phone --~15min timer--> Fitbit cloud --refresh()--> Junction --poll--> us
 *                        ^^^^^^^^^^^^^^^
 *                        the real bottleneck; only opening the Google Health
 *                        app on the phone forces THAT hop.
 *
 * So refreshing without opening the app on the phone just re-fetches the same
 * stale sample. Both halves are needed.
 */
export async function refreshUser(vitalUserId) {
  const c = getClient();
  // Junction's refresh can legitimately take a while — it's calling Fitbit live.
  return c.user.refresh({ userId: vitalUserId, timeout: 30 });
}

/**
 * Ask Junction which provider a user actually connected.
 * Returns our short device name, or null if nothing is connected yet.
 */
async function resolveDevice(vitalUserId) {
  try {
    // NOTE: takes a request OBJECT — getConnectedProviders(userId) 400s with
    // "user_id is malformed or missing".
    const res = await client.user.getConnectedProviders({ userId: vitalUserId });
    // Response is Record<string, ClientFacingProviderWithStatus[]> — dig out any
    // entry that is actually connected rather than erroring.
    const entries = Object.values(res ?? {}).flat();
    const live = entries.find((p) => p?.slug && p?.status !== 'error') ?? entries[0];
    return live?.slug ? providerToDevice(live.slug) : null;
  } catch {
    return null; // not connected yet, or the endpoint is unhappy — try again next tick
  }
}
