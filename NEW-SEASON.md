# New season checklist

Both apps need only settings changes each season: no code change, no deploy, nothing in Cloudflare or GitHub.

## Lineups & Tryouts (about 2 minutes)

1. Open the **Lineups** Apps Script project > gear icon (**Project Settings**) > **Script Properties** > **Edit script properties**.
2. Change these two to the new season's sheet IDs (the part of the sheet link between `/d/` and `/edit`):
   - `CONTRACTS_ID`
   - `TIER_MAKER_ID`
3. Click **Save script properties**.
4. Optional check: run `testRead` in the editor. It should list 10 tiers for each sheet and end with `Passcode set: yes` and `Worker key set: yes`.

Notes
- The season label in the header comes from the new Contracts sheet's title (e.g. "S28 RSC 3s Contracts"), so rename the sheet if its title has no season. Only then does it fall back to the Draft Board's label (see below).
- The Google account that owns the script must be able to open the new sheets.
- No redeploy. Data shows up within about a minute (**Refresh** forces it).
- Change `TM_KEY` (same Script Properties screen) only if you want a new Tier Maker passcode.
- If a new season renames tabs or moves columns (`Contracts`, `Tiers`, `Count/Keeper`, `GM Tier List`), that is a code change: update the constants at the top of `Code.gs` and deploy it (Claude does this with `clasp`; by hand it is paste into Apps Script, then **Deploy > Manage deployments > Edit > New version**).

## Draft Board Analyzer (about 2 minutes, all in the sheet)

1. Open the DBA sheet > **Import** tab.
2. Paste the new links:
   - **B1**: the new draft layout file
   - **B2**: the new contracts sheet
3. Check the tab names in **B5**, **B6** and **B7** (`Picks`, `Teams`, `Contracts` today). Change them only if the new files renamed those tabs.
4. The first time a link is used, open **Picks Data**, **Tier Settings** and **Teams Data** and click **Allow access**.
5. Optional: if the draft layout file's name has no "S##" (like "S29"), type the label in **B3**. It overrides.

Notes
- The Trade Hub header season comes from the "S##" in the file name linked in B1. Lineups has its own: the "S##" in the Contracts sheet's title (it only uses this one if its own title has none).
- Trade Board: the old season's posts stay on the Trade Board tab. Use **Admin > Clear** (Admin role, click twice) at the start of a season to wipe them. Clear removes the Notes as well.
- No Script Property changes and no redeploy. Data shows up within about 3 minutes (**Refresh** forces it).

## Every even season (franchise renames)

When the API pushes renamed franchises (the Franchises tab of the contracts sheet updates by itself), open the DBA sheet > **Franchise Roles** tab and update the **Franchise** name next to each Role ID. The Role ID stays the same. A new franchise gets a new row. Then run `testRead` in the DBA Apps Script: it lists any franchise with no role and any role whose name is no longer on the Draft Board. Column C holds the GM's name as a backup: if only the franchise was renamed and the GM is the same, Assistant GMs keep working even before you edit the tab (testRead lists those rows). If the franchise and its GM both changed, they cannot post until the tab is updated. GMs are not affected: they are linked through the contracts sheet. The franchise list inside `setupTabs` in `Code.gs` is only the starting set for a brand-new tab; edit the tab, not the code.

## Remember

- The contracts sheet is set in two places: `Import!B2` (DBA) and the `CONTRACTS_ID` Script Property (Lineups). Update both. The DBA also uses `Import!B2` to link a Discord account to its GM (tabs `MMS`, `Contracts`, `Franchises`, which do not change name), so until it points at the new season's sheet GMs may not be able to post.
- Never needed for a new season: Cloudflare secrets or settings, GitHub pushes, `GAS_SECRET`, `SESSION_SECRET`, the Discord secret.
- Sheet IDs are never stored in the repos. They live only in Apps Script Script Properties.

## If something looks wrong

| Symptom | Likely cause |
|---|---|
| "Script Property CONTRACTS_ID / TIER_MAKER_ID / SHEET_ID is not set" | The property is missing or misspelled in Script Properties. |
| Lineups header shows the old season | The Contracts sheet's title (`CONTRACTS_ID`) still says the old season: rename it or point `CONTRACTS_ID` at the new sheet. |
| Trade Hub header shows the old season | `Import!B1` still points at the old file, or fill `Import!B3`. |
| DBA data empty or `#REF!` | Click **Allow access** on Picks Data, Tier Settings and Teams Data. |
| Tier Maker "Wrong passcode" | `TM_KEY` in the Lineups Script Properties was changed. |
| Site shows "Apps Script rejected the Worker key" | `GAS_SECRET` differs between the Worker and the Script Properties. |
