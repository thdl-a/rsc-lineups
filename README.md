# RSC Lineups & Tryouts

A web page for RSC 3s GMs and management to:

- **Lineups**: list every 3-player lineup for a 4–7 player roster and check each one against the tier's MMR cap.
- **Tryouts**: run balanced 3v3 rotations for 6–7 players, track who won, and check team MMR.

It replaces the "RSC Lineups & Tryouts" Google Sheet template. There are no copies to make and no sheets to link. Open the page and go.

- **Live page:** https://lineups.rscna.workers.dev/ (sign in with Discord: members of the RSC server)
- **Live demo:** https://lineups.rscna.workers.dev/demo, open to anyone, invented sample data, no sign-in. The Tier Maker passcode in the demo is `demo`.

## Using it

### Lineups
1. Pick the tier. The cap, tier min and tier max appear.
2. Enter 4, 5, 6 or 7 players. Names autocomplete from Contracts.
3. Every lineup appears with:
   - **Total**: the 3 players' MMR.
   - **Room for 4th**: cap minus the total, i.e. the highest-MMR 4th player that still fits.
     - **Green**: a tier max 4th still fits.
     - **Red**: it won't fit even with a tier min 4th. Don't play these.
4. Tick **Played** after a lineup plays. The row greys out, and the Played column counts each player's games. Amber means that player is behind the others.

### Tryouts
1. Choose the **Player source**: Contracts, or Tier Maker 🔒 (management only: Admins, General Managers and Assistant GMs open it automatically when signed in; anyone else needs the passcode).
2. Pick the tier and enter 6 or 7 players. Any name works (e.g. `P1`); unknown names just have no MMR.
3. For 7 players, pick a schedule:
   - **7 games**: everyone sits once and teams up with every other player exactly twice.
   - **14 games**: the same, twice, with sides swapped.
   - **70 games**: every possible split.
   - 6 players always use all 10 splits.
4. Click **Blue won** or **Orange won** after each game (click again to undo). Each player's W–L updates.
5. **MMR Δ** = Blue total minus Orange total.

### MMR rule
- A player's MMR is their **base MMR**.
- A player from a **lower tier** (base below the selected tier's min) counts at the tier's **promoted MMR**, shaded amber. Promoted MMR is the highest Effective MMR among players in that tier's second-to-last Keeper round. If there is none, the tier min is used.
- Players already in the tier keep their own MMR.
- **Show MMR** off hides every MMR number (useful when screen-sharing with players).

### Saving and sharing
- Your setup saves automatically in your browser.
- **🔗 Copy link** copies a short link that opens your exact setup (players, tier, played games, wins). The Tier Maker passcode is never included. Older long links still work.
- **Copy for Discord** copies a text summary of lineups or tryout results.

### Player list
- Type in a player slot to filter, then click or press Enter (arrow keys and Esc work too).
- Each row shows the player's name and **tier** (Contracts column J). Tier Maker has no tier column, so it shows names only.
- In the Players box, each player has **Base** (true MMR) and **Eff.** (the MMR they count at if promoted into the selected tier; blank if not promoted) beside Played (Lineups) or W–L (Tryouts).
- Show MMR off hides the numbers.
- **Only show players of the selected tier and below** (Settings, Lineups and Tryouts; Contracts source only): with a tier selected, the list offers only that tier and the tiers under it. Players with no tier listed come last. Turning it on, or changing the tier, takes any entered players above that tier out of their slots (a message names them). Your choice is remembered in your browser and is not part of shared links.

### Theme
- Click your Discord username (top right) and choose **Auto** (follows your device), **Light** or **Dark**. It is remembered per browser.

### Header
- The title shows the current season, e.g. **• S28**. It comes from the title of the Contracts sheet (`CONTRACTS_ID`), e.g. "S28 RSC 3s Contracts". Only if that title has no season does it fall back to the Draft Board Analyzer's season (its public `?action=season`).
- **Status pill**: player count. Click it for each tier's min, max, cap and promoted MMR, plus any data notes.
- **Refresh** re-reads the sheets. The page also refreshes every 5 minutes while in use.
- Your Discord username is the last button on the right. It opens a menu with who you are signed in as, the Theme (Auto / Light / Dark) and **Sign out**.

## How it works

```
                                                         ┌─► Contracts sheet
Browser ──► Cloudflare Worker (worker.js) ──key──► Apps Script (Code.gs)
            Discord sign-in, 60 s cache, /demo           └─► Tier Maker sheet (passcode)
```

- **`public/index.html`**: the whole app (one file). Schedules, MMR rules, cap checks and saving all run in the browser. It loads data from `/api/data` on the same site.
- **`worker.js`**: a Cloudflare Worker with static assets. It handles Discord sign-in, serves the page, proxies data from Apps Script and caches the Contracts data for 60 seconds (**Refresh** bypasses the cache). It also serves `/demo`.
- **`Code.gs`**: the Apps Script data endpoint, a standalone script deployed as a web app (*Execute as: Me*, *Who has access: Anyone*). It is pasted into script.google.com and not served from here. The sheet IDs are not in the code: they are Script Properties (`CONTRACTS_ID`, `TIER_MAKER_ID`), so this file can be pasted into Apps Script as is. It reads:
  - Contracts → `Contracts` (players, with tier in column J), `Tiers` (min/max/cap), `Count/Keeper` (promoted MMR)
  - Tier Maker → `GM Tier List` (players, tier table, promoted MMR)

  Tier Maker data is returned only when the passcode matches the script property `TM_KEY`.

## How auth works

1. A visitor without a session gets a "Sign in with Discord" page. A shared `#c=` link survives the sign-in.
2. **Sign in** goes to Discord OAuth with the scopes `identify guilds.members.read`. No bot is involved, and nothing is posted to Discord.
3. On the way back, the Worker checks membership in the RSC server (`GET /users/@me/guilds/{GUILD_ID}/member`). A 200 response means the visitor gets in; a 404 means they are not a member and get "Join the RSC server". The Discord token is revoked right after this check.
4. The Worker sets an HMAC-signed, `HttpOnly; Secure; SameSite=Lax` cookie holding the Discord id, the username and an expiry 3 days out (`sessionDays` in the `APP` block of `worker.js`). Nothing is stored on the server.
5. Apps Script answers only when the Worker's shared key (`GAS_SECRET`) matches. A direct call to the `/exec` link without the key returns `{"error":"unauthorized"}`.
6. The Tier Maker opens one of two ways. **By role:** the session also keeps the member's Discord role ids; a member with any role in `TM_ROLE_IDS` (Admin, General Manager, Assistant GM) needs no passcode: the Worker tells Apps Script `tmrole=1` (only the Worker can set it; it drops anything the browser sends, and Apps Script honours it only with the shared `GAS_SECRET`). **By passcode:** everyone else enters `TM_KEY`; the page sends it as `tmkey`, the Worker passes it through, and Apps Script checks it. Roles are read at sign-in (every 3 days), so a changed role takes effect at the next sign-in.

**Security headers.** Every response gets `X-Content-Type-Options: nosniff`, `Referrer-Policy: same-origin` and `X-Frame-Options: DENY`. Pages also get a strict `Content-Security-Policy`: scripts run only if they carry a nonce that is new for every response (the Worker stamps it on each `<script>`), and the page may connect, load images and submit forms only to this site; no other site may frame it. It is a second lock behind the page's own escaping. Keep new page code inside `<script>` tags: inline `onclick="..."` handlers, `javascript:` links and outside URLs are blocked (a test in `test/worker.test.mjs` checks this). Because the nonce changes, pages are never served from a cached copy without asking: the demo and other public pages are `no-cache`, and the signed-in page stays `private, no-store` because it shows the username.

| Name | Where |
|---|---|
| `DISCORD_CLIENT_ID`, `GUILD_ID`, `GAS_URL`, `TM_ROLE_IDS` | `wrangler.jsonc` vars |
| `DISCORD_CLIENT_SECRET`, `SESSION_SECRET`, `GAS_SECRET` | Worker secrets (`wrangler secret put NAME`) |
| `DEV_IDS` | Worker secret (optional): Discord ids of the site's developer(s). They always get in, even outside the server, and hold the Admin role (and the Tier Maker roles in Lineups). The id comes from Discord's own sign-in answer, so it cannot be claimed. Kept as a secret so it is not in the public repo. |
| `GAS_SECRET`, `TM_KEY`, `CONTRACTS_ID`, `TIER_MAKER_ID` | Apps Script > Project Settings > Script properties |

None of the secrets are in this repo.

## Demo mode

`/demo` serves the same page. The page sees `/demo` in its path and switches to demo mode:
- It loads `public/demo-data.json` (Contracts) and `public/demo-data-tm.json` (Tier Maker, passcode `demo`) and makes no Apps Script calls.
- Your demo setup is saved separately from your real one.
- The header shows "Demo – sample data".

The data is invented: fake players with made-up MMRs across all 10 tiers. It is generated by `node scripts/make-demo-data.mjs` and has the same shape as `getData_()` in `Code.gs`.

## Maintenance

**Starting a new season?** Follow [`NEW-SEASON.md`](NEW-SEASON.md): it covers Lineups and the Draft Board Analyzer.

| Task | What to do |
|---|---|
| New season / new sheets | In Apps Script > Project Settings > Script Properties, change `CONTRACTS_ID` and `TIER_MAKER_ID` to the new sheets' IDs (the part of the link between `/d/` and `/edit`), then run `testRead`. No code edit and no redeploy. The Draft Board's season label (`Import!B1` / `B3`) sets the header. |
| Change the Tier Maker passcode | Apps Script → Project Settings → Script properties → edit `TM_KEY`. No redeploy needed. |
| Change `Code.gs` | Save, then deploy a **New version** (the URL stays the same). |
| Change the page or Worker | Edit `public/index.html` or `worker.js` and push to `main`. Workers Builds deploys in about a minute. |
| Rotate a secret | `npx wrangler secret put NAME`. For `GAS_SECRET`, also update the Script property. Changing `SESSION_SECRET` signs everyone out. |
| Data looks old | Click **Refresh**. Sheet edits show within about 60 s. |
| Tab or column layout changes in a source sheet | Update the matching constants and ranges in `Code.gs`. |
| Demo data | Edit `scripts/make-demo-data.mjs`, run it and commit the two JSON files. |
| Tests | `node --test test/` (Worker sign-in, access rules and proxy, with Discord and Apps Script mocked). |

## Files

- `public/index.html`: the web app; `public/rsc-logo.png`: the logo; `public/demo-data*.json`: demo data
- `worker.js`, `wrangler.jsonc`: the Cloudflare Worker and its config
- `Code.gs`: the Apps Script data endpoint (paste into script.google.com)
- `scripts/make-demo-data.mjs`: demo data generator
- `test/worker.test.mjs`: Worker tests
- `changelog.txt`: what changed, from the original sheet template to this web app
- `README.md`: this file
