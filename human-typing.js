"use strict";

/**
 * Human Typing
 * ------------
 * Owns only the Messenger typing-indicator lifecycle.
 *
 * fca's sendTypingIndicator(threadID, cb) RETURNS an `end()` function. The old
 * version ignored it (and called a non-existent api.sendTyping), so the
 * indicator was never stopped properly and expired on its own. This version:
 *   - keeps the returned end() and calls it on stop
 *   - re-sends the indicator every few seconds so long waits (music search,
 *     !ask) keep showing "typing..."
 *   - is idempotent per thread and never throws
 */

const REFRESH_MS = 4500;
const MAX_TYPING_MS = 45_000; // safety net: never leave an indicator stuck on

const active = new Map(); // threadID -> { end, timer, killer }

function fire(api, key, entry) {
  try {
    if (typeof api.sendTypingIndicator === "function") {
      const end = api.sendTypingIndicator(key, () => {});
      if (typeof end === "function") entry.end = end;
    } else if (typeof api.sendTyping === "function") {
      api.sendTyping(key, true);
    }
  } catch (error) {
    console.warn("[HUMAN-TYPING] start failed:", error?.message || error);
  }
}

function startTyping(api, threadID) {
  if (!api || !threadID) return false;
  const key = String(threadID);
  if (active.has(key)) return true;

  const entry = { end: null, timer: null, killer: null };
  active.set(key, entry);
  fire(api, key, entry);

  entry.timer = setInterval(() => fire(api, key, entry), REFRESH_MS);
  entry.killer = setTimeout(() => stopTyping(api, key), MAX_TYPING_MS);
  return true;
}

function stopTyping(api, threadID) {
  if (!threadID) return false;
  const key = String(threadID);
  const entry = active.get(key);
  if (!entry) return false;

  active.delete(key);
  clearInterval(entry.timer);
  clearTimeout(entry.killer);

  try {
    if (typeof entry.end === "function") entry.end(() => {});
    else if (api && typeof api.sendTyping === "function") api.sendTyping(key, false);
  } catch (error) {
    console.warn("[HUMAN-TYPING] stop failed:", error?.message || error);
  }
  return true;
}

function stopAllTyping() {
  for (const key of [...active.keys()]) stopTyping(null, key);
}

function withTyping(api, threadID, durationMs, send) {
  const duration = Math.max(0, Number(durationMs) || 0);
  startTyping(api, threadID);

  return new Promise((resolve, reject) => {
    setTimeout(async () => {
      try {
        const result = await send();
        stopTyping(api, threadID);
        resolve(result);
      } catch (error) {
        stopTyping(api, threadID);
        reject(error);
      }
    }, duration);
  });
}

module.exports = {
  startTyping,
  stopTyping,
  stopAllTyping,
  withTyping,
};
