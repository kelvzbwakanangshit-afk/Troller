"use strict";

/**
 * GC name cycle
 * -------------
 * Rotates the group chat title through a list of names until YOU stop it.
 *
 *  - never gives up: errors only slow it down (backoff), they don't end it
 *  - survives restarts: `on` is saved in config.json and resumed after login
 *  - jittered interval so it doesn't tick like a metronome
 *
 * Needs the api object (api.setTitle) only at tick time, so reconnects are fine.
 */

const MIN_S = 10;
const MAX_S = 3600;
const MAX_NAME = 80;

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

const DEFAULT_NAMES = [
  "Walang Patayan 💀",
  "Troll Zone 🤡",
  "Wag Seryoso 😂",
  "Ingay Lang 😭",
  "Celestial Lite ✨",
];

function defaults() {
  return {
    on: false,
    threadId: null, // null -> use the selected GC (cfg.threadId)
    names: [...DEFAULT_NAMES],
    intervalS: 45,
    index: 0,
    lastTitle: null,
    lastChangeAt: null,
    changes: 0,
    fails: 0,
  };
}

function cleanName(n) {
  return String(n == null ? "" : n).replace(/\s+/g, " ").trim().slice(0, MAX_NAME);
}

function createGcCycle({ getApi, cfg, save, log, isAuthError, onAuthError }) {
  cfg.gcCycle = Object.assign(defaults(), cfg.gcCycle || {});
  cfg.gcCycle.names = (Array.isArray(cfg.gcCycle.names) ? cfg.gcCycle.names : [])
    .map(cleanName)
    .filter(Boolean);
  if (!cfg.gcCycle.names.length) cfg.gcCycle.names = [...DEFAULT_NAMES];

  const g = () => cfg.gcCycle;
  let timer = null;
  let pending = false;
  let busy = false;
  let backoff = 0;

  const targetThread = () => g().threadId || cfg.threadId || null;

  function delayMs() {
    const base = clamp(Number(g().intervalS) || 45, MIN_S, MAX_S) * 1000;
    const jitter = base * (0.88 + Math.random() * 0.24);
    return Math.min(10 * 60_000, jitter * Math.min(16, 2 ** backoff));
  }

  function schedule(ms) {
    clearTimeout(timer);
    pending = true;
    timer = setTimeout(tick, ms);
  }

  function setTitle(api, title, threadID) {
    return new Promise((resolve) => {
      let done = false;
      const finish = (err) => {
        if (done) return;
        done = true;
        resolve(err || null);
      };
      const guard = setTimeout(() => finish(new Error("setTitle timeout")), 25_000);
      try {
        api.setTitle(title, threadID, (err) => {
          clearTimeout(guard);
          finish(err);
        });
      } catch (e) {
        clearTimeout(guard);
        finish(e);
      }
    });
  }

  function nextName() {
    const names = g().names;
    if (!names.length) return null;
    let idx = Number(g().index) || 0;
    if (idx >= names.length) idx = 0;
    let name = names[idx];
    // avoid re-sending the exact same title (would just be a no-op / flag bait)
    if (names.length > 1 && name === g().lastTitle) {
      idx = (idx + 1) % names.length;
      name = names[idx];
    }
    g().index = (idx + 1) % names.length;
    return name;
  }

  async function tick() {
    pending = false;
    if (!g().on) return;
    if (busy) return schedule(5000);

    const api = getApi();
    const threadID = targetThread();
    if (!api || !threadID) return schedule(10_000); // offline / no GC yet: keep waiting, never stop

    const name = nextName();
    if (!name || (g().names.length === 1 && name === g().lastTitle)) {
      return schedule(delayMs());
    }

    busy = true;
    const err = await setTitle(api, name, threadID);
    busy = false;

    if (!g().on) return; // stopped while the call was in flight

    if (err) {
      g().fails = (g().fails || 0) + 1;
      backoff = Math.min(4, backoff + 1);
      log("gcname", `setTitle failed (${g().fails}): ${String(err.message || err.error || err).slice(0, 120)}`);
      if (typeof isAuthError === "function" && isAuthError(err) && typeof onAuthError === "function") {
        onAuthError(err);
      }
    } else {
      backoff = 0;
      g().fails = 0;
      g().lastTitle = name;
      g().lastChangeAt = Date.now();
      g().changes = (g().changes || 0) + 1;
      if (g().changes % 20 === 0) save(); // don't rewrite the cookie file on every tick
    }
    schedule(delayMs());
  }

  return {
    start(opts = {}) {
      if (opts.threadId) g().threadId = String(opts.threadId);
      if (Array.isArray(opts.names) && opts.names.length) this.setNames(opts.names, false);
      if (opts.intervalS != null) this.setInterval(opts.intervalS, false);
      g().on = true;
      g().fails = 0;
      backoff = 0;
      save();
      schedule(1500);
      log("gcname", `cycle ON -> ${targetThread() || "(no GC selected yet)"}`);
    },
    stop() {
      g().on = false;
      clearTimeout(timer);
      pending = false;
      save();
      log("gcname", "cycle OFF");
    },
    // call after every (re)login: picks the loop back up if it was left ON
    resume() {
      if (g().on && !pending && !busy) schedule(3000);
    },
    now() {
      if (g().on) schedule(300);
    },
    setNames(list, persist = true) {
      const names = (Array.isArray(list) ? list : []).map(cleanName).filter(Boolean);
      if (!names.length) return false;
      g().names = [...new Set(names)].slice(0, 60);
      g().index = 0;
      if (persist) save();
      return true;
    },
    add(name) {
      const n = cleanName(name);
      if (!n) return false;
      if (!g().names.includes(n)) g().names.push(n);
      g().names = g().names.slice(0, 60);
      save();
      return true;
    },
    remove(position) {
      const i = Number(position) - 1;
      if (!Number.isInteger(i) || i < 0 || i >= g().names.length || g().names.length <= 1) return false;
      g().names.splice(i, 1);
      g().index = 0;
      save();
      return true;
    },
    setInterval(seconds, persist = true) {
      const n = Number(seconds);
      if (!Number.isFinite(n)) return false;
      g().intervalS = clamp(Math.round(n), MIN_S, MAX_S);
      if (persist) save();
      return true;
    },
    setThread(threadID) {
      g().threadId = threadID ? String(threadID) : null;
      save();
    },
    status() {
      const c = g();
      return {
        on: c.on,
        threadId: targetThread(),
        names: c.names,
        intervalS: c.intervalS,
        lastTitle: c.lastTitle,
        lastChangeAt: c.lastChangeAt,
        changes: c.changes,
        fails: c.fails,
      };
    },
    MIN_S,
    MAX_S,
  };
}

module.exports = { createGcCycle, DEFAULT_NAMES, MIN_S, MAX_S };
