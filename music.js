"use strict";

/**
 * !music <title> [artist]
 *
 * Accepted formats:
 *   !music (Blinding Lights) The Weeknd
 *   !music Blinding Lights - The Weeknd
 *   !music Blinding Lights | The Weeknd
 *   !music Blinding Lights by The Weeknd
 *   !music blinding lights the weeknd
 *
 * Source: Deezer public search (no key) with iTunes Search as fallback.
 * Both only expose official ~30 second previews, so that is what gets sent
 * (as an audio attachment) together with the track info and the official link.
 */

const fs = require("fs");
const os = require("os");
const path = require("path");

const MAX_PREVIEW_BYTES = 6 * 1024 * 1024;

async function getJson(url, ms = 12_000) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), ms);
  try {
    const res = await fetch(url, { signal: ctl.signal, headers: { "user-agent": "troll-bot/3" } });
    if (!res.ok) throw new Error("HTTP " + res.status);
    return await res.json();
  } finally {
    clearTimeout(t);
  }
}

function parseQuery(raw) {
  const text = String(raw || "").trim();
  if (!text) return null;

  let m = text.match(/^\(([^)]+)\)\s*(.*)$/); // (title) artist
  if (m) return { title: m[1].trim(), artist: m[2].trim() };

  m = text.match(/^(.+?)\s+(?:-|–|—|\||by)\s+(.+)$/i); // title - artist
  if (m) return { title: m[1].trim(), artist: m[2].trim() };

  return { title: text, artist: "" };
}

const norm = (s) =>
  String(s || "")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9 ]/g, " ")
    .replace(/\s+/g, " ")
    .trim();

function score(track, q) {
  const title = norm(track.title);
  const artist = norm(track.artist);
  const wantTitle = norm(q.title);
  const wantArtist = norm(q.artist);
  let s = 0;
  if (title === wantTitle) s += 6;
  else if (title.includes(wantTitle) || wantTitle.includes(title)) s += 3;
  if (wantArtist) {
    if (artist === wantArtist) s += 6;
    else if (artist.includes(wantArtist) || wantArtist.includes(artist)) s += 4;
  } else {
    // no artist given: tiny nudge when the combined text matches
    if (norm(`${track.title} ${track.artist}`).includes(wantTitle)) s += 1;
  }
  if (/karaoke|tribute|cover|instrumental|8d|nightcore|sped up|slowed/i.test(`${track.title} ${track.album}`)) s -= 5;
  return s;
}

function pickBest(list, q) {
  const usable = list.filter((t) => t.previewUrl);
  if (!usable.length) return null;
  return usable.map((t) => ({ t, s: score(t, q) })).sort((a, b) => b.s - a.s)[0].t;
}

async function searchDeezer(q) {
  const query = q.artist ? `artist:"${q.artist}" track:"${q.title}"` : q.title;
  let data = await getJson(`https://api.deezer.com/search?limit=15&q=${encodeURIComponent(query)}`);
  let items = Array.isArray(data.data) ? data.data : [];
  if (!items.length && q.artist) {
    data = await getJson(`https://api.deezer.com/search?limit=15&q=${encodeURIComponent(`${q.title} ${q.artist}`)}`);
    items = Array.isArray(data.data) ? data.data : [];
  }
  return items.map((x) => ({
    title: x.title,
    artist: x.artist && x.artist.name,
    album: x.album && x.album.title,
    durationS: x.duration,
    previewUrl: x.preview,
    link: x.link,
    source: "Deezer",
  }));
}

async function searchItunes(q) {
  const term = `${q.title} ${q.artist}`.trim();
  const data = await getJson(
    `https://itunes.apple.com/search?media=music&entity=song&limit=15&term=${encodeURIComponent(term)}`
  );
  return (Array.isArray(data.results) ? data.results : []).map((x) => ({
    title: x.trackName,
    artist: x.artistName,
    album: x.collectionName,
    durationS: x.trackTimeMillis ? Math.round(x.trackTimeMillis / 1000) : null,
    previewUrl: x.previewUrl,
    link: x.trackViewUrl,
    source: "Apple Music",
  }));
}

async function findTrack(q) {
  for (const search of [searchDeezer, searchItunes]) {
    try {
      const best = pickBest(await search(q), q);
      if (best) return best;
    } catch {
      /* try the next source */
    }
  }
  return null;
}

async function downloadPreview(url) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), 20_000);
  try {
    const res = await fetch(url, { signal: ctl.signal });
    if (!res.ok) throw new Error("HTTP " + res.status);
    const buf = Buffer.from(await res.arrayBuffer());
    if (!buf.length || buf.length > MAX_PREVIEW_BYTES) throw new Error("bad preview size");
    const ext = /\.m4a(\?|$)/i.test(url) ? "m4a" : "mp3";
    const file = path.join(os.tmpdir(), `music-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${ext}`);
    fs.writeFileSync(file, buf);
    return file;
  } finally {
    clearTimeout(t);
  }
}

const fmtTime = (s) => (Number.isFinite(s) && s > 0 ? `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}` : null);

/** @returns {Promise<string | {body, attachment, cleanup}>} */
async function musicCommand(rawArgs, prefix = "!") {
  const q = parseQuery(rawArgs);
  if (!q) return `Format: ${prefix}music (title) artist\nHal: ${prefix}music (Blinding Lights) The Weeknd`;

  const track = await findTrack(q);
  if (!track) return `Walang nahanap para sa "${[q.title, q.artist].filter(Boolean).join(" - ")}" 😅 Subukan mong i-check ang spelling o dagdagan ng artist.`;

  const lines = [
    `🎵 ${track.title}`,
    `👤 ${track.artist || "Unknown artist"}`,
    track.album ? `💿 ${track.album}` : null,
    fmtTime(track.durationS) ? `⏱ ${fmtTime(track.durationS)}` : null,
    track.link ? `🔗 Full song: ${track.link}` : null,
    `(30s preview via ${track.source})`,
  ].filter(Boolean);
  const body = lines.join("\n");

  let file = null;
  try {
    file = await downloadPreview(track.previewUrl);
  } catch {
    return body + "\n⚠️ Hindi ma-download ang preview ngayon.";
  }

  const stream = fs.createReadStream(file);
  stream.on("error", () => {}); // e.g. file removed before it was read; never crash the bot over a preview

  return {
    body,
    attachment: stream,
    cleanup: () => {
      try { stream.destroy(); } catch {}
      fs.unlink(file, () => {});
    },
  };
}

module.exports = { musicCommand, parseQuery };
