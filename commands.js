"use strict";

/**
 * Assistant commands for the troll bot.
 *
 * Every command is  async (ctx) => string | { body, attachment, cleanup } | null
 *   ctx = { args, ev, cfg, save, gc, S, prefix, isAdmin }
 *
 * Public:  help music time weather define calc roll flip 8ball pick remind ask uptime
 * Admin:   gcname troll
 * "Admin" = the bot account itself, or an ID listed in cfg.admins / ADMIN_IDS.
 */

const { musicCommand } = require("./music");

async function getJson(url, ms = 10_000, init = {}) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), ms);
  try {
    const res = await fetch(url, { ...init, signal: ctl.signal });
    if (!res.ok) throw new Error("HTTP " + res.status);
    return await res.json();
  } finally {
    clearTimeout(t);
  }
}

// ---------- calc: tiny safe expression parser (no eval) ----------
function calc(input) {
  const s = String(input || "")
    .replace(/\s+/g, "")
    .replace(/×|x(?=[\d(.])/gi, "*")
    .replace(/÷/g, "/")
    .replace(/,/g, "");
  if (!s || s.length > 120 || !/^[0-9+\-*/%^().]+$/.test(s)) throw new Error("bad expression");

  let i = 0;
  const peek = () => s[i];
  function number() {
    const m = /^(\d+\.?\d*|\.\d+)/.exec(s.slice(i));
    if (!m) throw new Error("number expected");
    i += m[0].length;
    return parseFloat(m[0]);
  }
  function primary() {
    if (peek() === "(") {
      i++;
      const v = expr();
      if (peek() !== ")") throw new Error("missing )");
      i++;
      return v;
    }
    return number();
  }
  function unary() {
    if (peek() === "-") { i++; return -unary(); }
    if (peek() === "+") { i++; return unary(); }
    return primary();
  }
  function power() {
    const base = unary();
    if (peek() === "^") { i++; return Math.pow(base, power()); }
    return base;
  }
  function term() {
    let v = power();
    while (peek() === "*" || peek() === "/" || peek() === "%") {
      const op = s[i++];
      const r = power();
      v = op === "*" ? v * r : op === "/" ? v / r : v % r;
    }
    return v;
  }
  function expr() {
    let v = term();
    while (peek() === "+" || peek() === "-") {
      const op = s[i++];
      const r = term();
      v = op === "+" ? v + r : v - r;
    }
    return v;
  }

  const out = expr();
  if (i !== s.length) throw new Error("unexpected " + s[i]);
  if (!Number.isFinite(out)) throw new Error("not finite");
  return Number(out.toPrecision(12));
}

// ---------- weather (Open-Meteo, no key) ----------
const WMO = {
  0: "Clear", 1: "Mostly clear", 2: "Partly cloudy", 3: "Overcast", 45: "Foggy", 48: "Foggy",
  51: "Light drizzle", 53: "Drizzle", 55: "Heavy drizzle", 61: "Light rain", 63: "Rain", 65: "Heavy rain",
  71: "Light snow", 73: "Snow", 75: "Heavy snow", 80: "Rain showers", 81: "Rain showers", 82: "Violent showers",
  95: "Thunderstorm", 96: "Thunderstorm w/ hail", 99: "Thunderstorm w/ hail",
};

async function weather(place) {
  const geo = await getJson(
    `https://geocoding-api.open-meteo.com/v1/search?count=1&language=en&format=json&name=${encodeURIComponent(place)}`
  );
  const g = geo.results && geo.results[0];
  if (!g) return `Hindi ko mahanap ang "${place}" 🤷`;
  const w = await getJson(
    `https://api.open-meteo.com/v1/forecast?latitude=${g.latitude}&longitude=${g.longitude}` +
      `&current=temperature_2m,apparent_temperature,relative_humidity_2m,precipitation,weather_code,wind_speed_10m&timezone=auto`
  );
  const c = w.current;
  if (!c) return "Walang weather data ngayon.";
  return (
    `🌤 ${g.name}${g.country_code ? ", " + g.country_code : ""}\n` +
    `${WMO[c.weather_code] || "—"} · ${Math.round(c.temperature_2m)}°C (feels ${Math.round(c.apparent_temperature)}°C)\n` +
    `💧 ${c.relative_humidity_2m}% · 🌧 ${c.precipitation} mm · 💨 ${Math.round(c.wind_speed_10m)} km/h`
  );
}

// ---------- define ----------
async function define(word) {
  try {
    const data = await getJson(`https://api.dictionaryapi.dev/api/v2/entries/en/${encodeURIComponent(word)}`);
    const e = Array.isArray(data) && data[0];
    const m = e && e.meanings && e.meanings[0];
    const d = m && m.definitions && m.definitions[0];
    if (!d) return `Walang definition para sa "${word}".`;
    return `📖 ${e.word}${m.partOfSpeech ? " (" + m.partOfSpeech + ")" : ""}\n${d.definition}${d.example ? `\nHal: ${d.example}` : ""}`;
  } catch {
    return `Walang definition para sa "${word}".`;
  }
}

// ---------- time ----------
function timeNow(zone, fallbackTz) {
  const tz = zone || fallbackTz || "Asia/Manila";
  try {
    const f = new Intl.DateTimeFormat("en-PH", {
      timeZone: tz, weekday: "long", year: "numeric", month: "long", day: "numeric", hour: "numeric", minute: "2-digit", second: "2-digit",
    });
    return `🕒 ${f.format(new Date())}\n(${tz})`;
  } catch {
    return `Di ko kilala ang timezone na "${tz}". Hal: ${"!"}time Asia/Tokyo`;
  }
}

// ---------- remind ----------
const UNIT = { s: 1e3, m: 60e3, h: 3600e3, d: 86400e3 };
function parseDuration(t) {
  const m = /^(\d+(?:\.\d+)?)\s*([smhd])$/i.exec(String(t || ""));
  if (!m) return null;
  const ms = parseFloat(m[1]) * UNIT[m[2].toLowerCase()];
  return ms >= 5e3 && ms <= 7 * 86400e3 ? ms : null;
}

// ---------- ask (optional, needs ANTHROPIC_API_KEY) ----------
async function ask(question) {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) return "Walang ANTHROPIC_API_KEY sa server kaya di pa gumagana ang !ask 😅";
  const data = await getJson(
    "https://api.anthropic.com/v1/messages",
    30_000,
    {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": key, "anthropic-version": "2023-06-01" },
      body: JSON.stringify({
        model: process.env.ASSISTANT_MODEL || "claude-haiku-5-5",
        max_tokens: 350,
        system:
          "You are a Taglish troll-bot assistant inside a Messenger group chat. Answer the question correctly and briefly " +
          "(max 4 short sentences, plain text, no markdown). Add a light, playful tease at the end. Never insult anyone's " +
          "looks, family, gender, religion or background, and never use profanity.",
        messages: [{ role: "user", content: String(question).slice(0, 1500) }],
      }),
    }
  );
  const text = (data.content || []).filter((b) => b.type === "text").map((b) => b.text).join("\n").trim();
  return text || "Walang sagot na lumabas 😭";
}

const EIGHT = [
  "Oo naman 😌", "Hindi 💀", "Baka 🤔", "Malabo pre", "Sure ball yan", "Wag ka muna umasa 😭",
  "Tanungin mo ulit mamaya", "Hindi ko type yung sagot, so hindi", "Oo, pero wag mo akong sisihin", "Ay hindi yan 😂",
];

const dur = (s) => `${(s / 3600) | 0}h ${((s % 3600) / 60) | 0}m ${s % 60 | 0}s`;
const pickOne = (a) => a[Math.floor(Math.random() * a.length)];

// ---------- registry ----------
const COMMANDS = {
  help: {
    run: async ({ prefix, isAdmin }) =>
      [
        "🤖 Troll Assistant",
        `${prefix}music (title) artist — 30s preview + info`,
        `${prefix}ask <tanong> — sagot ni AI`,
        `${prefix}weather <lugar>`,
        `${prefix}calc <math>`,
        `${prefix}define <word>`,
        `${prefix}time [timezone]`,
        `${prefix}remind <10m|2h|1d> <text>`,
        `${prefix}roll [NdM] · ${prefix}flip · ${prefix}8ball <tanong> · ${prefix}pick a | b | c`,
        `${prefix}uptime`,
        isAdmin ? `\n🔒 Admin: ${prefix}gcname start|stop|status|list|add|remove|set|interval|now · ${prefix}troll on|off` : null,
      ].filter(Boolean).join("\n"),
  },

  music: { run: async ({ args, prefix }) => musicCommand(args, prefix) },
  song: { alias: "music" },

  ask: {
    run: async ({ args, prefix }) => (args ? ask(args) : `Format: ${prefix}ask <tanong mo>`),
  },
  weather: {
    run: async ({ args, prefix }) => (args ? weather(args) : `Format: ${prefix}weather Manila`),
  },
  define: {
    run: async ({ args, prefix }) => (args ? define(args.split(/\s+/)[0]) : `Format: ${prefix}define serendipity`),
  },
  calc: {
    run: async ({ args, prefix }) => {
      if (!args) return `Format: ${prefix}calc (12+3)*4/5`;
      try { return `🧮 ${args} = ${calc(args)}`; } catch { return "Di ko ma-compute yan 😅 (+ - * / % ^ at ( ) lang)"; }
    },
  },
  time: { run: async ({ args, cfg }) => timeNow(args, cfg.tz) },

  roll: {
    run: async ({ args }) => {
      const m = /^(\d{1,2})?d(\d{1,4})$/i.exec(String(args || "d6").trim()) || /^(\d{1,2})?d(\d{1,4})$/i.exec("d6");
      const n = Math.max(1, Math.min(20, parseInt(m[1] || "1", 10)));
      const sides = Math.max(2, parseInt(m[2], 10));
      const rolls = Array.from({ length: n }, () => 1 + Math.floor(Math.random() * sides));
      return `🎲 ${n}d${sides}: ${rolls.join(", ")}${n > 1 ? ` = ${rolls.reduce((a, b) => a + b, 0)}` : ""}`;
    },
  },
  flip: { run: async () => `🪙 ${pickOne(["Heads", "Tails"])}` },
  "8ball": {
    run: async ({ args, prefix }) => (args ? `🎱 ${pickOne(EIGHT)}` : `Format: ${prefix}8ball <tanong>`),
  },
  pick: {
    run: async ({ args, prefix }) => {
      const opts = String(args || "").split(/\s*[|,]\s*/).map((x) => x.trim()).filter(Boolean);
      return opts.length >= 2 ? `👉 ${pickOne(opts)}` : `Format: ${prefix}pick pizza | burger | adobo`;
    },
  },

  remind: {
    run: async ({ args, ev, cfg, save, prefix }) => {
      const m = /^(\S+)\s+([\s\S]+)$/.exec(String(args || "").trim());
      const ms = m && parseDuration(m[1]);
      if (!m || !ms) return `Format: ${prefix}remind 10m uminom ng tubig\n(5s hanggang 7d: s, m, h, d)`;
      cfg.reminders = Array.isArray(cfg.reminders) ? cfg.reminders : [];
      if (cfg.reminders.filter((r) => r.senderID === String(ev.senderID)).length >= 5) return "Max 5 reminders kada tao 😅";
      cfg.reminders.push({
        id: Date.now() + Math.random(),
        at: Date.now() + ms,
        threadID: String(ev.threadID),
        senderID: String(ev.senderID),
        text: m[2].slice(0, 300),
      });
      save();
      return `⏰ Sige, ipapaalala ko sa ${m[1]}.`;
    },
  },

  uptime: {
    run: async ({ S }) => `⏱ Bot uptime: ${dur((Date.now() - (S.botSince || S.started)) / 1000)}\nServer: ${dur((Date.now() - S.started) / 1000)}`,
  },

  // ---------------- admin ----------------
  gcname: {
    admin: true,
    run: async ({ args, ev, gc, prefix }) => {
      const [sub = "status", ...rest] = String(args || "").trim().split(/\s+/);
      const tail = rest.join(" ").trim();
      const status = () => {
        const s = gc.status();
        return (
          `🔁 GC name cycle: ${s.on ? "ON" : "OFF"}\n` +
          `Every ~${s.intervalS}s · ${s.names.length} names · ${s.changes || 0} changes${s.fails ? ` · ${s.fails} fails` : ""}\n` +
          `Now: ${s.lastTitle || "—"}`
        );
      };

      switch (sub.toLowerCase()) {
        case "start":
        case "on": {
          const sec = parseInt(rest[0], 10);
          gc.start({ threadId: ev.threadID, ...(Number.isFinite(sec) ? { intervalS: sec } : {}) });
          return `▶️ GC name cycle ON dito sa chat na ito. Hindi titigil hanggang ${prefix}gcname stop.`;
        }
        case "stop":
        case "off":
          gc.stop();
          return "⏹ GC name cycle OFF.";
        case "now":
          gc.now();
          return "⏭ Next name na...";
        case "list": {
          const s = gc.status();
          return "📝 Names:\n" + s.names.map((n, i) => `${i + 1}. ${n}`).join("\n");
        }
        case "add":
          return tail && gc.add(tail) ? `➕ Added: ${tail}` : `Format: ${prefix}gcname add <pangalan>`;
        case "remove":
        case "del":
          return gc.remove(rest[0]) ? "➖ Removed." : `Format: ${prefix}gcname remove <number> (hindi pwedeng maubos lahat)`;
        case "set":
          return gc.setNames(tail.split("|")) ? `✅ ${gc.status().names.length} names saved.` : `Format: ${prefix}gcname set Name 1 | Name 2 | Name 3`;
        case "interval":
          return gc.setInterval(rest[0]) ? `⏲ Interval: ${gc.status().intervalS}s (min ${gc.MIN_S}s)` : `Format: ${prefix}gcname interval 45`;
        case "status":
        default:
          return status();
      }
    },
  },

  troll: {
    admin: true,
    run: async ({ args, cfg, save }) => {
      const v = String(args || "").trim().toLowerCase();
      if (v === "on" || v === "off") {
        cfg.troll = v === "on";
        save();
      }
      return `🤡 Troll replies: ${cfg.troll ? "ON" : "OFF"}`;
    },
  },
};

function resolve(name) {
  let cmd = COMMANDS[name];
  if (cmd && cmd.alias) cmd = COMMANDS[cmd.alias];
  return cmd || null;
}

/** Parse "!music foo" -> { name: "music", args: "foo" } (null if not a command) */
function parse(body, prefix) {
  const text = String(body || "").trim();
  if (!text.startsWith(prefix)) return null;
  const m = /^(\S+)(?:\s+([\s\S]*))?$/.exec(text.slice(prefix.length));
  if (!m) return null;
  return { name: m[1].toLowerCase(), args: (m[2] || "").trim() };
}

/** Background loop that fires saved reminders (survives restarts via config). */
function startReminderLoop({ cfg, save, send, ready }) {
  setInterval(() => {
    if (typeof ready === "function" && !ready()) return; // offline: keep them, fire after reconnect
    if (!Array.isArray(cfg.reminders) || !cfg.reminders.length) return;
    const now = Date.now();
    const due = cfg.reminders.filter((r) => r.at <= now);
    if (!due.length) return;
    cfg.reminders = cfg.reminders.filter((r) => r.at > now);
    save();
    for (const r of due) Promise.resolve(send(r.threadID, `⏰ Paalala: ${r.text}`)).catch(() => {});
  }, 5000);
}

module.exports = { COMMANDS, resolve, parse, startReminderLoop, calc };
