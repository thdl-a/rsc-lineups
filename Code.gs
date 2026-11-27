/**
 * RSC Lineups & Tryouts – data endpoint for https://lineups.rscna.workers.dev
 *
 * Reads the Contracts sheet and the Tier Maker sheet (management only, passcode
 * required) and returns JSON to the Cloudflare Worker, which handles Discord
 * sign-in and serves the page. All lineup and tryout logic runs in the browser.
 *
 * URLs (append to the /exec URL; every call needs key=GAS_SECRET):
 *   ?action=data&key=GAS_SECRET                        Contracts data
 *   ?action=data&key=GAS_SECRET&src=tm&tmkey=PASSCODE  Tier Maker data (passcode required)
 *   add &force=1 to skip the 60 s cache (Refresh button)
 *   without the right key: {error:'unauthorized'}
 *
 * Deploy: Deploy > New deployment > Web app
 *         Execute as: Me    Who has access: Anyone
 * Script properties (Project Settings > Script properties; never in this file):
 *   GAS_SECRET    = same value as the Worker's GAS_SECRET secret
 *   TM_KEY        = the Tier Maker passcode
 *   CONTRACTS_ID, TIER_MAKER_ID = the two sheet IDs (change them each season)
 */

// ---- Settings -------------------------------------------------------------

// Source spreadsheets: Project Settings > Script Properties > CONTRACTS_ID and TIER_MAKER_ID
// (an ID is the part of the sheet's link between /d/ and /edit). New season = change the two
// properties; no code edit or redeploy. They are not kept in this file, so the real IDs never
// go to GitHub and this file can be pasted as is.
function sheetId_(prop) {
  const id = PropertiesService.getScriptProperties().getProperty(prop);
  if (!id) throw new Error('Script Property ' + prop + ' is not set (Project Settings > Script Properties).');
  return id.trim();
}

// Contracts tabs
const C_PLAYERS = 'Contracts';     // A:J  RSC ID, Player Name, Franchise, Team, Base MMR, Effective MMR, Status, ..., J = Tier
const C_TIERS   = 'Tiers';         // A:K  Tier, Teams, Min FA/Team, Ideal Δ, Max MMR, Min MMR, Δ, T Max, T Min, T Δ, MMR Cap
const C_KEEPER  = 'Count/Keeper';  // D:G  Effective MMR, Tier, Count, Keeper

// Tier Maker tab
const TM_TAB    = 'GM Tier List';  // B:D Name, Base, Effective · D:G Effective, Tier, Count, Keeper · I:S tier table

// Player statuses included from Contracts (same as the template's Data tab)
const STATUSES = ['Rostered', 'Free Agent', 'Permanent Free Agent', 'Perm FA in Waiting.', 'GM (Unsigned)'];

// Tier colors (match the Draft Board). Unknown tiers show gray.
const TIER_COLORS = {
  'Legend':     '#cccccc',
  'Premier':    '#d600d6',
  'Master':     '#8e7cc3',
  'Elite':      '#6fa8dc',
  'Veteran':    '#33ffda',
  'Rival':      '#93c47d',
  'Challenger': '#ffd966',
  'Prospect':   '#f6b26b',
  'Contender':  '#e06666',
  'Amateur':    '#f3a9a9'
};

const FRESH_SECONDS  = 60;     // visitors share one read of the sheet for this long
const BACKUP_SECONDS = 21000;  // ~6 h: last good copy, served if a read fails
const MIN_FORCE_AGE  = 15;     // Refresh cannot re-read more often than this (seconds)
const CHUNK_SIZE     = 30000;  // cache values are limited to 100 KB each
const MAX_BAD_KEYS   = 20;     // wrong passcodes allowed per 10 minutes before a 10 minute lockout

// ---- Web app entry --------------------------------------------------------

function doGet(e) {
  const p = (e && e.parameter) || {};
  let out;
  try {
    if (!authorized_(p.key)) out = JSON.stringify({ error: 'unauthorized' });
    else if (p.action !== 'data') out = JSON.stringify({ ok: true, msg: 'RSC Lineups & Tryouts data endpoint' });
    else if (p.src === 'tm') out = tierMakerGate_(p.tmkey, p.force === '1');
    else out = getData_('c', p.force === '1');
  } catch (err) {
    out = JSON.stringify({ error: 'server', message: String(err && err.message || err) });
  }
  return ContentService.createTextOutput(out).setMimeType(ContentService.MimeType.JSON);
}

// The Worker sends the shared key (Script property GAS_SECRET). No property set = nobody gets in.
function authorized_(key) {
  const want = PropertiesService.getScriptProperties().getProperty('GAS_SECRET');
  return !!want && !!key && sameText_(String(key), want);
}

// Tier Maker is only returned with the right passcode (Script property TM_KEY).
function tierMakerGate_(key, force) {
  const want = PropertiesService.getScriptProperties().getProperty('TM_KEY');
  if (!want) return JSON.stringify({ error: 'no_key_set' });
  const cache = CacheService.getScriptCache();
  const fails = Number(cache.get('tm_fail') || 0);
  if (fails >= MAX_BAD_KEYS) return JSON.stringify({ error: 'locked' });
  if (!key || !sameText_(String(key), want)) {
    cache.put('tm_fail', String(fails + 1), 600);
    Utilities.sleep(1000);
    return JSON.stringify({ error: 'bad_key' });
  }
  return getData_('tm', force);
}

function sameText_(a, b) {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}

// Cached read. src = 'c' (Contracts) or 'tm' (Tier Maker). Returns a JSON string.
function getData_(src, force) {
  const cache = CacheService.getScriptCache();
  const key = 'lt1_' + src;
  const now = Date.now();
  const usable = function (json) {
    if (!json) return false;
    if (!force) return true;
    try { return (now - JSON.parse(json).builtAt) / 1000 < MIN_FORCE_AGE; } catch (e) { return false; }
  };

  let json = readCache_(cache, key);
  if (usable(json)) return json;

  const lock = LockService.getScriptLock();
  const locked = lock.tryLock(15000);
  try {
    json = readCache_(cache, key);
    if (usable(json)) return json;
    json = JSON.stringify(src === 'tm' ? buildTierMaker_() : buildContracts_());
    writeCache_(cache, key, json, FRESH_SECONDS);
    writeCache_(cache, key + '_bak', json, BACKUP_SECONDS);
    return json;
  } catch (err) {
    const bak = readCache_(cache, key + '_bak');
    if (bak) {
      const data = JSON.parse(bak);
      data.stale = true;
      data.error = String(err && err.message || err);
      return JSON.stringify(data);
    }
    throw err;
  } finally {
    if (locked) lock.releaseLock();
  }
}

// ---- Read the sheets ------------------------------------------------------

function buildContracts_() {
  const ss = SpreadsheetApp.openById(sheetId_('CONTRACTS_ID'));

  // Players: [name, base MMR, status, team, tier]  (tier = column J; Tier Maker has no tier column)
  const pSh = tab_(ss, C_PLAYERS);
  const pLast = Math.max(pSh.getLastRow(), 2);
  const raw = pSh.getRange(2, 1, pLast - 1, 10).getValues();
  const players = [];
  raw.forEach(function (r) {
    const name = String(r[1]).trim();
    const status = String(r[6]).trim();
    if (!name || STATUSES.indexOf(status) < 0) return;
    players.push([name, num_(r[4]), status, String(r[3]).trim(), String(r[9]).trim()]);
  });

  // Tiers: [name, min, max, cap]
  const tiers = readTiers_(tab_(ss, C_TIERS).getRange('A2:K21').getValues());

  // Promoted MMR per tier from Count/Keeper D:G
  const kSh = tab_(ss, C_KEEPER);
  const kLast = Math.max(kSh.getLastRow(), 2);
  const kRows = kSh.getRange(2, 4, kLast - 1, 4).getValues()
    .map(function (r) { return [num_(r[0]), String(r[1]).trim(), num_(r[3])]; });
  addPromoted_(tiers, kRows);

  return finish_('c', players, tiers, season_(ss));
}

function buildTierMaker_() {
  const ss = SpreadsheetApp.openById(sheetId_('TIER_MAKER_ID'));
  const sh = tab_(ss, TM_TAB);
  const last = Math.max(sh.getLastRow(), 2);
  const raw = sh.getRange(2, 2, last - 1, 6).getValues();   // B:G
  const players = [];
  const kRows = [];
  raw.forEach(function (r) {
    const name = String(r[0]).trim();
    if (name) players.push([name, num_(r[1]), '', '', '']);
    kRows.push([num_(r[2]), String(r[3]).trim(), num_(r[5])]);  // D Effective, E Tier, G Keeper
  });
  const tiers = readTiers_(sh.getRange('I2:S21').getValues());
  addPromoted_(tiers, kRows);
  return finish_('tm', players, tiers, season_(ss));
}

// Tier table rows (Contracts Tiers A:K or Tier Maker I:S share the same columns)
function readTiers_(rows) {
  const tiers = [];
  const seen = {};
  rows.forEach(function (r) {
    const name = String(r[0]).trim();
    if (!name || seen[name]) return;   // a tier name repeated further down (e.g. a second block of min-only rows) is ignored: the first row wins
    const mn = num_(r[5]), mx = num_(r[4]), cap = num_(r[10]);
    if (mn === '' && mx === '' && cap === '') return;   // skips summary rows such as "Totals"
    seen[name] = true;
    tiers.push([name, mn, mx, cap, '']);  // name, min, max, cap, promoted
  });
  if (!tiers.length) throw new Error('Tier table is empty');
  return tiers;
}

/**
 * Promoted MMR (same rule as the template's Data!AK:AL):
 * highest Effective MMR among players in the tier whose Keeper round equals
 * (the tier's highest Keeper round) - 1. Blank when there is no such player;
 * the page then falls back to the tier min.
 */
function addPromoted_(tiers, kRows) {
  tiers.forEach(function (t) {
    let maxR = null;
    kRows.forEach(function (r) {
      if (r[1] === t[0] && typeof r[2] === 'number') maxR = maxR === null ? r[2] : Math.max(maxR, r[2]);
    });
    if (maxR === null) return;
    let best = null;
    kRows.forEach(function (r) {
      if (r[1] === t[0] && r[2] === maxR - 1 && typeof r[0] === 'number') best = best === null ? r[0] : Math.max(best, r[0]);
    });
    if (best !== null && best > 0) t[4] = best;
  });
}

function finish_(src, players, tiers, season) {
  players.sort(function (a, b) { return a[0].localeCompare(b[0], undefined, { sensitivity: 'base' }); });
  const seen = {};
  const unique = players.filter(function (p) {
    if (seen[p[0]]) return false;
    seen[p[0]] = 1;
    return true;
  });
  if (!unique.length) throw new Error('No players found (is the sheet loaded?)');
  return { v: 1, src: src, season: season, builtAt: Date.now(), tiers: tiers, players: unique, colors: TIER_COLORS };
}

// Season label from the spreadsheet's title, e.g. "S27 RSC 3s Contracts" -> "S27"
// (also understands "Season 27"). Blank if the title has no season.
function season_(ss) {
  const m = String(ss.getName()).match(/\b(?:S|Season\s?)(\d{1,3})\b/i);
  return m ? 'S' + m[1] : '';
}

function tab_(ss, name) {
  const sh = ss.getSheetByName(name);
  if (!sh) throw new Error('Tab "' + name + '" not found');
  return sh;
}

function num_(v) {
  if (typeof v === 'number') return v;
  const t = String(v).replace(/,/g, '').trim();
  if (t === '') return '';
  const n = Number(t);
  return isNaN(n) ? '' : n;
}

// ---- Cache helpers (chunked; pointer written last) -------------------------

function readCache_(cache, key) {
  const ptr = cache.get(key + '_ptr');   // "id:chunkCount"
  if (!ptr) return null;
  const bits = ptr.split(':');
  const keys = [];
  for (let i = 0; i < Number(bits[1]); i++) keys.push(key + '_' + bits[0] + '_' + i);
  const parts = cache.getAll(keys);
  let out = '';
  for (let i = 0; i < keys.length; i++) {
    if (parts[keys[i]] == null) return null;
    out += parts[keys[i]];
  }
  return out;
}

function writeCache_(cache, key, json, seconds) {
  const id = Utilities.getUuid().slice(0, 8);
  const obj = {};
  let n = 0;
  for (let i = 0; i < json.length; i += CHUNK_SIZE) {
    obj[key + '_' + id + '_' + n] = json.substring(i, i + CHUNK_SIZE);
    n++;
  }
  cache.putAll(obj, Math.min(seconds + 60, 21600));
  cache.put(key + '_ptr', id + ':' + n, seconds);
}

// ---- Run once from the editor to authorize and check the reads ------------

function testRead() {
  [['Contracts', buildContracts_], ['Tier Maker', buildTierMaker_]].forEach(function (x) {
    try {
      const d = x[1]();
      Logger.log('%s: %s players, %s tiers, %s KB', x[0], d.players.length, d.tiers.length,
        Math.round(JSON.stringify(d).length / 1024));
      d.tiers.forEach(function (t) {
        Logger.log('  %s  min %s  max %s  cap %s  promoted %s', t[0], t[1], t[2], t[3], t[4] === '' ? '(none, uses min)' : t[4]);
      });
    } catch (err) {
      Logger.log('%s FAILED: %s', x[0], err.message);
    }
  });
  Logger.log('Passcode set: %s', PropertiesService.getScriptProperties().getProperty('TM_KEY') ? 'yes' : 'NO (add TM_KEY in Script properties)');
  Logger.log('Worker key set: %s', PropertiesService.getScriptProperties().getProperty('GAS_SECRET') ? 'yes' : 'NO (add GAS_SECRET in Script properties)');
}
