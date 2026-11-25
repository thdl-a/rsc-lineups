# RSC Lineups & Tryouts

A web page for RSC 3s GMs and management to:

- **Lineups**: list every 3-player lineup for a 5–7 player roster and check each one against the tier's MMR cap.
- **Tryouts**: run balanced 3v3 rotations for 6–7 players, track who won, and check team MMR.

It replaces the "RSC Lineups & Tryouts" Google Sheet template. There are no copies to make and no sheets to link. Open the page and go.

**Live page:** https://thdl-a.github.io/rsc-lineups/

## Using it

### Lineups
1. Pick the tier. The cap, tier min and tier max appear.
2. Enter 5, 6 or 7 players. Names autocomplete from Contracts.
3. Every lineup appears with:
   - **Total**: the 3 players' MMR.
   - **Room for 4th**: cap minus the total, i.e. the highest-MMR 4th player that still fits.
     - **Green**: a tier max 4th still fits.
     - **Red**: it won't fit even with a tier min 4th. Don't play these.
4. Tick **Played** after a lineup plays. The row greys out, and the Played column counts each player's games. Amber means that player is behind the others.

### Tryouts
1. Choose the **Player source**: Contracts, or Tier Maker 🔒 (management only, needs the passcode).
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
- **🔗 Copy link** copies a link that opens your exact setup (players, tier, played games, wins). The Tier Maker passcode is never included.
- **Copy for Discord** copies a text summary of lineups or tryout results.

### Player list
- Type in a player slot to filter, then click or press Enter (arrow keys and Esc work too).
- Each row shows the player's **tier** (from their MMR), **Base** MMR (true MMR) and, once a tier is selected, **Eff.** (the MMR they count at if promoted into that tier).
- Show MMR off hides the numbers.

### Theme
- The **Theme** button cycles Auto (follows your device), Light and Dark. It is remembered per browser.

### Header
- **Status pill**: player count. Click it for each tier's min, max, cap and promoted MMR, plus any data notes.
- **Refresh** re-reads the sheets. The page also refreshes every 5 minutes while in use.

## How it works

```
Contracts sheet ─┐
                 ├─► Google Apps Script (Code.gs) ──JSON──► index.html (GitHub Pages)
Tier Maker sheet ┘     60 s cache, passcode for Tier Maker     all logic runs in the browser
```

- **`index.html`**: the whole app (one file). Schedules, MMR rules, cap checks and saving all run in the visitor's browser. `API_URL` near the top points at the Apps Script.
- **Apps Script** (not in this repo; stored in the RSC Admin project as `Code.gs`): a standalone script deployed as a web app (*Execute as: Me*, *Who has access: Anyone*). It reads:
  - Contracts → `Contracts` (players), `Tiers` (min/max/cap), `Count/Keeper` (promoted MMR)
  - Tier Maker → `GM Tier List` (players, tier table, promoted MMR)

  Tier Maker data is returned only when the passcode matches the script property `TM_KEY`.

## Maintenance

| Task | What to do |
|---|---|
| New season / new sheets | In Apps Script, update `CONTRACTS_ID` and `TIER_MAKER_ID` at the top of `Code.gs`, run `testRead`, then **Deploy → Manage deployments → ✏️ → New version**. |
| Change the Tier Maker passcode | Apps Script → Project Settings → Script properties → edit `TM_KEY`. No redeploy needed. |
| Change `Code.gs` | Save, then deploy a **New version** (the URL stays the same). |
| Change the page | Edit `index.html` in this repo. GitHub Pages updates in about a minute. |
| Data looks old | Click **Refresh**. Sheet edits show within about 60 s. |
| Tab or column layout changes in a source sheet | Update the matching constants and ranges in `Code.gs`. |

## Files

- `index.html`: the web app
- `changelog.txt`: what changed, from the original sheet template to this web app
- `README.md`: this file
