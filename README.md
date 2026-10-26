# Celestial Troll Bot

Troll bot na may pagka-assistant para sa Facebook Messenger. Lahat ng file ay nasa **root** (walang subfolder).

- Humanized na troll replies (`replies.json`) na may **working typing indicator**
- `!music (title) artist` — info + 30s audio preview + link
- **GC name cycle** na hindi titigil hangga't hindi mo pinapatay
- Assistant commands: `!ask`, `!weather`, `!calc`, `!define`, `!time`, `!remind`, `!roll`, `!8ball`, `!pick`...
- Auto-reconnect, auto-save ng cookie, auto-resume pag nag-restart ang server

## Files (lahat nasa root)
`server.js` (main) · `commands.js` · `music.js` · `gcname.js` · `human-typing.js` · `banat-*.js` · `human-*.js` · `replies.json` · `index.html` (dashboard) · `package.json` · `railway.json` · `.gitignore`

## Deploy (Railway)
1. Push sa GitHub → New Project → Deploy.
2. Mag-mount ng Volume at i-set ang `DATA_DIR=/app/data` (dito sine-save ang cookie at settings; kapag wala, mawawala ito sa bawat redeploy).
3. Buksan ang domain → paste cookie → **Save & connect** → pili ng GC → **Start**.
4. Optional na pang-lock ng dashboard: `ADMIN_PASSWORD`.

> **Huwag i-commit ang cookie.** Naka-`.gitignore` na ang `config.json`, `appstate.json`, `account.txt`. Kapag public ang repo, sinuman ay makaka-login sa account mo gamit ang cookie.

## Lazymeta FCA
Ang bot ay gumagamit lang ng standard na fca API (`login`, `listenMqtt`, `sendMessage`, `setTitle`, `sendTypingIndicator`, `getAppState`, `markAsRead`, `setMessageReaction`). Para gamitin ang lazymeta build mo:

```
npm i <pangalan-ng-lazymeta-package>
FCA_PACKAGE=<pangalan-ng-lazymeta-package>      # Railway Variable (o "fcaPackage" sa config.json)
```

Kung walang `FCA_PACKAGE`, `@dongdev/fca-unofficial` ang gagamitin. Makikita sa dashboard (taas) kung alin ang naka-load.

## Commands (prefix `!`)
**Lahat (sa napiling GC kapag naka-Start ang bot):**

| Command | Ginagawa |
|---|---|
| `!music (title) artist` | Info + 30s preview + link. Gumagana rin: `title - artist`, `title \| artist`, `title by artist`, o title lang |
| `!ask <tanong>` | Sagot ni Claude (kailangan ng `ANTHROPIC_API_KEY`; model: `ASSISTANT_MODEL`, default `claude-haiku-5-5`) |
| `!weather <lugar>` | Panahon (Open-Meteo, walang key) |
| `!calc <math>` | `+ - * / % ^ ( )` (walang eval) |
| `!define <word>` | English definition |
| `!time [timezone]` | Oras, hal. `!time Asia/Tokyo` |
| `!remind 10m <text>` | `s/m/h/d`, max 7d, max 5 kada tao, saved sa config |
| `!roll [NdM]` `!flip` `!8ball` `!pick a \| b \| c` `!uptime` `!help` | |

**Admin lang** (ang mismong bot account, o mga ID sa `ADMIN_IDS` env / `admins` sa config):

| Command | Ginagawa |
|---|---|
| `!gcname start [sec]` | Simulan ang cycle sa chat na pinag-typan mo |
| `!gcname stop` | Patayin ang cycle |
| `!gcname status` / `list` / `now` | Status, listahan, next name agad |
| `!gcname add <name>` / `remove <#>` / `set A \| B \| C` | Ayusin ang listahan |
| `!gcname interval <sec>` | Min 10s |
| `!troll on\|off` | Patayin/buksan ang random troll replies (gumagana pa rin ang commands) |

Pwede mong i-type ang admin commands mismo sa GC gamit ang bot account (naka-`selfListen`), o gamitin ang **GC name cycle** card sa dashboard.

## "Ala patayan" — paano hindi namamatay
- **GC cycle**: naka-save ang `on` sa config; pagka-login ulit (restart/reconnect), kusang magre-resume. Ang error ay nagpapabagal lang (backoff hanggang 10 min), hindi nagpapatigil. Huminto lang kapag `!gcname stop` o Stop sa dashboard.
- **Reconnect**: unlimited na retry (backoff 8s → 5 min, tapos kada 30 min). Kapag checkpoint/expired, naka-pause ang mabilis na retry at may pulang banner, pero susubukan pa rin kada 30 min.
- **Process**: hindi namamatay sa stray exception; `restartPolicyType: ALWAYS` sa Railway; `/health` endpoint. Para sa hosts na natutulog, i-set ang `SELF_URL=https://domain-mo` para mag-self-ping.
- Cookie na ni-refresh ay sine-save kada 5 min kung may pagbabago at pag-shutdown.

## Typing indicator
Ang lumang `human-typing.js` ay hindi napapatay ang indicator (walang `sendTyping` sa fca). Ngayon: sine-save ang `end()` na ibinabalik ng `sendTypingIndicator`, nire-refresh kada 4.5s habang naghihintay (music search, `!ask`), at laging pinapatay pagkatapos mag-send (may 45s safety cutoff).

## Env (optional)
`ADMIN_PASSWORD` · `DATA_DIR` · `BOT_TZ` (default `Asia/Manila`) · `FCA_PACKAGE` · `ADMIN_IDS` (comma-separated) · `APPSTATE` (cookie JSON para sa unang boot) · `ANTHROPIC_API_KEY` · `ASSISTANT_MODEL` · `SELF_URL` · `BANAT_TYPO_RATE` · `BANAT_SHORTHAND_RATE` · `BANAT_HESITATION_RATE`

## Mga dapat tandaan
- **`!music` ay 30-segundong preview** (Deezer, fallback iTunes) kasama ang link ng buong kanta. Walang full-song download.
- **Ang GC name cycle ay nagpo-post ng "X named the group Y" sa bawat palit.** Mas mabilis ang interval, mas maingay at mas mataas ang tsansang ma-flag. Para sa mahabang buhay ng account, gumamit ng 45s pataas.
- Ang troll replies ay may limits (skip rate, cooldown, hourly/daily cap, quiet hours). Ang commands ay may hiwalay na cooldown (4s kada tao, 150/oras).
- Labag sa Terms ng Facebook ang unofficial automation; may risk na ma-restrict o ma-lock ang account. Gumamit ng account na kaya mong mawala.
