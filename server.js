"use strict";
// Celestial Troll Bot — troll auto-reply + assistant commands + GC name cycle.
// Built to stay logged in and never die: errors back off and retry, they never end the process.

const express = require("express");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { sendBanatReplyWithTyping } = require("./banat-human");
const { pickBanatReply, rememberBanatReply } = require("./banat-memory");
const { chooseSocialResponse } = require("./banat-social");
const { startTyping, stopTyping, stopAllTyping } = require("./human-typing");
const { createGcCycle } = require("./gcname");
const commands = require("./commands");

const PORT = process.env.PORT || 3000;
const DATA = process.env.DATA_DIR || __dirname; // everything lives in the project root by default
fs.mkdirSync(DATA, { recursive: true });

// ---------- tiny helpers ----------
function safeRead(f) { try { return JSON.parse(fs.readFileSync(f, "utf8")); } catch { return {}; } }
function writeAtomic(f, obj) {                       // never leave a half-written cookie file behind
  const tmp = f + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, f);
}
const rnd = (a, b) => a + Math.random() * (b - a);
const num = (v, min, max, fallback) => { const n = Number(v); return Number.isFinite(n) ? Math.max(min, Math.min(max, n)) : fallback; };

// ---------- dashboard access ----------
// Walang password by default. Kung gusto mong i-lock, mag-set lang ng ADMIN_PASSWORD sa Railway Variables.
const hasAdmin = () => !!process.env.ADMIN_PASSWORD;
function safeEq(a, b) {
  const x = crypto.createHash("sha256").update(String(a)).digest();
  const y = crypto.createHash("sha256").update(String(b)).digest();
  return crypto.timingSafeEqual(x, y);
}
const checkPw = (pw) => hasAdmin() && safeEq(pw || "", process.env.ADMIN_PASSWORD);

// ---------- config ----------
const CFG_FILE = path.join(DATA, "config.json");
const DEFAULTS = {
  appState: null, savedAt: null, stateRefreshedAt: null,
  autoReply: false, threadId: null, running: false,
  speed: "normal", selfReact: true, selfReactRate: 0.15, markRead: true,
  skipRate: 0.45, senderCooldownS: 60, hourlyMax: 10, dailyMax: 60, threadMax: 3, threadWindowS: 300,
  quiet: { on: true, start: "00:30", end: "07:30" }, tz: process.env.BOT_TZ || "Asia/Manila",
  openers: ["hello", "uy"],
  profile: "stealth-v1",
  // assistant / commands
  troll: true,                 // random troll replies on/off (commands work either way)
  prefix: "!",
  admins: [],                  // extra admin user IDs (the bot account itself is always admin)
  cmdCooldownS: 4, cmdHourlyMax: 150,
  fcaPackage: null,            // name of the fca library to load (or env FCA_PACKAGE)
  reminders: [],
};
// Low-footprint profile for long runs. Applied ONCE to an older saved config.json
// (so the Railway volume gets updated too); after that, dashboard changes are respected.
const STEALTH_V1 = ["speed", "selfReact", "selfReactRate", "skipRate", "senderCooldownS", "hourlyMax", "dailyMax", "threadMax", "threadWindowS", "openers"];
const cfg = Object.assign({}, DEFAULTS, safeRead(CFG_FILE));
cfg.quiet = Object.assign({}, DEFAULTS.quiet, cfg.quiet);
if (cfg.profile !== DEFAULTS.profile) {
  for (const k of STEALTH_V1) cfg[k] = DEFAULTS[k];
  cfg.quiet = Object.assign({}, DEFAULTS.quiet); cfg.profile = DEFAULTS.profile;
  try { writeAtomic(CFG_FILE, cfg); } catch {}
}
const save = () => { try { writeAtomic(CFG_FILE, cfg); } catch (e) { console.error("[save]", e.message); } };

const envAdmins = new Set(String(process.env.ADMIN_IDS || "").split(",").map((s) => s.trim()).filter(Boolean));
const isAdminId = (id) => String(id) === S.uid || envAdmins.has(String(id)) || (cfg.admins || []).map(String).includes(String(id));

// ---------- reply pools (replies.json: array OR { type: [..], default: [..] }) ----------
const RAW_POOL = JSON.parse(fs.readFileSync(path.join(__dirname, "replies.json"), "utf8"));
const POOLS = Array.isArray(RAW_POOL) ? { default: RAW_POOL } : RAW_POOL;
const ALL_REPLIES = [...new Set(Object.values(POOLS).flat())];
const poolKey = (type) => (Array.isArray(POOLS[type]) && POOLS[type].length ? type : "default");
const poolFor = (type) => (Array.isArray(POOLS[poolKey(type)]) && POOLS[poolKey(type)].length ? POOLS[poolKey(type)] : ALL_REPLIES);

// ---------- runtime state ----------
const S = {
  api: null, uid: null, online: false, running: false, logging: false, stopListen: null, manualOff: false,
  authDead: false, started: Date.now(), botSince: null, lastConnected: null, lastDisconnected: null,
  attempts: 0, nextRetry: null, timer: null, listenTimer: null, listenFails: 0, pingFails: 0,
  lastEventAt: null, lastPing: null, nextPing: 0, lastStateJson: cfg.appState ? JSON.stringify(cfg.appState) : null,
  lastError: null, replies: [], daily: [], suppressed: 0, awayUntil: 0, fcaName: null,
  senders: new Map(), threads: new Map(), busy: new Set(), log: [],
  cmdSenders: new Map(), cmdHour: [],
};

function log(who, msg) {
  S.log.unshift({ t: Date.now(), who, msg: String(msg).slice(0, 300) });
  S.log.length = Math.min(S.log.length, 80);
  console.log(`[${who}] ${msg}`);
}

function parseCookie(raw) {
  raw = String(raw || "").trim();
  const arr = raw.startsWith("[")
    ? JSON.parse(raw)
    : raw.split(";").map((p) => p.trim()).filter(Boolean).map((p) => {
        const i = p.indexOf("=");
        return { key: p.slice(0, i), value: p.slice(i + 1), domain: "facebook.com", path: "/", hostOnly: false };
      });
  const keys = new Set(arr.map((c) => c.key || c.name));
  if (!keys.has("c_user") || !keys.has("xs")) throw new Error("missing c_user / xs");
  return arr;
}

// First boot with no saved cookie: accept APPSTATE env or an appstate.json next to server.js.
if (!cfg.appState) {
  try {
    const raw = process.env.APPSTATE || (fs.existsSync(path.join(DATA, "appstate.json")) ? fs.readFileSync(path.join(DATA, "appstate.json"), "utf8") : "");
    if (raw) {
      cfg.appState = parseCookie(raw); cfg.savedAt = Date.now(); S.lastStateJson = JSON.stringify(cfg.appState); save();
      console.log("[system] cookie loaded from " + (process.env.APPSTATE ? "APPSTATE env" : "appstate.json"));
    }
  } catch (e) { console.error("[system] bad APPSTATE / appstate.json:", e.message); }
}

// ---------- quiet hours (so it doesn't reply at 3am like a robot) ----------
function localMinutes() {
  const parts = new Intl.DateTimeFormat("en-GB", { timeZone: cfg.tz, hour: "2-digit", minute: "2-digit", hour12: false }).formatToParts(new Date());
  const h = Number(parts.find((p) => p.type === "hour").value) % 24;
  const m = Number(parts.find((p) => p.type === "minute").value);
  return h * 60 + m;
}
const toMin = (s) => { const [h, m] = String(s || "0:0").split(":").map(Number); return (h || 0) * 60 + (m || 0); };
function inQuiet() {
  if (!cfg.quiet.on) return false;
  try {
    const n = localMinutes(), a = toMin(cfg.quiet.start), b = toMin(cfg.quiet.end);
    return a <= b ? n >= a && n < b : n >= a || n < b;
  } catch { return false; }
}

// ---------- session keep-alive: the part that decides how long a login survives ----------
const AUTH_RE = /checkpoint|not logged in|login[_ ]?(approval|blocked)|expired|appstate|retrieving userid|unknown location|suspended|disabled|locked|invalid.*(cookie|session)/i;
const isAuthError = (e) => AUTH_RE.test(String((e && (e.error || e.message)) || e || ""));

// Facebook rotates parts of the session while you use it. Saving the refreshed
// appState (instead of the original paste) is what lets a login keep working
// across restarts for weeks.
function captureState(reason) {
  if (!S.api || typeof S.api.getAppState !== "function") return;
  try {
    const st = S.api.getAppState();
    if (!Array.isArray(st) || !st.length) return;
    const json = JSON.stringify(st);
    if (json === S.lastStateJson) return;
    if (cfg.appState) { try { writeAtomic(path.join(DATA, "appstate.backup.json"), cfg.appState); } catch {} }
    S.lastStateJson = json; cfg.appState = st; cfg.stateRefreshedAt = Date.now(); save();
    log("session", `cookie refreshed (${reason})`);
  } catch (e) { log("error", "getAppState: " + (e.message || e)); }
}

function stopListening() {
  const s = S.stopListen; S.stopListen = null;
  clearTimeout(S.listenTimer);
  try {
    if (typeof s === "function") s();
    else if (s && typeof s.stopListening === "function") s.stopListening();
    else if (s && typeof s.stop === "function") s.stop();
  } catch {}
}
function teardown() { stopListening(); stopAllTyping(); S.api = null; S.online = false; S.busy.clear(); }

// Auth problems pause the fast retry loop (so the account isn't hammered) but we still
// try again every 30 min: "expired" errors are sometimes temporary, and the bot should
// come back on its own instead of staying dead until someone notices.
function markAuthDead(e) {
  S.authDead = true;
  S.lastError = "Session expired / checkpoint — paste a fresh cookie. (" + String((e && (e.error || e.message)) || e).slice(0, 120) + ")";
  log("watchdog", "auth problem: fast retry paused, will probe again in 30 min");
  teardown(); S.lastDisconnected = Date.now(); clearTimeout(S.timer);
  S.nextRetry = Date.now() + 30 * 60e3;
  S.timer = setTimeout(() => { if (S.manualOff) return; S.authDead = false; connect(); }, 30 * 60e3);
}

// FCA library loader. Set FCA_PACKAGE (env) or "fcaPackage" (config.json) to use another
// fork (e.g. your lazymeta build). The bot only needs the standard fca API:
// login, listenMqtt, sendMessage, setTitle, sendTypingIndicator, getAppState, markAsRead...
function loadFca() {
  const names = [process.env.FCA_PACKAGE, cfg.fcaPackage, "@dongdev/fca-unofficial"].filter(Boolean);
  const tried = [];
  for (const name of [...new Set(names)]) {
    try {
      const mod = require(name);
      const login = typeof mod === "function" ? mod : mod && (mod.login || mod.default);
      if (typeof login === "function") { S.fcaName = name; return login; }
      tried.push(`${name} (no login export)`);
    } catch (e) { tried.push(`${name} (${String(e.message).split("\n")[0].slice(0, 80)})`); }
  }
  log("error", "fca library missing: " + tried.join(" | "));
  return null;
}

function connect() {
  if (S.logging || !cfg.appState || S.authDead) return;
  clearTimeout(S.timer); S.nextRetry = null; S.logging = true;
  const login = loadFca();
  if (!login) { S.logging = false; S.lastError = "fca library not installed (npm i, or set FCA_PACKAGE)"; return scheduleRetry(); }

  // selfListen:true lets the owner (the bot account itself) type !admin commands in a chat.
  // Own non-command messages are ignored in onEvent.
  login({ appState: cfg.appState }, { online: true, selfListen: true, listenEvents: true, autoMarkRead: false, logLevel: "error" }, (err, api) => {
    S.logging = false;
    if (err) {
      S.lastError = String(err.message || err.error || err);
      log("error", "login: " + S.lastError);
      return isAuthError(err) ? markAuthDead(err) : scheduleRetry();
    }
    S.api = api; S.uid = String(api.getCurrentUserID()); S.online = true; S.attempts = 0; S.listenFails = 0; S.pingFails = 0;
    S.lastConnected = Date.now(); S.lastError = null; S.authDead = false; S.nextPing = Date.now() + rnd(10, 20) * 60e3;
    log("system", `Messenger connected as ${S.uid} (${S.fcaName})`);
    captureState("login");
    if (cfg.running && !S.running) { S.running = true; S.botSince = Date.now(); log("bot", "resumed after reconnect"); }
    startListen();
    gc.resume();                                     // GC name cycle picks up again if it was ON
  });
}

function startListen() {
  if (!S.api) return;
  stopListening();
  S.stopListen = S.api.listenMqtt((e, ev) => {
    if (e) return onListenError(e);
    S.listenFails = 0; S.lastEventAt = Date.now();
    onEvent(ev).catch((err) => log("error", "event: " + (err && err.message || err)));
  });
}
function onListenError(e) {
  log("error", "listen: " + (e.message || e.error || e));
  if (isAuthError(e)) return markAuthDead(e);
  S.listenFails++;
  if (S.listenFails <= 3) {                          // try to re-listen on the SAME login first; fresh logins look suspicious
    clearTimeout(S.listenTimer);
    S.listenTimer = setTimeout(startListen, 4000 * S.listenFails + rnd(0, 2000));
    return;
  }
  drop();
}
function drop() { teardown(); S.lastDisconnected = Date.now(); scheduleRetry(); }
function scheduleRetry() {                           // never gives up: backs off to 5 min, then every 30 min after 10 tries
  if (!cfg.appState || S.manualOff || S.authDead) return;
  S.attempts++;
  let s = Math.min(300, 8 * 2 ** (S.attempts - 1)) + rnd(0, 5);
  if (S.attempts > 10) { s = 1800; S.attempts = 0; log("watchdog", "10 tries failed. Will retry in 30 min"); }
  else log("watchdog", `reconnect #${S.attempts} in ${Math.round(s)}s`);
  S.nextRetry = Date.now() + s * 1000; clearTimeout(S.timer); S.timer = setTimeout(connect, s * 1000);
}
function disconnect() {
  S.manualOff = true; clearTimeout(S.timer); teardown();
  S.running = false; cfg.running = false; save(); S.lastDisconnected = Date.now(); S.nextRetry = null;
}

// Light health check every 20-40 min: detects a dead session early and keeps the cookie fresh.
function ping() {
  if (!S.api) return;
  S.api.getThreadList(1, null, ["INBOX"], (e) => {
    if (!e) { S.pingFails = 0; S.lastPing = Date.now(); return; }
    if (isAuthError(e)) return markAuthDead(e);
    if (++S.pingFails >= 3) { log("watchdog", "health check failed 3x, reconnecting"); S.pingFails = 0; drop(); }
  });
}
setInterval(() => {
  if (!S.api) return;
  captureState("periodic");
  if (Date.now() >= S.nextPing) { S.nextPing = Date.now() + rnd(20, 40) * 60e3; ping(); }
}, 5 * 60e3);

// Optional: for hosts that sleep idle web services, set SELF_URL=https://your-app.example.com
if (process.env.SELF_URL) {
  setInterval(() => { fetch(String(process.env.SELF_URL).replace(/\/+$/, "") + "/health").catch(() => {}); }, 4 * 60e3);
}

// ---------- sending ----------
const sendRaw = (api, text, tid, cb, replyTo) => api.sendMessage(text, tid, cb, replyTo || undefined);

// Plain assistant send: typing indicator + short human delay, text/attachments sent exactly as written.
function sendAssistant(threadID, message, replyTo = null, incomingText = "") {
  if (!S.api) return Promise.resolve(false);
  return sendBanatReplyWithTyping(S.api, message, threadID, replyTo, {
    trafficSendMessage: sendRaw, incomingText, speed: "fast", selfReact: false, humanize: false,
  });
}

// ---------- GC name cycle ----------
const gc = createGcCycle({ getApi: () => S.api, cfg, save, log, isAuthError, onAuthError: markAuthDead });

commands.startReminderLoop({ cfg, save, ready: () => !!S.api, send: (tid, text) => sendAssistant(tid, text) });

// ---------- Bot ----------
function allowed(ev) {                               // anti-spam gate (troll replies only)
  const now = Date.now();
  S.replies = S.replies.filter((t) => now - t < 3600e3);
  S.daily = S.daily.filter((t) => now - t < 86400e3);
  if (S.replies.length >= cfg.hourlyMax || S.daily.length >= cfg.dailyMax) return false;
  if (now - (S.senders.get(ev.senderID) || 0) < cfg.senderCooldownS * 1000) return false;
  const th = (S.threads.get(ev.threadID) || []).filter((t) => now - t < cfg.threadWindowS * 1000);
  S.threads.set(ev.threadID, th);
  if (S.senders.size > 2000) for (const [k, t] of S.senders) if (now - t > 3600e3) S.senders.delete(k);
  if (S.threads.size > 500) for (const [k, v] of S.threads) if (!v.length) S.threads.delete(k);
  return th.length < cfg.threadMax;
}

const isTarget = (ev) => cfg.autoReply || (cfg.threadId && ev.threadID === cfg.threadId);

async function handleCommand(ev, parsed) {
  const cmd = commands.resolve(parsed.name);
  if (!cmd) return;
  const admin = isAdminId(ev.senderID);
  if (cmd.admin && !admin) return;

  if (!admin) {                                      // public users: only in the target chat, rate limited
    if (!S.running || !isTarget(ev)) return;
    const now = Date.now();
    S.cmdHour = S.cmdHour.filter((t) => now - t < 3600e3);
    if (S.cmdHour.length >= cfg.cmdHourlyMax) return;
    if (now - (S.cmdSenders.get(ev.senderID) || 0) < cfg.cmdCooldownS * 1000) return;
    S.cmdSenders.set(ev.senderID, now); S.cmdHour.push(now);
    if (S.cmdSenders.size > 1000) for (const [k, t] of S.cmdSenders) if (now - t > 3600e3) S.cmdSenders.delete(k);
  }

  const api = S.api;
  if (!api) return;
  if (cfg.markRead && typeof api.markAsRead === "function" && String(ev.senderID) !== S.uid) {
    try { api.markAsRead(ev.threadID, true, () => {}); } catch {}
  }

  startTyping(api, ev.threadID);                     // "typing..." while the command works (music search, !ask...)
  let reply;
  try {
    reply = await cmd.run({ args: parsed.args, ev, cfg, save, gc, S, prefix: cfg.prefix, isAdmin: admin });
  } catch (e) {
    log("error", `cmd ${parsed.name}: ${e && e.message || e}`);
    reply = "May error sa command na yan 😭 subukan ulit mamaya.";
  }
  if (!reply) { stopTyping(api, ev.threadID); return; }

  const message = typeof reply === "string" ? { body: reply } : reply;
  const cleanup = message.cleanup; delete message.cleanup;
  const ok = await sendAssistant(ev.threadID, message, ev.messageID || null, ev.body);
  if (typeof cleanup === "function") cleanup();
  stopTyping(api, ev.threadID);
  log("cmd", `${cfg.prefix}${parsed.name} -> ${ev.threadID}${ok ? "" : " (send failed)"}`);
}

async function onEvent(ev) {
  if (!ev || (ev.type !== "message" && ev.type !== "message_reply") || !ev.body) return;

  const parsed = commands.parse(ev.body, cfg.prefix || "!");
  const isCmd = !!(parsed && commands.resolve(parsed.name));
  const own = String(ev.senderID) === S.uid;

  if (own && !isCmd) return;                         // selfListen is on: never react to our own chatter
  if (isCmd) return handleCommand(ev, parsed);

  if (!S.running || !cfg.troll) return;
  if (!isTarget(ev) || inQuiet()) return;
  if (Date.now() < S.awayUntil) return;              // "away" break: a real person isn't glued to the phone
  if (Math.random() < cfg.skipRate) return;          // random skip
  if (S.busy.has(ev.threadID)) return;               // don't talk over ourselves in the same chat
  if (!allowed(ev)) { S.suppressed++; return; }

  const api = S.api;
  if (!api) return;
  S.busy.add(ev.threadID);
  try {
    const social = chooseSocialResponse(ev.body, "", { momentum: 1, recentMessages: 1 });
    const key = poolKey(social.type);
    const r = pickBanatReply(ev.threadID, poolFor(social.type), [], "reply-pool:" + key);
    const text = typeof r === "string" && r ? r : ALL_REPLIES[Math.floor(Math.random() * ALL_REPLIES.length)];

    const now = Date.now();
    S.replies.push(now); S.daily.push(now); S.senders.set(ev.senderID, now); S.threads.get(ev.threadID).push(now);

    if (cfg.markRead && typeof api.markAsRead === "function") {   // "seen" shortly after it arrives, like a person
      setTimeout(() => { try { api.markAsRead(ev.threadID, true, () => {}); } catch {} }, rnd(250, 1200));
    }

    const ok = await sendBanatReplyWithTyping(api, text, ev.threadID, null, {
      trafficSendMessage: sendRaw,
      incomingText: ev.body,
      speed: cfg.speed,
      selfReact: cfg.selfReact ? { rate: cfg.selfReactRate } : false,   // only reacts to its OWN replies
    });
    if (ok) {
      rememberBanatReply(ev.threadID, text, ev.senderID); log("bot", `reply [${social.type}] -> ${ev.threadID}`);
      if (Math.random() < 0.06) { S.awayUntil = Date.now() + rnd(20, 90) * 60e3; log("bot", `away break ${Math.round((S.awayUntil - Date.now()) / 60e3)} min`); }
    }
  } finally { S.busy.delete(ev.threadID); }
}

async function startBot() {
  if (!S.online) return log("error", "Connect first");
  S.running = true; cfg.running = true; save(); S.botSince = Date.now(); log("bot", "started");
  if (cfg.threadId) {
    const o = cfg.openers[Math.floor(Math.random() * cfg.openers.length)];
    sendBanatReplyWithTyping(S.api, o, cfg.threadId, null, { trafficSendMessage: sendRaw, incomingText: "", speed: cfg.speed, selfReact: false });
  }
}

// ---------- HTTP ----------
const app = express();
app.set("trust proxy", 1);
app.use(express.json({ limit: "1mb" }));
app.get("/", (q, r) => r.sendFile(path.join(__dirname, "index.html")));   // only index.html is public
app.get("/health", (q, r) => r.json({ ok: true }));

app.get("/api/needsetup", (q, r) => r.json({ setup: false, open: !hasAdmin() }));

const fails = new Map();
app.use("/api", (req, res, next) => {
  if (!hasAdmin()) return next();                   // open dashboard (walang password)
  const ip = req.ip, now = Date.now(), given = req.get("x-admin");
  const f = (fails.get(ip) || []).filter((t) => now - t < 900e3);
  if (f.length >= 10) return res.status(429).json({ error: "Too many wrong tries. Wait 15 min." });
  if (hasAdmin() && given !== undefined && checkPw(given)) { fails.delete(ip); return next(); }
  if (given !== undefined) { f.push(now); fails.set(ip, f); }
  if (fails.size > 500) for (const [k, v] of fails) if (!v.some((t) => now - t < 900e3)) fails.delete(k);
  res.status(401).json({ error: "unauthorized" });
});

const status = () => ({
  online: S.online, running: S.running, uid: S.uid, authDead: S.authDead, fca: S.fcaName,
  serverUptime: (Date.now() - S.started) / 1000 | 0, botUptime: S.running && S.botSince ? (Date.now() - S.botSince) / 1000 | 0 : 0,
  lastConnected: S.lastConnected, lastDisconnected: S.lastDisconnected, lastPing: S.lastPing, lastEventAt: S.lastEventAt,
  stateRefreshedAt: cfg.stateRefreshedAt, savedAt: cfg.savedAt,
  autoReply: cfg.autoReply, threadId: cfg.threadId, repliesHour: S.replies.length, repliesDay: S.daily.length, suppressed: S.suppressed,
  attempts: S.attempts, nextRetry: S.nextRetry, lastError: S.lastError, cookieSaved: !!cfg.appState,
  prefix: cfg.prefix, gc: gc.status(),
  settings: {
    speed: cfg.speed, selfReact: cfg.selfReact, selfReactRate: cfg.selfReactRate, markRead: cfg.markRead, troll: cfg.troll,
    skipRate: cfg.skipRate, hourlyMax: cfg.hourlyMax, dailyMax: cfg.dailyMax, quiet: cfg.quiet, tz: cfg.tz,
  },
  quietNow: inQuiet(), log: S.log.slice(0, 40),
});
app.get("/api/status", (q, r) => r.json(status()));
app.post("/api/auto", (q, r) => { cfg.autoReply = !!q.body.on; save(); r.json(status()); });
app.post("/api/thread", (q, r) => { cfg.threadId = q.body.threadId || null; save(); r.json(status()); });
app.post("/api/start", async (q, r) => { await startBot(); r.json(status()); });
app.post("/api/stop", (q, r) => { S.running = false; cfg.running = false; save(); log("bot", "stopped"); r.json(status()); });
app.post("/api/reconnect", (q, r) => {
  S.manualOff = false; S.authDead = false; if (S.online) { teardown(); }
  S.attempts = 0; clearTimeout(S.timer); connect(); r.json(status());
});
app.post("/api/disconnect", (q, r) => { disconnect(); r.json(status()); });
app.post("/api/session", (q, r) => {
  try {
    cfg.appState = parseCookie(q.body.cookie); cfg.savedAt = Date.now(); cfg.stateRefreshedAt = null; S.lastStateJson = JSON.stringify(cfg.appState); save();
    S.manualOff = false; S.authDead = false; S.attempts = 0; S.lastError = null;
    if (S.online) teardown();
    connect(); r.json(status());
  } catch (e) { r.status(400).json({ error: "Invalid cookie (need a JSON array or c_user=...; xs=...)" }); }
});
app.post("/api/settings", (q, r) => {
  const b = q.body || {};
  if (["fast", "normal", "slow"].includes(b.speed)) cfg.speed = b.speed;
  if (typeof b.selfReact === "boolean") cfg.selfReact = b.selfReact;
  if (typeof b.markRead === "boolean") cfg.markRead = b.markRead;
  if (typeof b.troll === "boolean") cfg.troll = b.troll;
  cfg.selfReactRate = num(b.selfReactRate, 0, 1, cfg.selfReactRate);
  cfg.skipRate = num(b.skipRate, 0, 0.9, cfg.skipRate);
  cfg.hourlyMax = Math.round(num(b.hourlyMax, 1, 300, cfg.hourlyMax));
  cfg.dailyMax = Math.round(num(b.dailyMax, 1, 3000, cfg.dailyMax));
  if (b.quiet && typeof b.quiet === "object") {
    const ok = (s) => /^([01]?\d|2[0-3]):[0-5]\d$/.test(String(s));
    cfg.quiet = { on: !!b.quiet.on, start: ok(b.quiet.start) ? b.quiet.start : cfg.quiet.start, end: ok(b.quiet.end) ? b.quiet.end : cfg.quiet.end };
  }
  save(); log("system", "settings updated"); r.json(status());
});

// GC name cycle (also controllable from chat with !gcname)
app.post("/api/gcsave", (q, r) => {
  const b = q.body || {};
  if (Array.isArray(b.names)) gc.setNames(b.names, false);
  if (b.intervalS != null) gc.setInterval(b.intervalS, false);
  save(); r.json(status());
});
app.post("/api/gcstart", (q, r) => {
  const b = q.body || {};
  if (!b.threadId && !cfg.threadId && !gc.status().threadId) return r.status(400).json({ error: "Pumili muna ng GC sa 'Group chat' card." });
  gc.start({ threadId: b.threadId || undefined, names: Array.isArray(b.names) ? b.names : undefined, intervalS: b.intervalS });
  r.json(status());
});
app.post("/api/gcstop", (q, r) => { gc.stop(); r.json(status()); });

app.get("/api/threads", (q, r) => {
  if (!S.api) return r.json([]);
  S.api.getThreadList(50, null, ["INBOX"], (e, l) => r.json(e ? [] : l.filter((t) => t.isGroup).map((t) => ({ id: t.threadID, name: t.name || t.threadID }))));
});

// A long-running process must not die on one stray exception, and must save the
// freshest cookie when the host (Railway) sends SIGTERM on redeploy.
process.on("uncaughtException", (e) => log("fatal", (e && e.stack) || e));
process.on("unhandledRejection", (e) => log("fatal", (e && e.stack) || e));
for (const sig of ["SIGTERM", "SIGINT"]) process.on(sig, () => { stopAllTyping(); captureState("shutdown"); save(); process.exit(0); });

app.listen(PORT, () => { log("system", "server on " + PORT); if (cfg.appState) connect(); });
