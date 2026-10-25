// Queue order. A priority only orders the queue: nobody is ever pushed out of a lock they hold.
//   effective = base priority (by holder kind, or the waiter's own --priority) + aging.step for every
//               aging.everyMin minutes of waiting
// Ties go to the earlier `since` (integer milliseconds), then to the smaller token, so every client that reads
// the same files computes the same order.
'use strict';

const DEFAULT_PRIORITIES = { presence: 100, 'node-chat': 50, hold: 40, script: 30, gate: 30 };
const BLOCKED_FRESH_MS = 20e3;

function basePriority(w, cfg) {
  if (w.priority != null && w.priority !== '' && !Number.isNaN(Number(w.priority))) return Number(w.priority);
  const pr = Object.assign({}, DEFAULT_PRIORITIES, (cfg && cfg.priorities) || {});
  return pr[w.mode] != null ? Number(pr[w.mode]) : 30;
}

function effectivePriority(w, cfg, now) {
  now = now || Date.now();
  const aging = (cfg && cfg.aging) || { everyMin: 10, step: 10 };
  const waited = Math.max(0, now - Number(w.since || now));
  const steps = aging.everyMin > 0 ? Math.floor(waited / (aging.everyMin * 60e3)) : 0;
  return basePriority(w, cfg) + steps * (Number(aging.step) || 0);
}

function compare(a, b, cfg, now) {
  const pa = effectivePriority(a, cfg, now), pb = effectivePriority(b, cfg, now);
  if (pa !== pb) return pb - pa;
  const sa = Number(a.since) || 0, sb = Number(b.since) || 0;
  if (sa !== sb) return sa - sb;
  return String(a.token) < String(b.token) ? -1 : String(a.token) > String(b.token) ? 1 : 0;
}

/** The waiters in serving order (a new array). */
function order(waiters, cfg, now) {
  now = now || Date.now();
  return [...waiters].sort((a, b) => compare(a, b, cfg, now));
}

// A waiter that cannot take the resource right now for its own reason (a person is at the machine it needs)
// does not hold back those who can: the queue stays work-conserving.
function isBlocked(w, now) {
  return !!(w.blocked && w.blockedAt && (now || Date.now()) - Number(w.blockedAt) < BLOCKED_FRESH_MS);
}

/** Waiters that rank before `me` and are able to take the resource now. */
function ahead(waiters, me, cfg, now) {
  now = now || Date.now();
  const mine = Object.assign({ since: now }, me);
  return waiters.filter(w => w.token !== mine.token && !isBlocked(w, now) && compare(w, mine, cfg, now) < 0);
}

/**
 * For a resource with places: of the waiters `ahead` of `me`, those that really go first. A whole take waits for
 * everyone ahead. A shared take waits for a whole take ahead (it does not slip past one into a place that just
 * freed), and for shared ones ahead only while they would use up the `free` places.
 */
function aheadForPlaces(ahead, me, free) {
  if (!me.shared || !ahead.length) return ahead;
  const whole = ahead.filter(w => !w.shared);
  if (whole.length) return whole;
  return ahead.length >= free ? ahead : [];
}

module.exports = { DEFAULT_PRIORITIES, basePriority, effectivePriority, compare, order, ahead, aheadForPlaces, isBlocked };
