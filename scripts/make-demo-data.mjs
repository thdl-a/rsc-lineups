// Generates the invented sample data for the /demo page:
//   public/demo-data.json     Contracts   (same shape as getData_('c')  in Code.gs)
//   public/demo-data-tm.json  Tier Maker  (same shape as getData_('tm') in Code.gs)
// Nothing here comes from the real sheets.
//
//   node scripts/make-demo-data.mjs
//
// Seeded, so the output is the same every run unless this file changes.

import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const out = (f) => fileURLToPath(new URL('../public/' + f, import.meta.url));

// ---- seeded random --------------------------------------------------------
let seed = 27;
function rand() { // mulberry32
  seed |= 0; seed = (seed + 0x6D2B79F5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}
const pick = (a) => a[Math.floor(rand() * a.length)];
const chance = (p) => rand() < p;
const between = (lo, hi) => lo + Math.floor(rand() * (hi - lo + 1));

// ---- invented names -------------------------------------------------------
const A = ['Quiet', 'Turbo', 'Lucky', 'Frosty', 'Mellow', 'Rapid', 'Sneaky', 'Cosmic', 'Salty', 'Fuzzy', 'Brave', 'Lazy',
  'Neon', 'Rusty', 'Sunny', 'Crispy', 'Hollow', 'Mighty', 'Tiny', 'Wild', 'Silent', 'Golden', 'Stormy', 'Clumsy',
  'Jolly', 'Velvet', 'Pixel', 'Spicy', 'Gentle', 'Rogue', 'Dizzy', 'Polar', 'Shadow', 'Static', 'Copper', 'Minty'];
const B = ['Falcon', 'Noodle', 'Otter', 'Comet', 'Pretzel', 'Badger', 'Walrus', 'Rocket', 'Pickle', 'Lynx', 'Muffin', 'Gecko',
  'Panda', 'Waffle', 'Raven', 'Biscuit', 'Moose', 'Tornado', 'Cactus', 'Puffin', 'Mango', 'Viper', 'Llama', 'Kettle',
  'Hornet', 'Dumpling', 'Yeti', 'Parrot', 'Turnip', 'Bison', 'Squid', 'Wombat', 'Pepper', 'Heron', 'Tofu', 'Koala'];
const used = new Set();
function tag() {
  for (;;) {
    const n = pick(A) + pick(B) + (chance(0.3) ? String(between(10, 99)) : '');
    if (!used.has(n)) { used.add(n); return n; }
  }
}
const TEAMS = ['Hawks', 'Rams', 'Owls', 'Sharks', 'Wolves', 'Bears', 'Cranes', 'Lions', 'Foxes', 'Stags', 'Vipers', 'Herons',
  'Bulls', 'Eagles', 'Moose', 'Otters', 'Badgers', 'Ravens', 'Bison', 'Pumas', 'Gators', 'Kites', 'Mustangs', 'Orcas'];

// ---- tiers ----------------------------------------------------------------
// Same tier names and colors as the real league (Code.gs TIER_COLORS).
const COLORS = {
  'Legend': '#cccccc', 'Premier': '#d600d6', 'Master': '#8e7cc3', 'Elite': '#6fa8dc', 'Veteran': '#33ffda',
  'Rival': '#93c47d', 'Challenger': '#ffd966', 'Prospect': '#f6b26b', 'Contender': '#e06666', 'Amateur': '#f3a9a9'
};
// [tier, min, max, players]; made-up MMR bands, highest tier first
const BANDS = [
  ['Legend', 1640, 1900, 22], ['Premier', 1500, 1640, 28], ['Master', 1380, 1500, 34], ['Elite', 1270, 1380, 38],
  ['Veteran', 1160, 1270, 40], ['Rival', 1060, 1160, 40], ['Challenger', 960, 1060, 38], ['Prospect', 860, 960, 34],
  ['Contender', 760, 860, 28], ['Amateur', 600, 760, 22]
];
// Tier table row: [name, min, max, cap, promoted]. Cap is for 4 players; promoted sits a bit above the min.
const tierRow = ([name, mn, mx], shift = 0) => {
  mn += shift; mx += shift;
  return [name, mn, mx, Math.round((mn + mx) * 2 / 10) * 10, mn + Math.round((mx - mn) * (0.18 + rand() * 0.14))];
};

// ---- Contracts ------------------------------------------------------------
const STATUSES = [['Rostered', 0.70], ['Free Agent', 0.17], ['Permanent Free Agent', 0.05], ['Perm FA in Waiting.', 0.03], ['GM (Unsigned)', 0.05]];
function status() { let r = rand(); for (const [s, p] of STATUSES) { if ((r -= p) < 0) return s; } return 'Rostered'; }

const players = [];
BANDS.forEach(([name, mn, mx, count]) => {
  const teams = TEAMS.slice(0, Math.ceil(count / 5)).map((t) => t);
  for (let i = 0; i < count; i++) {
    const st = status();
    players.push([tag(), between(mn, mx), st, st === 'Rostered' ? pick(teams) : '', name]);
  }
});
const byName = (a, b) => a[0].localeCompare(b[0], undefined, { sensitivity: 'base' });
const builtAt = Date.UTC(2026, 10, 26, 18, 0, 0); // the page shows the load time in demo mode
const contracts = {
  v: 1, src: 'c', season: 'S99 (Demo)', builtAt,
  tiers: BANDS.map((b) => tierRow(b)),
  players: players.sort(byName),
  colors: COLORS
};

// ---- Tier Maker (management's working list: names and base MMR only) ------
const tmPlayers = [];
BANDS.forEach(([, mn, mx, count]) => {
  for (let i = 0; i < Math.round(count * 0.45); i++) tmPlayers.push([chance(0.6) ? pick(players)[0] : tag(), between(mn - 20, mx + 20), '', '', '']);
});
const seen = new Set();
const tierMaker = {
  v: 1, src: 'tm', season: 'S99 (Demo)', builtAt,
  tiers: BANDS.map((b) => tierRow(b, 10)),
  players: tmPlayers.sort(byName).filter((p) => !seen.has(p[0]) && seen.add(p[0])),
  colors: COLORS
};

writeFileSync(out('demo-data.json'), JSON.stringify(contracts));
writeFileSync(out('demo-data-tm.json'), JSON.stringify(tierMaker));
console.log(`Contracts: ${contracts.players.length} players, ${contracts.tiers.length} tiers`);
console.log(`Tier Maker: ${tierMaker.players.length} players, ${tierMaker.tiers.length} tiers`);
