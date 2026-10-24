/**
 * DEMO_MODE simulator — lets you verify the whole app with zero real devices.
 *
 * Nothing in this file runs unless DEMO_MODE=true. When it's false the board is
 * driven exclusively by real Junction data.
 *
 * The important trick: the simulator keeps its own *true* heart rate that eases
 * every 500ms, but only PUSHES that value into the store every 3-8s (staggered
 * per friend). Real wearables batch-sync — they do not stream — so this
 * reproduces the sync lag the UI has to cope with, which is what makes the
 * "synced Xs ago" readout meaningful rather than decorative.
 */

import { upsertFriend, pushReading } from './store.js';

const TICK_MS = 500;

/** Six friends with deliberately varied fitness, so Karvonen has something to prove. */
const SEED = [
  { vitalUserId: 'demo-1', name: 'Arjun',  device: 'whoop',  age: 28, restingHR: 52 },
  { vitalUserId: 'demo-2', name: 'Priya',  device: 'fitbit', age: 34, restingHR: 65 },
  { vitalUserId: 'demo-3', name: 'Dev',    device: 'apple',  age: 41, restingHR: 71 },
  { vitalUserId: 'demo-4', name: 'Meera',  device: 'whoop',  age: 25, restingHR: 48 },
  { vitalUserId: 'demo-5', name: 'Rohan',  device: 'fitbit', age: 37, restingHR: 68 },
  { vitalUserId: 'demo-6', name: 'Sana',   device: 'apple',  age: 30, restingHR: 58 },
];

/** @type {Map<string, {trueHR:number, arousal:number, jumpiness:number, nextPushAt:number}>} */
const sim = new Map();
let timer = null;

/**
 * Ease a value toward a target. Rate is the fraction of the gap closed per tick,
 * which gives a natural exponential approach instead of a robotic linear ramp.
 */
const ease = (current, target, rate) => current + (target - current) * rate;

const rand = (min, max) => min + Math.random() * (max - min);

export function startDemo() {
  if (timer) return;

  for (const s of SEED) {
    upsertFriend(s);
    sim.set(s.vitalUserId, {
      trueHR: s.restingHR + rand(2, 10),
      // Baseline arousal: everyone starts mildly invested in the match.
      arousal: rand(0.05, 0.25),
      // Jumpiness = how hard this person reacts to a goal. Some friends are
      // simply more dramatic, which keeps the board from moving in lockstep.
      jumpiness: rand(0.6, 1.4),
      nextPushAt: Date.now() + rand(0, 4000),
    });
  }

  timer = setInterval(tick, TICK_MS);
  timer.unref?.(); // never hold the process open on this alone
  console.log(`[demo] simulating ${SEED.length} friends — POST /api/demo/goal to spike them`);
}

export function stopDemo() {
  if (timer) clearInterval(timer);
  timer = null;
  sim.clear();
}

function tick() {
  const now = Date.now();

  for (const seed of SEED) {
    const s = sim.get(seed.vitalUserId);
    if (!s) continue;

    // 1. Arousal decays toward a restless baseline, with a little random drift
    //    so the board keeps shuffling gently even with no goal.
    s.arousal = ease(s.arousal, rand(0.05, 0.2), 0.01);
    s.arousal = Math.min(1, Math.max(0, s.arousal + rand(-0.02, 0.02)));

    // 2. Target HR maps arousal across this friend's own reserve, so the
    //    simulator speaks the same language as the Karvonen score: arousal 1.0
    //    means "at ~90% of your personal reserve", not "at 190bpm".
    const maxHR = 220 - seed.age;
    const reserve = maxHR - seed.restingHR;
    const targetHR = seed.restingHR + reserve * s.arousal * 0.9;

    // 3. Ease the true HR toward target, plus beat-to-beat noise. Hearts have
    //    inertia — they climb fast and settle slow.
    const rate = targetHR > s.trueHR ? 0.08 : 0.03;
    s.trueHR = ease(s.trueHR, targetHR, rate) + rand(-0.8, 0.8);
    s.trueHR = Math.max(seed.restingHR - 3, s.trueHR);

    // 4. Push on a staggered 3-8s cadence — this is the fake "device sync".
    if (now >= s.nextPushAt) {
      pushReading(seed.vitalUserId, Math.round(s.trueHR), new Date(now));
      s.nextPushAt = now + rand(3000, 8000);
    }
  }
}

/**
 * ⚽ GOAL. Spikes everyone's arousal, scaled by their personal jumpiness.
 * The board reshuffles within a few seconds — not instantly, because each
 * friend still has to wait for their next simulated sync.
 */
export function triggerGoal() {
  for (const s of sim.values()) {
    s.arousal = Math.min(1, s.arousal + rand(0.45, 0.75) * s.jumpiness);
  }
  console.log('[demo] ⚽ GOAL — arousal spiked');
  return { friends: sim.size };
}

export function isDemoRunning() {
  return timer !== null;
}
