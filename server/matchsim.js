/**
 * MATCH_SIM — the real England v Argentina 2026 World Cup semifinal, replayed.
 *
 * Unlike demo.js (which wanders randomly), every heartbeat here is driven by the
 * commentary timeline and each person's ALLEGIANCE. An England fan's pulse climbs
 * when Messi has the ball; an Argentina fan's climbs when England threaten. That's
 * the whole point of the product, made legible in 94 seconds.
 *
 * The timeline is TRANSCRIBED, not invented: The Hindu's live blog, curated from 90
 * timestamped entries. Real result — Gordon put England ahead on 54:24, then
 * Argentina won it late through Enzo Fernández (84:54) and Lautaro Martínez
 * (91:28), both assisted by Messi. Argentina 2-1, into the final against Spain.
 *
 * Nothing here runs unless MATCH_SIM=true, and it never touches the persisted
 * roster (see enablePersistence in store.js).
 */

import { upsertFriend, pushReading } from './store.js';

const TICK_MS = 500;

/** Allegiance decides which events frighten you. */
const ARG = 'ARG';
const ENG = 'ENG';

/**
 * The room. Ages/resting rates are deliberately varied so the Karvonen score has
 * something to prove: Nikhil's 58bpm resting vs Ishaan's 72 means raw bpm would
 * rank them by fitness, not by nerve.
 */
/**
 * `lag` and `attention` are what stop this looking fake.
 *
 * Without them all four hearts jolt on the same tick with the same white noise, so
 * the trend chart draws four parallel sawtooths — obviously machine-made. Real
 * people see the same moment a beat apart (one is looking at their phone), and
 * nobody reacts to every throw-in. `lag` = seconds before the jolt lands;
 * `attention` = probability they even notice a MINOR event (goals always land).
 * `settle` = how fast they come back down — some people stay wound up.
 */
const SEED = [
  { vitalUserId: 'sim-kabir',     name: 'Kabir',     device: 'fitbit', age: 30, restingHR: 48, side: ARG, jumpiness: 1.10, lag: 0.6, attention: 0.95, settle: 0.030 },
  { vitalUserId: 'sim-tara',      name: 'Tara',      device: 'fitbit', age: 27, restingHR: 60, side: ARG, jumpiness: 0.88, lag: 2.4, attention: 0.72, settle: 0.042 },
  { vitalUserId: 'sim-nikhil',    name: 'Nikhil',    device: 'whoop',  age: 26, restingHR: 58, side: ENG, jumpiness: 1.12, lag: 0.3, attention: 0.98, settle: 0.022 },
  { vitalUserId: 'sim-ishaan',    name: 'Ishaan',    device: 'apple',  age: 34, restingHR: 72, side: ENG, jumpiness: 0.90, lag: 1.5, attention: 0.85, settle: 0.036 },
];

/**
 * The real match, to the 75th minute.
 *
 * Transcribed from The Hindu's live blog of the England v Argentina 2026 World Cup
 * semifinal (`at` = the actual match minute). Curated from 83 timestamped entries —
 * every free kick and throw-in would be noise; these are the moments that move a
 * pulse.
 *
 * NOTE: the brief assumed an England penalty. There wasn't one. England won it
 * through Gordon on 54:24, and Argentina's agony was Mac Allister hitting the post
 * on 75:02. Kabir's spikes are driven by England's REAL chances instead.
 *
 * `arg`/`eng` are the arousal jolt (0–1) for a fan of that side, and the ASYMMETRY
 * is the whole point: a chance AGAINST your team is terror, the same chance FOR
 * your team is only hope. Terror beats hope, every time — so an England chance
 * must move an Argentina fan more than an England one. Only a goal maxes both
 * ends of the room, and even then one of them is celebrating.
 */
const TIMELINE = [
  { at: 0,  text: 'Kick-off — England v Argentina, World Cup semifinal.',                   arg: 0.10, eng: 0.10 },
  { at: 6,  text: "6' Corner to England, conceded by Mac Allister.",                        arg: 0.34, eng: 0.20 },
  { at: 20, text: "20' Messi is caught offside. Groans all round.",                         arg: 0.24, eng: 0.18 },
  { at: 23, text: "23' Corner to Argentina, conceded by Spence.",                           arg: 0.26, eng: 0.44 },
  { at: 32, text: "32' Stones header from the centre — CLOSE! Just wide.",                  arg: 0.72, eng: 0.46 },
  { at: 36, text: "36' Reece James goes for goal — Martínez spills it, scramble in the box!",arg: 0.78, eng: 0.52 },
  { at: 37, text: "37' MESSI, left foot from outside the box — BLOCKED!",                   arg: 0.50, eng: 0.86 },
  { at: 38, text: "38' Enzo Fernández fizzes one just over the bar.",                       arg: 0.44, eng: 0.74 },
  { at: 41, text: "41' Yellow card — Lisandro Martínez, bad foul.",                         arg: 0.40, eng: 0.22 },
  { at: 46, text: "46' Álvarez shot from the right — SAVED by Pickford!",                   arg: 0.48, eng: 0.84 },
  { at: 48, text: "48' Corner to England, conceded by Enzo.",                               arg: 0.46, eng: 0.26 },
  { at: 51, text: "51' Yellow card — Romero. Argentina rattled.",                           arg: 0.38, eng: 0.20 },
  { at: 54, text: "54' GOAL!! Anthony Gordon, close range — ENGLAND 1-0 ARGENTINA!",        arg: 1.00, eng: 0.96 },
  { at: 57, text: "57' Corner to Argentina. They need a response.",                         arg: 0.40, eng: 0.56 },
  { at: 60, text: "60' Enzo Fernández from distance — too high.",                           arg: 0.36, eng: 0.60 },
  { at: 65, text: "65' Rice shot saved, then Kane's effort blocked. England pushing.",      arg: 0.82, eng: 0.44 },
  { at: 67, text: "67' Two Argentina corners back to back. England hanging on.",            arg: 0.42, eng: 0.74 },
  { at: 68, text: "68' Nico González header — PICKFORD SAVES IT!",                          arg: 0.54, eng: 0.90 },
  { at: 71, text: "71' Gordon comes off. The goalscorer gets a standing ovation.",          arg: 0.24, eng: 0.30 },
  { at: 75, text: "75' MAC ALLISTER HITS THE POST!! Inches from 1-1!",                      arg: 0.92, eng: 1.00 },
  { at: 78, text: "78' Rogers shot blocked. England trying to kill the clock.",             arg: 0.50, eng: 0.44 },
  { at: 81, text: "81' Lautaro Martínez is coming on. Argentina throwing everything at it.",arg: 0.56, eng: 0.66 },
  { at: 85, text: "85' GOAL!! ENZO FERNÁNDEZ, outside the box, Messi the assist — 1-1!!",   arg: 0.98, eng: 1.00 },
  { at: 88, text: "88' Argentina scent blood. England are hanging on.",                     arg: 0.62, eng: 0.88 },
  { at: 91, text: "91' GOAL!!! LAUTARO MARTÍNEZ header, Messi again — ARGENTINA LEAD 2-1!!",arg: 1.00, eng: 1.00 },
  { at: 93, text: "FULL TIME. Argentina win 2-1 and go through to the final.",              arg: 0.70, eng: 0.90 },
];

/**
 * Playback: 1 match-minute per second, so 75 minutes runs in 75 seconds. Set
 * MATCH_SPEED to change (e.g. 0.5 = half speed, 2 = twice as fast).
 */
const SPEED = Number(process.env.MATCH_SPEED) || 1;
const MATCH_SECONDS = 94;

/**
 * The real scoreline, by match minute. Gordon put England ahead on 54; Argentina
 * won it late through Enzo Fernández (84:54) and Lautaro Martínez (91:28), both
 * assisted by Messi. Final: Argentina 2-1.
 */
const GOALS = [
  { at: 54, side: ENG },
  { at: 85, side: ARG },
  { at: 91, side: ARG },
];

/** @type {Map<string, {trueHR:number, arousal:number}>} */
const sim = new Map();
let timer = null;
let startedAt = 0;
let fired = new Set();
/** @type {{at:number,text:string}|null} */
let lastEvent = null;

const ease = (cur, target, rate) => cur + (target - cur) * rate;
const rand = (a, b) => a + Math.random() * (b - a);

export function startMatchSim() {
  if (timer) return;
  for (const s of SEED) {
    upsertFriend({
      vitalUserId: s.vitalUserId,
      name: s.name,
      device: s.device,
      age: s.age,
      restingHR: s.restingHR,
    });
    sim.set(s.vitalUserId, {
      trueHR: s.restingHR + rand(2, 8),
      arousal: 0.08,
      nextPushAt: 0,
      noise: 0,               // AR(1) wander — see tick()
      breath: rand(0, 6.28),  // each person's breathing starts out of phase
      pending: [],            // jolts waiting out this person's reaction lag
    });
  }
  startedAt = Date.now();
  fired = new Set();
  lastEvent = null;
  timer = setInterval(tick, TICK_MS);
  timer.unref?.();
  console.log(`[matchsim] England v Argentina (real 2026 semifinal commentary) — 75 match-mins in ${Math.round(MATCH_SECONDS/SPEED)}s, ${SEED.length} fans`);
}

export function stopMatchSim() {
  if (timer) clearInterval(timer);
  timer = null;
  sim.clear();
}

/** Restart the clip from 0 without touching the friends' profiles. */
export function restartMatchSim() {
  startedAt = Date.now();
  fired = new Set();
  lastEvent = null;
  for (const [, s] of sim) s.arousal = 0.08;
  return { ok: true };
}

function tick() {
  const now = Date.now();
  // Elapsed wall-clock seconds -> match minutes (1 min per second at SPEED 1).
  const t = ((now - startedAt) / 1000) * SPEED;

  // Queue any event whose moment has passed, per person, behind their own lag.
  for (const ev of TIMELINE) {
    if (t >= ev.at && !fired.has(ev.at)) {
      fired.add(ev.at);
      lastEvent = ev;
      const major = /GOAL!!|POST!!|SAVES IT|FULL TIME/.test(ev.text);
      for (const seed of SEED) {
        const s = sim.get(seed.vitalUserId);
        if (!s) continue;
        // Nobody reacts to every throw-in. Goals and near-misses always land;
        // minor events only if they were paying attention.
        if (!major && Math.random() > seed.attention) continue;
        const jolt = (seed.side === ARG ? ev.arg : ev.eng) * seed.jumpiness;
        // Land it after this person's own reaction lag, jittered — four hearts
        // jolting on the exact same tick is the single biggest tell.
        s.pending.push({ at: now + (seed.lag + rand(-0.2, 0.5)) * 1000, jolt });
      }
      console.log(`[matchsim] ${ev.text}`);
    }
  }

  for (const seed of SEED) {
    const s = sim.get(seed.vitalUserId);
    if (!s) continue;

    // Apply any jolt whose lag has elapsed. Take the bigger of current/jolt rather
    // than adding: a jolt sets a floor for how rattled you are, it doesn't stack
    // into >1 nonsense.
    s.pending = s.pending.filter((p) => {
      if (now < p.at) return true;
      s.arousal = Math.min(1, Math.max(s.arousal, p.jolt));
      return false;
    });

    // Arousal bleeds off at this person's own rate — a heart settles, it doesn't
    // stay pinned, and not everyone settles equally fast.
    s.arousal = Math.max(0.05, s.arousal - seed.settle);

    // Map arousal across THIS person's own reserve, so the sim speaks the same
    // language as the Karvonen score: 1.0 means ~90% of your personal headroom,
    // not "190bpm".
    const maxHR = 220 - seed.age;
    const reserve = maxHR - seed.restingHR;
    const target = seed.restingHR + reserve * s.arousal * 0.9;

    // Hearts climb fast and settle slow.
    const rate = target > s.trueHR ? 0.10 : 0.035;

    // Noise that looks like a heart, not a random number generator:
    //  - AR(1) wander: each sample leans on the last, so it drifts instead of
    //    sawtoothing. Per-tick white noise is what made the chart look fake.
    //  - a slow sine for respiratory sinus arrhythmia — real HR breathes.
    s.noise = s.noise * 0.86 + rand(-0.55, 0.55);
    s.breath += 0.16;
    const wobble = s.noise * 2.2 + Math.sin(s.breath) * (1.1 + reserve * s.arousal * 0.012);

    s.trueHR = Math.max(seed.restingHR - 2, ease(s.trueHR, target, rate) + wobble);

    // Push on a 1–2s cadence. Real watches batch for minutes, but this is a
    // 75-second clip for recording — a realistic sync lag would mean the board
    // barely moved before the whistle.
    if (now >= s.nextPushAt) {
      pushReading(seed.vitalUserId, Math.round(s.trueHR), new Date(now));
      // Stagger the cadence per person too — four watches reporting in perfect
      // lockstep every 1.5s reads as machine-made even when the curve is right.
      s.nextPushAt = now + rand(900, 2600);
    }
  }
}

/** Live match state for the board's commentary strip. */
export function matchState() {
  if (!timer) return { running: false };
  const t = ((Date.now() - startedAt) / 1000) * SPEED;
  const next = TIMELINE.find((e) => e.at > t);
  const scored = GOALS.filter((g) => g.at <= t);
  return {
    running: true,
    minute: Math.min(MATCH_SECONDS, Math.floor(t)),   // MATCH minute, not wall seconds
    total: MATCH_SECONDS,
    finished: t >= MATCH_SECONDS,
    commentary: lastEvent?.text ?? 'Kick-off imminent…',
    commentaryAt: lastEvent?.at ?? 0,
    nextAt: next?.at ?? null,
    score: {
      eng: scored.filter((g) => g.side === ENG).length,
      arg: scored.filter((g) => g.side === ARG).length,
    },
    sides: Object.fromEntries(SEED.map((s) => [s.name, s.side])),
  };
}

export function isMatchSimRunning() {
  return timer !== null;
}

export { SEED as MATCH_FANS };
