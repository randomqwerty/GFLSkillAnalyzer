// GFL skill analyzer: explains how a T-Doll's skills work, from the game's battle tables.
// Runs in the browser (index.html) and in Node (build-report.mjs). No dependencies.
//
// Engine rules used below were read from the EN PC client (GameAssembly.dll). Where a rule is
// quoted in a comment, the client method it comes from is named in brackets.

import { runChecks, CATEGORIES } from './checks.js';
import { findHidden } from './hidden.js';
import { plainSummary } from './plain.js';
import { drawField, defaultScenario } from './field.js';
export { CATEGORIES };

export const DEFAULT_BASE = 'https://raw.githubusercontent.com/randomqwerty/GFLData/refs/heads/main/en';

export const STC_TABLES = [
  'gun', 'battle_skill_config', 'battle_buff', 'battle_trigger', 'battle_action_config',
  'battle_creation', 'battle_hurt_config', 'battle_target_select_ai', 'battle_formula',
  'battle_watch', 'battle_watch_trigger', 'summoner', 'battle_skill_type_config', 'equip', 'equip_group',
  'enemy_character_type', 'enemy_illustration', 'enemy_illustration_skill', 'enemy_standard_attribute', 'sangvis', 'sangvis_resolution',
];
// catchdata tables are wrapped as { table_name: [rows] } and hold every value as a string.
export const CATCH_TABLES = ['battle_movement_info'];
export const TEXT_TABLES = ['battle_skill_config', 'gun', 'mission', 'equip', 'equip_group', 'enemy_character_type', 'enemy_illustration_skill', 'sangvis'];

/** Unit kinds the analyzer covers: T-Dolls (gun), enemies (enemy_character_type) and Coalition units (sangvis). */
export const UNIT_KINDS = { gun: 'T-Doll', enemy: 'Enemy', sangvis: 'Coalition unit' };
const UNIT_TABLE = { gun: 'gun', enemy: 'enemy_character_type', sangvis: 'sangvis' };

export const FPS = 30;          // battle frames per second
export const FORMULA = 1e9;     // values >= this are battle_formula ids + 1e9

// ---------------------------------------------------------------- data loading

export async function loadData(base = DEFAULT_BASE, { fetchJson, onProgress, glossary = null } = {}) {
  fetchJson ??= async (url) => {
    const r = await fetch(url);
    if (!r.ok) throw new Error(`${r.status} ${r.statusText}: ${url}`);
    return r.json();
  };
  const jobs = [
    ...STC_TABLES.map((t) => ['stc', t, `${base}/stc/${t}.json`]),
    ...TEXT_TABLES.map((t) => ['text', t, `${base}/text/table/${t}.json`]),
    ...CATCH_TABLES.map((t) => ['catch', t, `${base}/catchdata/${t}.json`]),
  ];
  let done = 0;
  const out = { stc: {}, text: {}, catch: {} };
  await Promise.all(jobs.map(async ([kind, name, url]) => {
    out[kind][name] = await fetchJson(url);
    onProgress?.(++done, jobs.length, name);
  }));
  for (const [name, v] of Object.entries(out.catch)) {
    const rows = Array.isArray(v) ? v : v?.[name] ?? [];
    out.stc[name] = rows.map((r) => Object.fromEntries(Object.entries(r).map(([k, x]) => [k, /^-?\d+(\.\d+)?$/.test(String(x)) ? Number(x) : x])));
  }
  return new GameData(out.stc, out.text, glossary);
}

export class GameData {
  constructor(stc, text, glossary = null) {
    this.glossary = glossary ?? {};
    this.stdRows = stc.enemy_standard_attribute ?? [];
    this.t = {};
    for (const [name, rows] of Object.entries(stc)) {
      const m = new Map();
      for (const r of rows) m.set(r.id, r);
      this.t[name] = m;
    }
    this.txt = new Map();
    for (const tab of Object.values(text)) {
      for (const [k, v] of Object.entries(tab)) this.txt.set(k.replace(/^﻿+/, ''), v);
    }
    this.skills = new Map();               // skill_group_id -> Map(level -> row)
    for (const r of this.t.battle_skill_config.values()) {
      if (!this.skills.has(r.skill_group_id)) this.skills.set(r.skill_group_id, new Map());
      this.skills.get(r.skill_group_id).set(r.level, r);
    }
    this._formulaCache = new Map();
  }
  text(key) {
    if (!key) return '';
    const v = this.txt.get(String(key));
    return v === undefined ? '' : String(v);
  }
  /** English label for a Chinese developer label (bundled glossary), or '' if none. */
  label(cn) {
    if (!cn || !/[㐀-鿿]/.test(cn)) return '';
    const k = String(cn).replace(/\[\*[\]}]/g, '').trim();
    return this.glossary[k] ?? '';
  }
  /** Display name: the English text, or the glossary label plus the Chinese original. */
  nameHtml(cn, fallback = '') {
    const s = String(cn ?? '').trim();
    if (!s) return esc(fallback);
    if (!/[㐀-鿿]/.test(s)) return esc(s);
    const en = this.label(s);
    return en ? `${esc(en)} <span class="cn">${esc(s)}</span>` : `<span class="cn">${esc(s)}</span>`;
  }
  gunName(g) { return this.text(g.name) || g.en_name || `#${g.id}`; }
  /**
   * An enemy's stat at a level: base × standard(level) / standard(base level), the way GFLMaps computes it
   * (enemy_standard_attribute is keyed by level; it has no id column).
   */
  enemyStat(e, attr, level) {
    if (!this._std) { this._std = new Map(); for (const r of this.stdRows ?? []) this._std.set(Number(r.level), r); }
    const a = this._std.get(Number(level))?.[attr], b = this._std.get(Number(e.level))?.[attr];
    return a && b ? Number(e[attr]) * a / b : Number(e[attr]);
  }
  unitRow(kind, id) { return this.t[UNIT_TABLE[kind]]?.get(Number(id)) ?? null; }
  /** Display name of a unit of any kind. */
  unitName(kind, r) {
    // The row's name key (…-2NNNNNNN) is the name used in most screens; …-1NNNNNNN (the character field) is a fallback.
    if (kind === 'enemy') return this.text(r.name) || this.text(`enemy_character_type-1${String(r.id).padStart(7, '0')}`) || r.code || `#${r.id}`;
    // The EN text table still has Japanese Coalition names; en_name is the English one.
    if (kind === 'sangvis') { const t = this.text(r.name); return (/[A-Za-z]/.test(t) ? t : r.en_name) || t || r.code || `#${r.id}`; }
    return this.gunName(r);
  }
  /** Units of one kind, sorted by id. Dolls leave out the story copies (see dolls()). */
  units(kind) {
    if (kind === 'gun') return this.dolls();
    return [...(this.t[UNIT_TABLE[kind]]?.values() ?? [])].sort((a, b) => a.id - b.id);
  }
  /** How many units of all kinds list a skill group directly: shared skills are class or faction mechanics. */
  sharedCount(group) {
    if (!this._uses) {
      this._uses = new Map();
      const bump = (x) => { const n = Number(x); if (n) this._uses.set(n, (this._uses.get(n) ?? 0) + 1); };
      for (const g of this.t.gun.values()) for (const f of ['normal_attack', 'passive_skill', 'dynamic_passive_skill']) list(g[f]).forEach(bump);
      for (const e of this.t.enemy_character_type?.values() ?? []) for (const f of ['normal_attack', 'passive_skill']) list(e[f]).forEach(bump);
      for (const s of this.t.sangvis?.values() ?? []) for (const f of ['normal_attack', 'passive_skill2', 'dynamic_passive_skill']) list(s[f]).forEach(bump);
    }
    return this._uses.get(group) ?? 0;
  }
  /** How many skill groups (buffs) or creations (hits) use a buff or hit: widely used ones are shared mechanics. */
  refCount(ref) {
    if (!this._refs) {
      const buffs = new Map(), hurts = new Map();
      const addB = (id, owner) => { if (!buffs.has(id)) buffs.set(id, new Set()); buffs.get(id).add(owner); };
      for (const r of this.t.battle_skill_config.values()) for (const c of ['buff_id_self', 'buff_id_target']) for (const b of parseBuffList(r[c])) addB(b.id, `s${r.skill_group_id}`);
      for (const c of this.t.battle_creation.values()) {
        for (const b of parseBuffList(c.buff_id)) addB(b.id, `c${c.id}`);
        for (const h of ids(c.hurt_id)) { if (!hurts.has(h)) hurts.set(h, new Set()); hurts.get(h).add(c.id); }
      }
      for (const h of this.t.battle_hurt_config.values()) for (const c of ['buff_id_target', 'buff_id_self']) for (const b of parseBuffList(h[c])) addB(b.id, `h${h.id}`);
      this._refs = { buffs, hurts };
    }
    if (ref?.buff) return this._refs.buffs.get(ref.buff)?.size ?? 0;
    if (ref?.hurt) return this._refs.hurts.get(String(ref.hurt))?.size ?? 0;
    return 0;
  }
  missionName(id) { return this.text(`mission-1${String(id).padStart(7, '0')}`); }
  skillRow(group, level) {
    const lv = this.skills.get(group);
    if (!lv) return this.t.battle_skill_config.get(group) || null;   // already a row id
    return lv.get(level) || lv.get(Math.max(...lv.keys()));
  }
  skillLevels(group) { const lv = this.skills.get(group); return lv ? [...lv.keys()].sort((a, b) => a - b) : []; }
  /** Formula text as the client sees it: lower-cased, with every "@buffNNN" rewritten to "sbuffidtier(NNN)" [BattleFormula.Init]. */
  formula(id) {
    const raw = this.t.battle_formula.get(id)?.formula;
    if (raw === undefined || raw === null) return null;
    return String(raw).toLowerCase().replace(/@buff(\d+)/g, 'sbuffidtier($1)');
  }
  rawFormula(id) { return this.t.battle_formula.get(id)?.formula ?? null; }

  /** Dolls in scope: regular, collab and Neural Upgrade rows; story/event copies (9000s) are left out. */
  dolls({ includeSpecial = false } = {}) {
    const out = [];
    for (const g of this.t.gun.values()) {
      const cat = dollCategory(g.id);
      if (cat === 'story' && !includeSpecial) continue;
      out.push(g);
    }
    return out.sort((a, b) => dollSortKey(a) - dollSortKey(b));
  }
}

export function dollCategory(id) {
  if (id >= 9000 && id < 10000) return 'story';
  if (id >= 20000 && id < 30000) return 'mod';
  if (id >= 1000 && id < 2000) return 'collab';
  if (id < 1000) return 'normal';
  return 'variant';               // 30000+ (Sangvis-side copies) and 90000+
}
function dollSortKey(g) {
  const c = dollCategory(g.id);
  return { normal: 0, collab: 1, mod: 2, variant: 3, story: 4 }[c] * 1e6 + g.id;
}
export const GUN_TYPES = { 1: 'HG', 2: 'SMG', 3: 'RF', 4: 'AR', 5: 'MG', 6: 'SG' };

// ---------------------------------------------------------------- small helpers

export const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
export const list = (s, sep = ',') => String(s ?? '').split(sep).map((x) => x.trim()).filter((x) => x !== '');
export const ids = (s) => list(s).filter((x) => x !== '0' && x !== '-1');
export const num = (n) => {
  if (n === null || n === undefined || Number.isNaN(n)) return '?';
  const r = Math.round(n * 10000) / 10000;
  return String(r);
};
const sec = (frames) => `${num(frames / FPS)} s`;
const plural = (n, one, many = one + 's') => `${num(n)} ${Math.abs(n) === 1 ? one : many}`;
const pct = (v) => `${num(v)}%`;
const signed = (v) => (v >= 0 ? '+' : '−') + num(Math.abs(v));

/** Parse a table cell: number, "*XY" pool reference, or formula (>= 1e9). */
export function parseVal(s) {
  s = String(s ?? '').trim();
  if (s === '') return null;
  // "*" with no number fails Int32.TryParse: an error is logged and the reference becomes pool slot 0 [SkillUtils.ConvertToPoolSign].
  if (s[0] === '*') { const n = parseInt(s.slice(1), 10); return Number.isNaN(n) ? { pool: 0, malformed: s } : { pool: n }; }
  const n = Number(s);
  if (Number.isNaN(n)) return { str: s };
  if (n >= FORMULA) return { formula: Math.round(n - FORMULA) };
  return { num: n };
}

/** "id:stacks,id:stacks" lists. Stacks may be a number, pool or formula. */
export function parseBuffList(s) {
  return list(s).map((p) => {
    const [id, st] = p.split(':').map((x) => x.trim());
    const n = Number(id);
    return { id: n >= FORMULA ? null : parseInt(id, 10), idFormula: n >= FORMULA ? Math.round(n - FORMULA) : null, stacks: st === undefined ? { num: 0 } : parseVal(st), raw: p };
  }).filter((x) => x.idFormula !== null || (!Number.isNaN(x.id) && x.id !== 0));
}

// ---------------------------------------------------------------- stat and type tables

export const STAT = {
  pow: 'Firepower', dodge: 'Evasion', hit: 'Accuracy', rate: 'Rate of Fire', move: 'Movement Speed',
  crit: 'Crit Rate', critdmg: 'Crit Damage', armor: 'Armor', ap: 'Armor Penetration', dmgtaken: 'Damage Taken',
  shieldbreak: 'Shield Break', maxfs: 'max Force Shield', fs: 'Force Shield', range: 'Range',
  tenacity: 'Tenacity', immunity: 'Immunity', cdr: 'Cooldown Reduction', night: 'Night Vision',
};
// Value column read for each buff type [CharacterCondition._GetValue]. Unlisted types use parameter_value.
export const BUFF_COL = {
  101: 'pow_number', 201: 'pow_number', 801: 'pow_number', 102: 'dodge_number', 202: 'dodge_number', 802: 'dodge_number',
  103: 'hit_number', 203: 'hit_number', 803: 'hit_number', 104: 'rate_number', 204: 'rate_number', 804: 'rate_number',
  105: 'move_number', 205: 'move_number', 215: 'move_number', 805: 'move_number',
  106: 'critical_number', 206: 'critical_number', 806: 'critical_number',
  108: 'armor_reduce_number', 208: 'armor_reduce_number', 808: 'armor_reduce_number', 109: 'shield_number',
  110: 'damage_reduce_number', 810: 'damage_reduce_number', 111: 'arp_number', 811: 'arp_number',
  112: 'critical_damage_number', 812: 'critical_damage_number', 122: 'def_number', 124: 'maxdef_number', 224: 'maxdef_number',
  126: 'defbreak_number', 226: 'defbreak_number', 826: 'defbreak_number', 128: 'cdr_number', 129: 'cdr_number',
  130: 'pow_number', 131: 'pow_number', 404: 'night_view_percent', 830: 'range_number',
};
// Percentage types: each stack multiplies the stat by value/100 [BattleConditionList.UpdateConditionBuff ->
// GetConditionValue: product of Pow(value/100, stacks)]. Flat types add value*stacks [GetConditionValueFixed].
export const PCT_STAT = {
  101: 'pow', 201: 'pow', 102: 'dodge', 202: 'dodge', 103: 'hit', 203: 'hit', 104: 'rate', 204: 'rate',
  105: 'move', 205: 'move', 215: 'move', 106: 'crit', 206: 'crit', 108: 'armor', 208: 'armor', 111: 'ap',
  112: 'critdmg', 126: 'shieldbreak', 128: 'cdr', 228: 'cdr', 137: 'tenacity', 237: 'tenacity', 138: 'immunity', 238: 'immunity',
};
export const FLAT_STAT = {
  801: 'pow', 802: 'dodge', 803: 'hit', 804: 'rate', 805: 'move', 806: 'crit', 808: 'armor', 810: 'dmgtaken',
  811: 'ap', 812: 'critdmg', 826: 'shieldbreak', 830: 'range', 837: 'tenacity', 838: 'immunity',
};
// Types with no effect of their own: they only matter because something checks for them.
export const MARKER_TYPES = new Set([400, 403, 451, 452, 453, 454, 455, 456, 457, 500, 501, 535, 536, 594, 600, 601, 602, 207, 223, 300]);
for (let t = 700; t <= 759; t++) MARKER_TYPES.add(t);

export const BUFF_TYPE_NAME = {
  101: 'Firepower ×', 102: 'Evasion ×', 103: 'Accuracy ×', 104: 'Rate of Fire ×', 105: 'Movement ×', 106: 'Crit Rate ×',
  107: 'invulnerable to damage', 108: 'Armor ×', 109: 'HP shield', 110: 'damage taken ×', 111: 'Armor Pen. ×', 112: 'Crit Damage ×',
  120: 'skill invulnerability', 121: 'sortie eye', 122: 'Force Shield', 124: 'max Force Shield', 126: 'Shield Break ×',
  128: 'cooldown speed', 129: 'instant cooldown change', 130: 'charges +', 131: 'max charges +', 132: 'extra attack effect',
  133: 'extra grenade effect', 134: 'extra sniper effect', 135: 'extra attack', 136: 'damage over time', 137: 'Tenacity ×', 138: 'Immunity ×',
  201: 'Firepower ×', 202: 'Evasion ×', 203: 'Accuracy ×', 204: 'Rate of Fire ×', 205: 'Movement ×', 206: 'Crit Rate ×', 208: 'Armor ×',
  215: 'Movement × (special)', 220: 'burn', 221: 'stun', 222: 'smoke', 224: 'max Force Shield', 226: 'Shield Break ×', 228: 'cooldown speed',
  229: 'instant cooldown change', 237: 'Tenacity ×', 238: 'Immunity ×', 301: 'taunted', 302: 'blind', 303: 'phased (untargetable)',
  304: 'disarm', 305: 'silence', 306: 'last stand', 307: 'cannot die', 308: 'mark immune below', 309: 'mark immune above',
  401: 'UI counter', 402: 'damage recalculation', 404: 'night vision', 405: 'sniper skill', 406: 'special skill', 407: 'boss float',
  408: 'delayed damage', 409: 'stat lock', 415: 'charge UI', 505: 'elite mission', 506: 'remote battle time',
  801: 'Firepower +', 802: 'Evasion +', 803: 'Accuracy +', 804: 'Rate of Fire +', 805: 'Movement +', 806: 'Crit Rate +', 808: 'Armor +',
  810: 'damage taken +', 811: 'Armor Pen. +', 812: 'Crit Damage +', 826: 'Shield Break +', 830: 'Range +', 837: 'Tenacity +', 838: 'Immunity +',
};
export function buffTypeName(t) { return BUFF_TYPE_NAME[t] ?? (MARKER_TYPES.has(t) ? 'marker' : `type ${t}`); }

// Position types [gsEffect.GetPosByType]. Type 8 is the friendly team's origin whoever casts it (it reads
// BattleDynamicData.friendlyTeamHolder); 9-14 replace one coordinate with the world's 0 line, which on the enemy
// map is x 3.76 (just in front of the Griffin formation) or y 5.91 (between its middle and top rows).
const POS_TYPE = {
  0: "a model node on the user", 1: "the user's gun", 2: "the user's body", 3: "the user's feet", 4: "the target's gun",
  5: "the target's body", 6: "the target's feet", 7: 'the object that spawned it',
  8: 'the Griffin-side team origin (a fixed point just in front of the Griffin formation, whoever casts it)',
  9: "the user's row, on the line just in front of the Griffin formation", 10: "the user's column, on the map's middle line",
  11: "the target's row, on the line just in front of the Griffin formation", 12: "the target's column, on the map's middle line",
  13: "the target's row, on the line just in front of the Griffin formation", 14: "the target's column, on the map's middle line",
  15: 'the target', 99: 'the point the player picks',
};
// Route types [gsEffect.InitData]: 0 and 3 create no move node, so the object stays at its start point.
const ROUTE = {
  0: 'stays where it is created', 3: 'stays where it is created', 1: 'flies in a straight line', 2: 'flies in an arc',
  4: 'follows its particle effect', 5: 'flies straight (without turning)', 6: 'keeps flying forward through targets', 7: 'is an instant ray',
};
const STATIONARY = new Set([0, 3]);
const SORT_KEY = {
  0: 'no particular order', 1: 'current HP', 2: 'HP %', 3: 'max HP', 4: 'distance', 5: 'Firepower', 6: 'Evasion', 7: 'Armor',
  9: 'left-right distance', 10: 'left-right distance', 11: 'front-back distance', 12: 'damage dealt so far', 13: 'Force Shield', 14: 'max Force Shield',
};
const WATCH_EVENT = {
  1: 'a buff on the watched unit changes', 2: 'the watched unit takes damage', 3: 'the watched unit deals damage',
  4: 'a skill is cast', 5: 'the watched unit is heavily damaged', 6: 'a unit retreats', 7: 'a unit dies',
};
const SKILL_TYPE = {
  1: 'active skill', 2: 'automatic skill', 3: 'normal attack', 4: 'instant skill (does not interrupt the doll)', 5: 'automatic skill',
  6: 'active skill (special manual handling)', 7: 'last-stand skill (fires on death)', 8: 'watcher skill', 9: 'automatic skill',
  10: 'active skill (player picks a location)', 301: 'automatic skill',
};
const CD_TYPE = { 0: 'no cooldown', 1: 'normal', 2: 'counted in battles', 3: 'attack interval (from Rate of Fire)', 4: 'counted in won battles' };
const FACTION = { 1: 'collab', 2: 'KCCO', 3: 'Belgium', 4: 'China', 5: 'Germany', 6: 'Russia', 7: 'USA', 8: 'Others', 9: 'Paradeus', 10: 'Sangvis', 11: '404 Team', 12: 'AR Team', 13: 'DEFY' };

// ---------------------------------------------------------------- formulas

const VAR_NAME = {
  distance: 'distance to the target', distancex: 'left-right distance to the target', distancey: 'vertical distance to the target',
  distancez: 'front-back distance to the target', pow: 'Firepower', hit: 'Accuracy', dodge: 'Evasion', rate: 'Rate of Fire', armor: 'Armor',
  capacity: 'magazine size', critical: 'Crit Rate', criticalhurt: 'Crit Damage', life: 'current HP', maxlife: 'max HP',
  formation: 'dummy links alive', def: 'Force Shield', maxdef: 'max Force Shield', defbreak: 'Shield Break', ap: 'Armor Penetration',
  shield: 'HP shield', range: 'Range', level: 'level', slevel1: 'skill 1 level', slevel2: 'skill 2 level', slevel3: 'skill 3 level',
  skillcd: "skill 1's cooldown counter (frames)", career: 'Sangvis unit type', enemytype: 'enemy type', battlepoint: 'battle node',
  leader: 'is echelon leader', sangvisstrategy: 'Sangvis strategy', characterstatus: 'unit status', uncappedrate: 'Rate of Fire (uncapped)',
  gunid: 'unit id', location: 'formation slot', speed: 'Movement Speed', gundetail: 'faction', ammo: 'ammo', mre: 'rations',
  gunnumber: 'dummy links', tenacity: 'Tenacity', immunity: 'Immunity', danger: 'danger', isremote: 'is a remote battle',
  lasthurt: 'last damage taken', lastheal: 'last healing', lasthit: 'last hit',
};
const FUNC_NAME = {
  buffidtier: (a) => `stacks of ${a}`, buffidnumber: (a) => `current value of ${a}`, bufftypetier: (a) => `stacks of all type-${a} buffs`,
  bufftypenumber: (a) => `combined value of type-${a} buffs`, buffalltier: () => 'stacks of all buffs', bufftypecount: () => 'number of different buff types',
  buffidtime: (a) => `remaining frames of ${a}`, visualbuffcount: () => 'number of shown buffs', visualdebuffcount: () => 'number of shown debuffs',
  customtype: (a) => `has component type ${a}`, buffattributetier: (a) => `stacks with special attribute ${a}`,
};

/** Tokenize a battle_formula expression (the client's grammar: BattleFormula.Parse / TryScanIdentifier). */
export function tokenizeFormula(src) {
  const out = []; let i = 0; const s = String(src);
  while (i < s.length) {
    const c = s[i];
    if (/\s/.test(c)) { i++; continue; }
    let m;
    if ((m = /^\d+(\.\d+)?/.exec(s.slice(i)))) { out.push({ t: 'num', v: m[0] }); i += m[0].length; continue; }
    if ((m = /^[@#~]([A-Za-z]\w*)/.exec(s.slice(i)))) { out.push({ t: 'var', side: c, v: m[1].toLowerCase(), raw: m[0] }); i += m[0].length; continue; }
    if ((m = /^\$(\d+)/.exec(s.slice(i)))) { out.push({ t: 'dyn', v: m[1] }); i += m[0].length; continue; }
    if ((m = /^[A-Za-z_]\w*/.exec(s.slice(i)))) { out.push({ t: 'id', v: m[0].toLowerCase(), raw: m[0] }); i += m[0].length; continue; }
    if ((m = /^(>=|<=|==|!=|&&|\|\||[-+*/%()<>=&|?:!,])/.exec(s.slice(i)))) { out.push({ t: 'op', v: m[0] }); i += m[0].length; continue; }
    out.push({ t: 'bad', v: c }); i++;
  }
  return out;
}

/**
 * Parse a formula into a tree. Precedence follows FormulaOperator.ComparePriority:
 * ! and unary minus, then * / %, + -, comparisons, = and !=, &, |, and ?: last.
 */
export function parseFormula(src) {
  const toks = tokenizeFormula(src); let i = 0;
  const peek = () => toks[i]; const next = () => toks[i++];
  const isOp = (v) => peek()?.t === 'op' && peek().v === v;
  const BIN = [['|', '||'], ['&', '&&'], ['=', '==', '!='], ['<', '<=', '>', '>='], ['+', '-'], ['*', '/', '%']];
  function primary() {
    const k = next();
    if (!k) throw new Error('unexpected end');
    if (k.t === 'num') return { n: 'num', v: Number(k.v) };
    if (k.t === 'var') return { n: 'var', side: k.side, v: k.v };
    if (k.t === 'dyn') return { n: 'dyn', v: Number(k.v) };
    if (k.t === 'pool') return { n: 'pool', v: Number(k.v) };
    if (k.t === 'id') {
      if (k.v === 'true' || k.v === 'false') return { n: 'num', v: k.v === 'true' };
      if (isOp('(')) {
        next(); const args = [];
        if (!isOp(')')) { args.push(ternary()); while (isOp(',')) { next(); args.push(ternary()); } }
        if (!isOp(')')) throw new Error('missing )'); next();
        return { n: 'fn', v: k.v, args };
      }
      return { n: 'bad', v: k.raw };
    }
    if (k.t === 'op' && k.v === '(') { const e = ternary(); if (!isOp(')')) throw new Error('missing )'); next(); return e; }
    if (k.t === 'op' && k.v === '!') return { n: 'not', a: primary() };
    if (k.t === 'op' && k.v === '-') return { n: 'neg', a: primary() };
    throw new Error(`unexpected ${k.v}`);
  }
  function bin(level) {
    if (level >= BIN.length) return primary();
    let a = bin(level + 1);
    while (peek()?.t === 'op' && BIN[level].includes(peek().v)) { const op = next().v; a = { n: 'bin', op, a, b: bin(level + 1) }; }
    return a;
  }
  function ternary() {
    const c = bin(0);
    if (isOp('?')) { next(); const a = ternary(); if (!isOp(':')) throw new Error('missing :'); next(); return { n: 'if', c, a, b: ternary() }; }
    return c;
  }
  const tree = ternary();
  if (i < toks.length) throw new Error(`unexpected ${toks[i].v}`);
  return tree;
}

/** Evaluate a tree. env(node) returns a value for var/dyn/pool/fn nodes, or undefined when unknown. */
export function evalFormula(t, env) {
  const U = undefined;
  const ev = (x) => evalFormula(x, env);
  switch (t.n) {
    case 'num': return t.v;
    case 'var': case 'dyn': case 'pool': case 'bad': return env(t);
    case 'fn': return env(t);
    case 'not': { const a = ev(t.a); return a === U ? U : !a; }
    case 'neg': { const a = ev(t.a); return a === U ? U : -a; }
    case 'if': { const c = ev(t.c); if (c === U) return U; return c ? ev(t.a) : ev(t.b); }
    case 'bin': {
      const a = ev(t.a); const b = ev(t.b);
      if (a === U || b === U) return U;
      switch (t.op) {
        case '+': return a + b; case '-': return a - b; case '*': return a * b;
        case '/': return b === 0 ? U : a / b; case '%': return b === 0 ? U : a % b;
        case '<': return a < b; case '<=': return a <= b; case '>': return a > b; case '>=': return a >= b;
        case '=': case '==': return a === b; case '!=': return a !== b;
        case '&': case '&&': return !!(a && b); case '|': case '||': return !!(a || b);
      }
    }
  }
  return U;
}

// ---------------------------------------------------------------- analysis

/**
 * Analyse one doll. Returns { gun, sections: [...], notes: [...], markers, formulas }.
 * opts.levels = { skill1: 10, skill2: 10 }.
 */
export function analyzeDoll(data, gunId, opts = {}) {
  return analyzeUnit(data, 'gun', gunId, opts);
}

/** Analyse any unit: kind is 'gun', 'enemy' or 'sangvis' (see UNIT_KINDS). */
export function analyzeUnit(data, kind, id, opts = {}) {
  const g = data.unitRow(kind, id);
  if (!g) throw new Error(`No ${UNIT_KINDS[kind] ?? kind} with id ${id}`);
  const A = new Analysis(data, g, { ...opts, kind });
  return A.run();
}

class Analysis {
  constructor(data, g, opts) {
    this.d = data; this.g = g; this.kind = opts.kind ?? 'gun';
    // Enemy skills only exist at level 1 in practice, and their summons copy the enemy's levels.
    if (this.kind === 'enemy') opts = { ...opts, levels: { skill1: 1, skill2: 1, skill3: 1, advance: 1 } };
    this.levels = { skill1: opts.levels?.skill1 ?? 10, skill2: opts.levels?.skill2 ?? 10, skill3: opts.levels?.skill3 ?? 5, advance: opts.levels?.advance ?? 5 };
    // Default buff stacks ("0") are the caster's bulletChainNum: gun.special for dolls, sangvis.special for
    // Coalition units [BattleCharacterData.GetGunData / GetSangvisData]; enemies keep 0 [InitBaseBattleData].
    this.mag = this.kind === 'enemy' ? 0 : Number(g.special) || 0;
    this.effects = [];            // { entry, group, kind, value, side, text } for hidden-effect detection
    this.notes = [];              // doll-wide quirk notes {sev, text, where}
    this.untraced = [];           // description numbers not found in the data (often formula results or equipment stats)
    this.markers = new Map();     // buff id -> { buff, setBy:Set, checkedBy:Set }
    this.formulas = new Map();    // formula id -> { text, uses:Set }
    this.owned = new Map();       // skill group -> level, for skills the doll owns
    this.expanded = new Set();    // keys of nodes already written out
  }

  entries() {
    if (this.kind === 'enemy') return this.enemyEntries();
    if (this.kind === 'sangvis') return this.sangvisEntries();
    return this.gunEntries();
  }

  /** Enemies: a normal attack and passive skills, all at level 1 [EnemyGun..ctor -> Gun.InitSkills]. */
  enemyEntries() {
    const g = this.g, d = this.d, entries = [];
    // The enemy encyclopedia describes the unit's skills: enemy_illustration (by sub_id) lists enemy_illustration_skill ids.
    const ill = [...(d.t.enemy_illustration?.values() ?? [])].find((x) => x.sub_id === g.enemy_illustration_sub_id);
    this.kitTexts = ids(ill?.enemy_skill).map(Number).map((i) => d.t.enemy_illustration_skill?.get(i)).filter(Boolean)
      .map((x) => ({ name: d.text(x.name), text: d.text(x.description) })).filter((x) => x.text);
    if (g.normal_attack) entries.push({ field: 'normal_attack', label: 'Normal attack', group: g.normal_attack, level: 1, why: 'Normal attacks only have level 1.' });
    for (const tok of list(g.passive_skill)) {
      // The list is split on commas and each piece read with Int32.TryParse; a piece that fails is skipped [EnemyGun..ctor].
      if (!/^\d+$/.test(tok)) { this.addNote({ sev: 'bug', cat: 'data', text: `The passive skill list <code>${esc(g.passive_skill)}</code> contains <code>${esc(tok)}</code>, which is not a number: the game skips it, so ${esc(tok.split(/\D+/).filter(Boolean).join(' and '))} never run.` }); continue; }
      if (tok !== '0') entries.push({ field: 'passive_skill', label: 'Passive', group: Number(tok), level: 1, why: 'Passive skills always run at level 1 [Gun.InitSkills].' });
    }
    return entries;
  }

  /** Coalition units [SangvisGunInfo.InitData]: normal attack, skills 1-3, the advance skill, passives and hidden skills. */
  sangvisEntries() {
    const g = this.g, d = this.d, L = this.levels, entries = [];
    const push = (field, label, group, level, why, trained = false) => { if (group) entries.push({ field, label, group: Number(group), level, why, trained }); };
    push('normal_attack', 'Normal attack', g.normal_attack, 1, 'Normal attacks only have level 1.');
    push('skill1', 'Skill 1', g.skill1, L.skill1, "Uses the unit's Skill 1 level.", true);
    if (g.skill2_type === 1) push('skill2', 'Skill 2', g.skill2, L.skill2, "Uses the unit's Skill 2 level.", true);
    else if (g.skill2) this.addNote({ sev: 'info', cat: 'other', text: `Skill 2 (${g.skill2}) is a map skill (skill2_type ${g.skill2_type}), not a battle skill, so it is not analysed here.` });
    push('skill3', 'Skill 3', g.skill3, L.skill3, "Uses the unit's Skill 3 level (max 5).", true);
    push('skill_advance', 'Advance skill', g.skill_advance, L.advance, 'Uses the advance skill level (max 5).', true);
    // Resolution levels replace skills from that level on (sangvis_resolution.skill1-3 / skill_advance, 0 = unchanged);
    // sangvis.skill_resolution itself is not read by the client.
    const slot = { skill1: ['Skill 1', L.skill1], skill2: ['Skill 2', L.skill2], skill3: ['Skill 3', L.skill3], skill_advance: ['Advance skill', L.advance] };
    const seenRes = new Set();
    for (const r of [...(d.t.sangvis_resolution?.values() ?? [])].filter((x) => x.group_id === g.resolution).sort((a, b) => a.lv - b.lv)) {
      for (const [f, [name, lv]] of Object.entries(slot)) {
        const id = Number(r[f]);
        if (!id || id === Number(g[f]) || seenRes.has(id)) continue;
        seenRes.add(id);
        push(`resolution_${f}`, `${name} from resolution ${r.lv}`, id, lv, `Replaces ${name} from resolution level ${r.lv} on (sangvis_resolution ${r.id}); uses the ${name} level.`, true);
      }
    }
    for (const id of ids(g.passive_skill2).map(Number)) push('passive_skill', 'Passive', id, 1, 'Passive skills always run at level 1 [Gun.InitSkills].');
    for (const id of ids(g.dynamic_passive_skill).map(Number)) {
      const call = d.skillRow(id, 1)?.skill_lv_call ?? 0;
      const level = call === 1 ? L.skill1 : call === 2 ? L.skill2 : call === 3 ? L.skill3 : 1;
      push('dynamic_passive_skill', 'Hidden skill', id, level, call ? `Follows Skill ${call}'s level (skill_lv_call ${call}).` : 'Always level 1 (skill_lv_call 0).', [1, 2, 3].includes(call));
    }
    return entries;
  }

  gunEntries() {
    const g = this.g, d = this.d;
    const main = [['normal_attack', 'Normal attack'], ['skill1', 'Skill 1'], ['skill2', 'Skill 2 (Neural Upgrade)']];
    const entries = [];
    for (const [field, label] of main) {
      const id = g[field];
      if (!id) continue;
      const level = field === 'normal_attack' ? 1 : this.levels[field];
      entries.push({ field, label, group: id, level, trained: field !== 'normal_attack', why: field === 'normal_attack' ? 'Normal attacks only have level 1.' : `Uses the doll's ${label.split(' (')[0]} level.` });
    }
    for (const id of list(g.passive_skill).map(Number)) {
      entries.push({ field: 'passive_skill', label: 'Passive', group: id, level: 1, why: 'Passive skills always run at level 1 [Gun.InitSkills].' });
    }
    for (const id of list(g.dynamic_passive_skill).map(Number)) {
      const r0 = d.skillRow(id, 1);
      const call = r0?.skill_lv_call ?? 0;
      const level = call === 1 ? this.levels.skill1 : call === 2 ? this.levels.skill2 : 1;
      const why = call === 1 ? 'Follows Skill 1’s level (skill_lv_call 1).' : call === 2 ? 'Follows Skill 2’s level (skill_lv_call 2).' : 'Always level 1 (skill_lv_call 0).';
      entries.push({ field: 'dynamic_passive_skill', label: 'Hidden skill', group: id, level, why, trained: call === 1 || call === 2 });
    }
    // Exclusive equipment and sets. All their skills are level 1 [Gun.InitDynamicPassiveSkillsAndEquipSkills];
    // an equipment "skill" replaces the normal attack [Gun.InitBattleSkill: GetSkill(0).set_id].
    const fits = (v) => list(v).map(Number).includes(g.id);
    for (const e of [...(d.t.equip?.values() ?? [])].filter((e) => fits(e.fit_guns))) {
      const nm = d.text(e.name) || `equipment ${e.id}`;
      const ew = 'Equipment skills always run at level 1.';
      if (Number(e.skill)) entries.push({ field: 'equip', equip: true, label: `With ${nm}: replaces the normal attack`, group: Number(e.skill), level: 1, why: ew });
      for (const id of ids(e.passive_skill).map(Number)) entries.push({ field: 'equip', equip: true, label: `With ${nm}`, group: id, level: 1, why: ew });
    }
    for (const s of [...(d.t.equip_group?.values() ?? [])].filter((s) => fits(s.fit_gun))) {
      const nm = d.text(s.name) || `set ${s.id}`;
      for (const p of list(s.group_skill)) {
        const [pieces, id] = p.split(':').map(Number);
        if (id) entries.push({ field: 'equip', equip: true, label: `Set ${nm}: ${pieces} pieces`, group: id, level: 1, why: 'Set bonus skills always run at level 1.', text: [d.text(s.des)] });
      }
    }
    // Equipment texts can describe the skills they add.
    for (const e of entries) if (e.equip && !e.text) {
      const eq = [...(d.t.equip?.values() ?? [])].find((x) => fits(x.fit_guns) && (Number(x.skill) === e.group || ids(x.passive_skill).map(Number).includes(e.group)));
      if (eq) e.text = ['description', 'sp_description', 'description_skill'].map((k) => d.text(eq[k]));
    }
    return entries;
  }

  run() {
    const g = this.g, d = this.d;
    const entries = this.entries();
    for (const e of entries) this.owned.set(e.group, e.level);
    this.noDescCheck = new Set(entries.filter((e) => e.equip).map((e) => e.group));
    // Numbers the whole kit can account for: descriptions often describe hidden skills too.
    this.kitFacts = [];
    const seen = new Set();
    for (const e of entries) { const r = d.skillRow(e.group, e.level); if (r) this.kitFacts.push(...this.numbersOf(r, seen)); }

    const sections = [];
    const missionOnly = [];
    for (const e of entries) {
      const row = d.skillRow(e.group, e.level);
      if (!row) { sections.push({ ...e, html: `<p class="bad">Skill ${e.group} is missing from battle_skill_config.</p>` }); continue; }
      if (e.field === 'passive_skill' && this.isMissionBonus(row)) { missionOnly.push({ e, row }); continue; }
      this.curEntry = e;
      const node = this.skillNode(row, { via: e.label, levelWhy: e.why, top: true });
      const plain = plainSummary(this, e, row);
      sections.push({ ...e, row, plain, html: node.replace('<!--plain-->', plain ? `<p class="plain"><b>In short:</b> ${esc(plain)}</p>` : '') });
    }
    this.curEntry = null;
    const missionHtml = missionOnly.length ? this.missionBonusTable(missionOnly) : '';
    this.checkLevelBugs(entries);
    const found = runChecks(d, g, entries, this.levels, { mag: this.mag, kind: this.kind });
    for (const n of found.notes) if (!this.notes.some((x) => x.text === n.text)) this.notes.push(n);
    this.untraced = found.untraced;
    const hidden = findHidden(this, entries);
    for (const n of hidden.notes) if (!this.notes.some((x) => x.text === n.text)) this.notes.push(n);
    const kind = this.kind;
    const type = kind === 'gun' ? GUN_TYPES[g.type] ?? g.type : kind === 'enemy' ? (g.code || `type ${g.type}`) : (g.en_name || g.code || '');
    return {
      kind, gun: g, name: d.unitName(kind, g), category: kind === 'gun' ? dollCategory(g.id) : kind, type,
      sections, missionHtml, missionCount: missionOnly.length, hidden: hidden.list, kitTexts: this.kitTexts ?? [],
      notes: this.notes, untraced: this.untraced, markersHtml: this.markersHtml(), formulasHtml: this.formulasHtml(),
    };
  }

  addNote(n) { if (!this.notes.some((x) => x.text === n.text)) this.notes.push(n); }

  /** Remember an effect for hidden-effect detection (hidden.js). */
  fact(ctx, kind, value, side, text, ref = null, extra = {}) {
    if (!this.curEntry) return;
    this.effects.push({ entry: this.curEntry, group: ctx?.row?.skill_group_id, rowType: ctx?.row?.type, kind, value, side, text, ref, gate: this._gate ?? [], ...this._factExtra, ...extra });
  }

  note(sev, text) {
    // The checks module reports missing records itself; here they are only shown inline.
    const inlineOnly = /is missing from|does not exist in battle_formula|^Skill \d+ is missing/.test(text);
    const cat = /malformed|^Formula/.test(text) ? 'formulas' : /bosses/.test(text) ? 'targeting' : /level/.test(text) ? 'levels' : /Pool reference|missing/.test(text) ? 'data' : /stacks but can only hold/.test(text) ? 'stacking' : 'other';
    if (!inlineOnly && !this.notes.some((n) => n.text === text)) this.notes.push({ sev, cat, text });
    if (sev === 'tech') return `<span class="flag flag-tech" title="${esc(text.replace(/<[^>]+>/g, ''))}">invalid value</span>`;
    return `<span class="flag flag-${sev}">${text}</span>`;
  }

  // ---------------------------------------------------------- values

  /** Resolve a parsed value in the context of a skill row (its data pools). Returns {v, html, poolRef}. */
  val(p, ctx, { unit = '' } = {}) {
    if (!p) return { v: null, html: '—' };
    if ('num' in p) return { v: p.num, html: esc(num(p.num)) + unit };
    if ('str' in p) return { v: null, html: `<code>${esc(p.str)}</code>` };
    if ('formula' in p) {
      const f = this.useFormula(p.formula, ctx);
      return { v: null, html: `${f}`, formula: p.formula };
    }
    if ('pool' in p) {
      const r = this.poolValue(p.pool, ctx.row);
      let html;
      if (r.error && (p.pool % 100 === 0)) html = this.note('tech', `Skill ${ctx.row?.id} has a value written as <code>${esc(p.malformed ?? '*' + p.pool)}</code>, which is not a valid pool reference: the game logs an error and uses 0.`) + ' 0';
      else if (r.error) html = this.note('bug', `Pool reference *${p.pool} in skill ${ctx.row?.id} points past the end of its data pool: the game logs an error and uses 0.`) + ' 0';
      else if (r.formula !== undefined) html = this.useFormula(r.formula, ctx);
      else html = esc(num(r.v)) + unit;
      return { v: r.error ? 0 : r.v, html, poolRef: r.error ? undefined : p.pool, formula: r.formula };
    }
    return { v: null, html: '?' };
  }
  valOf(cell, ctx, o) { return this.val(parseVal(cell), ctx, o); }

  /** Pool lookup [SkillUtils.GetSkillPoolValue]: pool = n/100 == 1 ? pool 1 : pool 2; index = n%100 (1-based). */
  poolValue(n, row, which = 'day') {
    if (!row) return { error: true };
    const p = Math.floor(n / 100) === 1 ? 1 : 2;
    const col = which === 'night' ? `night_data_pool_${p}` : which === 'sp' ? `sp_data_pool_${p}` : `data_pool_${p}`;
    const vals = list(row[col]);
    const i = (n % 100) - 1;
    if (!Number.isInteger(i) || i < 0 || i >= vals.length) return { error: true };
    const s = vals[i];
    if (s.startsWith('*')) return { formula: parseInt(s.slice(1), 10), raw: s };
    return { v: Number(s), raw: s };
  }
  /** Night / special pools and level range, shown next to a pool value. */
  poolVariants(n, row, fmt = num) {
    if (!row) return '';
    const bits = [];
    const lv = this.d.skillLevels(row.skill_group_id);
    const which = Math.floor(n / 100) === 1 ? 1 : 2;
    if (lv.length > 1) {
      const lo = this.poolValue(n, this.d.skillRow(row.skill_group_id, lv[0]));
      const hi = this.poolValue(n, this.d.skillRow(row.skill_group_id, lv[lv.length - 1]));
      if (!lo.error && !hi.error && lo.v !== undefined && hi.v !== undefined && lo.v !== hi.v) bits.push(`L${lv[0]} ${fmt(lo.v)} → L${lv[lv.length - 1]} ${fmt(hi.v)}`);
    }
    if (row.daynight_only === 2 && list(row[`night_data_pool_${which}`]).length) {
      const nv = this.poolValue(n, row, 'night');
      if (!nv.error) bits.push(`night: ${nv.formula !== undefined ? 'formula ' + nv.formula : fmt(nv.v)}`);
    }
    if (ids(row.sppool_trigger_id).length && list(row[`sp_data_pool_${which}`]).length) {
      const sv = this.poolValue(n, row, 'sp');
      if (!sv.error) bits.push(`special: ${sv.formula !== undefined ? 'formula ' + sv.formula : fmt(sv.v)}`);
    }
    return bits.length ? `(${bits.join('; ')})` : '';
  }
  alt(r, ctx, fmt) {
    const s = r?.poolRef ? this.poolVariants(r.poolRef, ctx.row, fmt) : '';
    return s ? ` <span class="alt">${s}</span>` : '';
  }

  // ---------------------------------------------------------- formulas

  useFormula(id, ctx) {
    const text = this.d.formula(id);
    if (!this.formulas.has(id)) this.formulas.set(id, { text, uses: new Set() });
    if (ctx?.row) this.formulas.get(id).uses.add(ctx.row.id);
    if (text === null) return this.note('bug', `Formula ${id} does not exist in battle_formula.`) + ` (formula ${id})`;
    try { parseFormula(text); } catch (e) {
      this.note('warn', `Formula ${id} (<code>${esc(this.d.rawFormula(id))}</code>) is malformed (${esc(e.message)}). The client's parser does not reject it, so what it evaluates to is uncertain.`);
    }
    const rg = this.formulaRange(id, ctx);
    const range = rg && rg.values.every((v) => typeof v === 'number') && rg.values.length <= 40 ? ` <span class="alt">(${this.rangeText(rg)})</span>` : '';
    return `<a class="formula" href="#f-${id}" title="${esc(text)}">${this.formulaEnglish(text, ctx)}</a>${range}`;
  }

  /**
   * Possible results of a formula when the only unknowns are stack counts of buffs (s/t buffidtier).
   * Returns { lo, hi, loAt, hiAt, values } or null when other unknowns are involved.
   */
  formulaRange(id, ctx) {
    const text = this.d.formula(id);
    if (!text) return null;
    let tree;
    try { tree = parseFormula(text); } catch { return null; }
    const tiers = [];
    const walk = (t) => {
      if (!t) return;
      if (t.n === 'fn' && /^[st]buffidtier$/.test(t.v) && t.args.length === 1 && t.args[0].n === 'num') {
        const key = t.v[0] + t.args[0].v;
        if (!tiers.some((x) => x.key === key)) {
          const b = this.d.t.battle_buff.get(t.args[0].v);
          tiers.push({ key, id: t.args[0].v, side: t.v[0], max: Math.min(b?.max_tier ?? 1, 20) });
        }
      }
      for (const k of ['a', 'b', 'c']) walk(t[k]);
      for (const a of t.args ?? []) walk(a);
    };
    walk(tree);
    if (!tiers.length || tiers.length > 3) return null;
    const results = [];
    const cur = {};
    const env = (t) => {
      if (t.n === 'fn' && /^[st]buffidtier$/.test(t.v) && t.args[0]?.n === 'num') return cur[t.v[0] + t.args[0].v];
      if (t.n === 'pool') { const r = this.poolValue(t.v, ctx?.row); return r.error || r.v === undefined ? undefined : r.v; }
      return undefined;
    };
    const rec = (k) => {
      if (k === tiers.length) { const v = evalFormula(tree, env); if (v !== undefined) results.push({ v: Number(v), at: { ...cur } }); return; }
      for (let n = 0; n <= tiers[k].max; n++) { cur[tiers[k].key] = n; rec(k + 1); }
    };
    rec(0);
    if (!results.length || results.length < (tiers.reduce((p, t) => p * (t.max + 1), 1))) return null;
    const vals = [...new Set(results.map((r) => r.v))].sort((a, b) => a - b);
    if (vals.length < 2) return null;
    const lo = results.find((r) => r.v === vals[0]); const hi = results.find((r) => r.v === vals[vals.length - 1]);
    return { lo: vals[0], hi: vals[vals.length - 1], loAt: lo.at, hiAt: hi.at, values: vals, tiers };
  }
  rangeText(rg) {
    const at = (a) => rg.tiers.map((t) => `${a[t.key]} stack${a[t.key] === 1 ? '' : 's'}${rg.tiers.length > 1 ? ` of ${t.id}` : ''}`).join(', ');
    return `${num(rg.lo)} at ${at(rg.loAt)} … ${num(rg.hi)} at ${at(rg.hiAt)}`;
  }

  formulaEnglish(text, ctx) {
    const toks = tokenizeFormula(text);
    const out = [];
    for (let i = 0; i < toks.length; i++) {
      const k = toks[i];
      if (k.t === 'num') out.push(esc(k.v));
      else if (k.t === 'var') {
        const who = k.side === '#' ? "target's" : k.side === '~' ? "vehicle's" : '';
        if (/^buff\d+$/.test(k.v)) { out.push(`<span class="bad">${esc(k.raw)}</span>`); continue; }
        out.push(esc(`${who ? who + ' ' : ''}${VAR_NAME[k.v] ?? k.v}`));
      } else if (k.t === 'dyn') out.push(esc(`$${k.v}`));
      else if (k.t === 'pool') {
        const r = this.poolValue(parseInt(k.v, 10), ctx?.row);
        out.push(r.error ? esc(`*${k.v}`) : esc(num(r.v)));
      } else if (k.t === 'id') {
        const fn = k.v; const nx = toks[i + 1];
        if (nx?.t === 'op' && nx.v === '(') {
          // read the argument (single number) if simple
          let j = i + 2, arg = '';
          while (j < toks.length && !(toks[j].t === 'op' && toks[j].v === ')')) { arg += toks[j].v; j++; }
          const base = fn.replace(/^[st]/, '');
          const who = fn.startsWith('s') && FUNC_NAME[base] ? "user's " : fn.startsWith('t') && FUNC_NAME[base] ? "target's " : '';
          if (FUNC_NAME[base]) {
            let a = arg;
            if (/^buffid/.test(base) && /^\d+$/.test(arg)) { a = this.buffRef(Number(arg)); this.markCheck(Number(arg), ctx); }
            else if (/^bufftype/.test(base) && /^\d+$/.test(arg)) a = `${arg} (${buffTypeName(Number(arg))})`;
            out.push(`${who}${FUNC_NAME[base](a)}`);
          } else if (fn === 'getchance') out.push(`random(${esc(arg)}%)`);
          else if (fn === 'salivecount') out.push(`allies alive`);
          else if (fn === 'talivecount') out.push(`enemies alive`);
          else if (fn === 'ssangvistag' || fn === 'tsangvistag') out.push(`${fn[0] === 's' ? "user" : "target"} has Sangvis tag ${esc(arg)}`);
          else if (fn === 'customtypecount') out.push(`vehicle components of type ${esc(arg)}`);
          else if (fn === 'enemyinrange') out.push(`enemies in range`);
          else if (fn === 'enemyinfront') out.push(`enemies in front`);
          else out.push(esc(`${fn}(${arg})`));
          i = j; continue;
        }
        out.push(esc(k.raw));
      } else if (k.t === 'op') out.push(esc({ '&': ' and ', '|': ' or ', '=': ' = ', '?': ' ? ', ':': ' : ' }[k.v] ?? ` ${k.v} `));
      else out.push(esc(k.v));
    }
    return out.join('').replace(/\s+/g, ' ').trim();
  }

  // ---------------------------------------------------------- markers (buffs used as switches/counters)

  marker(id) {
    if (!this.markers.has(id)) this.markers.set(id, { setBy: new Set(), removedBy: new Set(), checkedBy: new Set() });
    return this.markers.get(id);
  }
  markSet(id, ctx, removing) { if (ctx?.row) this.marker(id)[removing ? 'removedBy' : 'setBy'].add(ctx.row.skill_group_id); }
  markCheck(id, ctx) { if (ctx?.row) this.marker(id).checkedBy.add(ctx.row.skill_group_id); }

  buffRef(id) {
    const b = this.d.t.battle_buff.get(id);
    if (!b) return `<span class="bad">buff ${id} (missing)</span>`;
    const label = MARKER_TYPES.has(b.type) ? 'marker' : buffTypeName(b.type);
    return `<a class="buff" href="#b-${id}" title="${esc(b.name)}">buff ${id} «${this.d.nameHtml(b.name)}» <span class="bt">${esc(label)}</span></a>`;
  }
  skillRef(group) {
    const r = this.d.skillRow(group, this.owned.get(group) ?? 1);
    const name = r ? (this.d.text(r.name) || '') : '';
    return `<a class="skill" href="#s-${group}">skill ${group}${name ? ' «' + this.d.nameHtml(name) + '»' : ''}</a>`;
  }

  // ---------------------------------------------------------- triggers

  subject(target) {
    return { 0: 'the user', 1: 'the user', 2: "the user's current target", 3: 'any ally', 4: 'any enemy' }[target] ?? `unit (${target})`;
  }
  triggerText(id, ctx) {
    const t = this.d.t.battle_trigger.get(Number(id));
    if (!t) return `<span class="bad">trigger ${id} is missing</span>`;
    const who = this.subject(t.target);
    const p = String(t.parameter ?? '').trim();
    const buff = t.is_buff_type ? `buffs of type ${t.buff_id} (${buffTypeName(t.buff_id)})` : this.buffRef(t.buff_id);
    if (!t.is_buff_type && (t.type === 6 || t.type === 7)) this.markCheck(t.buff_id, ctx);
    switch (t.type) {
      case 0: case 1: return 'always';
      case 2: return `${who} has HP ≤ ${esc(p)}%`;
      case 3: return `${who} has HP ≥ ${esc(p)}%`;
      case 4: return `${who} is dead`;
      case 5: return `${who} is being targeted by an enemy`;
      case 6: return Number(p) <= 1 ? `${who} has ${buff}` : `${who} has ≥ ${plural(Number(p), 'stack')} of ${buff}`;
      case 7: return Number(p) <= 1 ? `${who} does not have ${buff}` : `${who} has fewer than ${plural(Number(p), 'stack')} of ${buff}`;
      case 8: {
        const ids = list(p).map(Number);
        const names = ids.map((m) => this.d.missionName(m) || m);
        return `the battle is in ${plural(ids.length, 'specific mission')}: <span class="missions">${esc(names.slice(0, 8).join(', '))}${ids.length > 8 ? '…' : ''}</span>`;
      }
      case 9: return 'the user belongs to the enemy side of the map';
      case 10: return `${who} has just dodged an attack (checked at that moment)`;
      case 11: return `a ${esc(p)}% chance roll succeeds`;
      case 13: return `${who} has just taken damage (checked at that moment)`;
      case 14: return `${who} has Force Shield ≤ ${esc(p)}%`;
      case 15: return `${who} has Force Shield ≥ ${esc(p)}%`;
      case 16: return `${who} has an HP shield ≤ ${esc(p)}`;
      case 17: return `${who} has an HP shield ≥ ${esc(p)}`;
      case 18: return `formula is true: ${this.useFormula(Number(p) >= FORMULA ? Number(p) - FORMULA : Number(p), ctx)}`;
      case 19: return `the battle background is one of: ${esc(p)}`;
      case 20: return `the battle's map node belongs to ${{ 1: 'G&K', 2: 'the enemy', 3: 'neutral' }[p] ?? p} (otherwise the skill is disabled for the whole battle)`;
      case 21: return `this skill has killed at least ${esc(p)} units`;
      default: return `trigger type ${t.type} (parameter ${esc(p)})`;
    }
  }
  triggerList(cell, ctx) {
    const ids = list(cell).filter((x) => x !== '0');
    return ids.map((x) => this.triggerText(x, ctx));
  }

  isMissionBonus(row) {
    const tr = list(row.trigger_id).filter((x) => x !== '0').map((x) => this.d.t.battle_trigger.get(Number(x)));
    return tr.length > 0 && tr.every((t) => t && t.type === 8) && !this.d.t.battle_action_config.get(row.action_id)?.creation_order && ids(row.buff_id_target).length === 0 && ids(row.buff_type_target).length === 0;
  }

  // ---------------------------------------------------------- targets

  targetText(id, ctx) {
    const a = this.d.t.battle_target_select_ai.get(Number(id));
    if (!a) return id ? `<span class="bad">target rule ${id} missing</span>` : 'no target rule';
    const n = a.target_number;
    let pool;
    switch (a.target_type) {
      case 1: pool = a.is_ingore_range ? 'enemies anywhere (range ignored)' : 'enemies within the user’s range'; break;
      case 2: pool = 'allies (including the user)'; break;
      case 3: pool = 'allies other than the user'; break;
      case 4: pool = 'the user'; break;
      case 7: pool = 'the user’s vehicle and its components'; break;
      case 8: pool = 'the user’s vehicle components'; break;
      default: pool = `units of kind ${a.target_type}`;
    }
    if (a.target_type === 4) return 'the user (self)';
    if (a.is_search_all) pool += ' (searching the whole battlefield)';
    const parts = [];
    const count = n === 0 ? `all ${pool}` : `${n} of the ${pool}`;
    parts.push(count);
    if (a.buff_trigger_type === 6 || a.buff_trigger_type === 7) {
      if (a.target_buff_id) {
        const b = a.is_buff_type ? `buffs of type ${a.target_buff_id}` : this.buffRef(a.target_buff_id);
        if (!a.is_buff_type) this.markCheck(a.target_buff_id, ctx);
        parts.push(a.buff_trigger_type === 6 ? `only those with ≥ ${plural(a.target_parameter || 1, 'stack')} of ${b}` : `only those without ${b}`);
      }
    } else if (a.buff_trigger_type === 18) parts.push(`only those for which ${this.useFormula(a.target_parameter >= FORMULA ? a.target_parameter - FORMULA : a.target_parameter, ctx)}`);
    const keys = list(a.select_order).map(Number); const asc = list(a.is_ascend_order).map(Number);
    const sorts = keys.map((k, i) => {
      if (k === 0) return null;
      const name = k >= FORMULA ? `formula ${this.useFormula(k - FORMULA, ctx)}` : SORT_KEY[k] ?? `key ${k}`;
      // is_ascend_order 1 -> SortScoutAsc, whose comparer returns -1 when left > right: highest first. Anything else -> lowest first.
      const o = asc[i] === 1 ? 'highest' : 'lowest';
      return `${o} ${name}`;
    }).filter(Boolean);
    if (sorts.length && n !== 0) parts.push(`picking the ${sorts.join(', then ')} first`);
    if (a.list_ranking > 1 && n !== 0) parts.push(`starting from place ${a.list_ranking} in that order`);
    const pr = { 2: 'echelon leader first', 3: 'bosses first', 4: 'then every unit in the same row as the chosen target', 5: 'then every unit in the same column as the chosen target' }[a.target_priority];
    if (pr) parts.push(pr);
    return parts.join(', ');
  }

  // ---------------------------------------------------------- skills

  skillNode(row, { via = '', levelWhy = '', top = false, castBy = '', depth = 0 } = {}) {
    const key = `s:${row.id}`;
    const name = this.d.text(row.name) || `(unnamed skill ${row.skill_group_id})`;
    const desc = this.d.text(row.description);
    const anchor = `s-${row.skill_group_id}`;
    if (this.expanded.has(key)) return `<p class="ref">→ ${this.skillRef(row.skill_group_id)} is described above.</p>`;
    this.expanded.add(key);
    if (depth > 8) return `<p class="ref">… (nesting too deep)</p>`;
    const ctx = { row };
    const h = [];
    const lv = this.d.skillLevels(row.skill_group_id);
    h.push(`<div class="skill-card${top ? ' top' : ''}" id="${anchor}">`);
    h.push(`<div class="skill-head"><span class="sname">${this.d.nameHtml(name)}</span> <span class="sid">skill ${row.skill_group_id} · level ${row.level}${lv.length > 1 ? ` of ${lv.length}` : ''} · ${esc(SKILL_TYPE[row.type] ?? 'type ' + row.type)} · priority ${row.skill_priority}</span>${via ? ` <span class="via">${esc(via)}</span>` : ''}</div>`);
    if (desc) h.push(`<blockquote class="desc">${this.d.nameHtml(desc)}</blockquote>`);
    if (top) h.push('<!--plain-->');
    if (levelWhy) h.push(`<p class="why">${esc(levelWhy)}</p>`);
    if (castBy) h.push(`<p class="why">${castBy}</p>`);

    // When
    const when = [];
    const trig = this.triggerList(row.trigger_id, ctx);
    const cd = this.cooldownText(row, ctx);
    if (row.type === 3) when.push(`Used as the ${this.kind === 'gun' ? 'doll' : 'unit'}’s attack whenever it is ready to fire${trig.length ? ' and ' + trig.join(' <b>and</b> ') : ''}. ${cd}`);
    else {
      if (trig.length) when.push(`Fires when ${trig.join(' <b>and</b> ')}.`);
      else when.push('No condition: it fires as soon as its cooldown allows.');
      when.push(cd);
    }
    if (list(row.sppool_trigger_id).some((x) => x !== '0')) when.push(`Uses its <b>special</b> value pools while ${this.triggerList(row.sppool_trigger_id, ctx).join(' and ')}.`);
    if (row.daynight_only === 3) when.push('Only usable in night battles.');
    if (row.daynight_only === 4) when.push('Only usable in day battles.');
    if (row.daynight_only === 2) when.push('Uses different values at night (night pools).');
    const blocks = list(row.special_buff_trigger).map(Number);
    if (blocks.includes(1) || blocks.includes(2)) when.push(`Blocked while the user is ${[blocks.includes(1) && 'disarmed', blocks.includes(2) && 'silenced'].filter(Boolean).join(' or ')}.`);
    if (row.is_manual && [1, 6, 10].includes(row.type)) when.push('Set to manual casting by default.');
    if (row.interrupt_type === 1 && row.type !== 4) when.push('Keeps running if the user is stunned.');
    if (row.continue_after_death) when.push('Keeps running after the user dies or retreats.');
    h.push(section('When it is used', when));

    // Who
    if (row.target_select_ai) {
      const who = [this.targetText(row.target_select_ai, ctx)];
      if (row.is_re_target === 1) who.push('Shares the echelon’s common target where possible.');
      h.push(section('Targets', [cap(who[0]) + '.', ...who.slice(1)]));
    }

    // What
    const eff = [];
    const bd = this.valOf(row.buff_delay, ctx);
    const at = bd.v ? ` (${sec(bd.v)} into the skill)` : '';
    for (const [col, who] of [['buff_type_target', 'targets'], ['buff_type_self', 'user']]) {
      for (const p of ids(row[col])) {
        const [ty, ct] = p.split(':');
        const c = parseVal(ct);
        const cv = c?.num;
        const what = cv === -99 || cv === 99 ? 'all stacks of every' : cv < 0 ? `${-cv} stack(s) of each` : `${esc(ct)} of each`;
        eff.push(`Removes ${what} buff of type ${esc(ty)} (${esc(buffTypeName(Number(ty)))}) from the ${who}${at}.`);
      }
    }
    const tside = this.d.t.battle_target_select_ai.get(row.target_select_ai)?.target_type === 1 ? 'enemy' : 'ally';
    for (const [col, who, side] of [['buff_id_target', 'each target', tside], ['buff_id_self', 'the user', 'self']]) {
      for (const b of parseBuffList(row[col])) eff.push(this.applyBuff(b, who, ctx, at, depth, '', side));
    }
    const action = this.d.t.battle_action_config.get(row.action_id);
    if (action) eff.push(...this.actionLines(action, ctx, depth));
    const dur = this.valOf(row.skill_duration, ctx);
    if (row.is_form_action === 1 && dur.v > 1 && row.type !== 3) eff.push(`The user is busy with this skill for ${sec(dur.v)} and does not attack or start other skills meanwhile.`);
    if (!eff.length) eff.push('<span class="dim">No direct effect (it may only exist to be checked by other skills, or its effect comes from the buffs above).</span>');
    h.push(section('What it does', eff));

    // Per-skill quirks
    const q = this.skillQuirks(row, desc, ctx);
    if (q.length) h.push(section('Notes', q));
    h.push('</div>');
    return h.join('\n');
  }

  cooldownText(row, ctx) {
    if (row.cd_type >= FORMULA) {
      const c = this.d.t.battle_skill_type_config.get(row.cd_type - FORMULA);
      if (!c) return `Uses charge type ${row.cd_type - FORMULA} (missing).`;
      return `Charge skill: holds up to ${c.charge_tier} charge(s), starts with ${c.start_charge_tier}, and regains one every ${sec(c.charge_time)}.`;
    }
    if (row.type === 3 || row.cd_type === 3) return '';
    if (row.cd_type === 0) return 'No cooldown.';
    const cd = this.valOf(row.cd_time, ctx);
    const st = this.valOf(row.start_cd_time, ctx);
    if (row.cd_type === 2 || row.cd_type === 4) return `Cooldown ${esc(row.cd_time)} ${row.cd_type === 4 ? 'won ' : ''}battles.`;
    let s;
    if (cd.v >= 9999) s = 'Once per battle';
    else if (cd.v !== null && cd.v <= 1) s = 'Checked every frame (cooldown 1 frame), so it fires whenever its condition becomes true';
    else s = `Cooldown ${cd.v !== null ? sec(cd.v) : cd.html}`;
    if (cd.v !== null && cd.v > 1 && cd.v < 9999) s += row.is_cdr ? ' (shortened by cooldown reduction)' : ' (<b>not</b> affected by cooldown reduction)';
    if (st.v) s += `; first use after ${sec(st.v)}`;
    else if (cd.v >= 9999) s += ', at the start of battle (or when its condition first holds)';
    return s + '.';
  }

  applyBuff(b, who, ctx, at = '', depth = 0, extra = '', side = '') {
    if (b.idFormula !== null && b.idFormula !== undefined) {
      // The buff id itself is a formula result, e.g. "has buff X ? buff A : buff B".
      const f = this.d.formula(b.idFormula) ?? '';
      const cands = [...new Set((f.match(/[?:]\s*(\d+)/g) ?? []).map((x) => Number(x.replace(/[?:\s]/g, ''))))].filter((x) => this.d.t.battle_buff.has(x));
      const inner = this.gated(this.formulaGate(b.idFormula), () => cands.map((id) => `<li>${this.applyBuff({ ...b, id, idFormula: null }, who, ctx, '', depth, '', side)}</li>`).join(''));
      return `Gives ${who} a buff chosen by ${this.useFormula(b.idFormula, ctx)}${at}:<ul>${inner}</ul>`;
    }
    const st = b.stacks;
    let n, stacksHtml = '';
    if (st && 'num' in st) n = st.num;
    else if (st && 'pool' in st) { const r = this.val(st, ctx); n = r.v ?? undefined; if (n === 0) stacksHtml = `written as <code>${esc(st.malformed ?? '*' + st.pool)}</code>, which the game reads as 0 = the default`; }
    if (n !== undefined && n < 0) {
      this.markSet(b.id, ctx, true);
      return `Removes ${plural(-n, 'stack')} of ${this.buffRef(b.id)} from ${who}${at}.`;
    }
    this.markSet(b.id, ctx, false);
    let stacks;
    if (n === undefined) stacks = this.val(st, ctx).html + ' stack(s)';
    else if (n === 0 && ctx.creationList) stacks = '';
    else if (n === 0) {
      // 0 = "default": the caster's GetBuffNum(), which for dolls is the magazine size (gun.special)
      // [CSkillInstance._HandleBuff / _GenHurtBuff -> CharacterSkillImpl.GetBuffNum -> bulletChainNum].
      const mag = this.mag;
      stacks = this.kind === 'enemy'
        ? `the default stack count (0 for enemies, so no stacks at all${stacksHtml ? '; ' + stacksHtml : ''})`
        : `as many stacks as its magazine size (${mag}${mag === 0 ? ', so no stacks at all' : ''}${stacksHtml ? '; ' + stacksHtml : ''})`;
      n = mag;
    } else stacks = plural(n, 'stack');
    const fid = st && 'formula' in st ? st.formula : st && 'pool' in st ? this.val(st, ctx).formula : undefined;
    const node = this.gated(fid !== undefined ? this.formulaGate(fid) : [], () => this.buffNode(b.id, ctx, depth, n, side));
    return `Gives ${who}${stacks ? ' ' + stacks + ' of' : ''} ${node}${at}${extra}.`;
  }

  /** Buffs on the user that a formula reads: an effect whose stacks or id come from it depends on them. */
  formulaGate(id) { return [...String(this.d.formula(id) ?? '').matchAll(/sbuffidtier\((\d+)\)/g)].map((m) => Number(m[1])); }
  /** Run fn with extra gating buffs recorded on every fact it produces (see hidden.js). */
  gated(ids, fn) {
    const prev = this._gate ?? [];
    this._gate = [...prev, ...ids];
    try { return fn(); } finally { this._gate = prev; }
  }

  // ---------------------------------------------------------- buffs

  buffNode(id, ctx, depth = 0, stacksGiven, side = '') {
    const b = this.d.t.battle_buff.get(id);
    if (!b) return this.note('bug', `Buff ${id} is missing from battle_buff.`);
    const key = `b:${id}@${ctx.row?.id}`;
    const ref = this.buffRef(id);
    if (this.expanded.has(key)) return ref;
    this.expanded.add(key);
    const parts = [];
    const eff = this.buffEffect(b, ctx);
    if (eff) parts.push(eff);
    this.buffFact(b, ctx, side);
    // duration and stacking
    const dur = this.valOf(b.duration, ctx);
    let durTxt = dur.v === -1 ? 'until removed' : dur.v >= 9999 ? 'whole battle' : dur.v !== null && dur.v !== undefined ? sec(dur.v) : `${dur.html} frames`;
    durTxt += this.alt(dur, ctx, (v) => sec(v));
    parts.push(durTxt);
    if (b.delay) parts.push(`takes effect ${sec(b.delay)} after being applied`);
    parts.push(b.max_tier > 1 ? `up to ${b.max_tier} stacks` : 'refreshes when reapplied');
    if (stacksGiven > b.max_tier) parts.push(this.note('warn', `Buff ${id} is applied with ${stacksGiven} stacks but can only hold ${b.max_tier}.`));
    const shared = this.sharedGroup(b);
    if (shared) parts.push(shared);
    if (b.boss_available === 0 && side === 'enemy') parts.push(this.note('info', `Buff ${id} (${esc(buffTypeName(b.type))}) cannot be applied to bosses, so it does nothing to them.`));
    const types = list(b.available_gun_type).map(Number);
    if (types.length) parts.push(`only affects ${types.map((t) => GUN_TYPES[t] ?? (t > 200 ? ['', 'Sangvis bosses', 'Sangvis elites', 'Sangvis normal units'][t - 200] : t > 100 ? `Sangvis with tag ${t - 100}` : t)).join('/')}`);
    if (list(b.buff_sp_attributes).includes('1')) parts.push('cannot be cleansed');
    if (b.forced_debuff === 1) parts.push('counts as a debuff');
    // attached things
    const sub = [];
    for (const s of list(b.forced_skill).map(Number).filter((x) => x > 0)) sub.push(this.childSkill(s, 'While this buff is active, the unit has this skill', depth, true));
    if (b.watch_id) sub.push(this.watchNode(b.watch_id, ctx, depth));
    if (b.orb_effect && [132, 133, 134].includes(b.type)) sub.push(this.childSkill(Number(b.orb_effect), 'Extra effect added to attacks', depth));
    if (b.type === 136 && b.hurt_id) sub.push(`<li>Every ${sec(this.valOf(b.hurt_cd, ctx).v ?? 0)}: ${this.hurtNode(b.hurt_id, ctx)}</li>`);
    if (b.type === 402 && b.fix_damage) sub.push(`<li>Damage the unit takes becomes: ${this.valOf(b.fix_damage, ctx).html}</li>`);
    for (const c of list(b.trigger_creation_id)) {
      const cv = this.valOf(c, ctx);
      const cid = cv.v ?? null;
      if (cid) { const ch = this.creationNode(cid, ctx, depth + 1); if (ch) sub.push(`<li>While active it carries: ${ch}</li>`); }
    }
    return `${ref} <span class="binfo">(${parts.join('; ')})</span>${sub.length ? `<ul>${sub.join('')}</ul>` : ''}`;
  }

  /** Record what a buff does as a fact for hidden.js: kind, the number a description would state, and a short text. */
  buffFact(b, ctx, side) {
    const t = b.type;
    if (MARKER_TYPES.has(t) || t === 401 || t === 415) return;
    const dv = this.valOf(b.duration, ctx).v;
    this._factExtra = { dur: dv === -1 ? 'until removed' : dv >= 9999 ? 'for the whole battle' : dv > 1 ? `for ${num(dv / FPS)} s` : '', stacks: b.max_tier };
    try { this.buffFactInner(b, ctx, side); } finally { this._factExtra = null; }
  }

  buffFactInner(b, ctx, side) {
    const t = b.type;
    const v = this.valOf(b[BUFF_COL[t] ?? 'parameter_value'], ctx).v;
    const who = { self: 'the user', ally: 'allies', enemy: 'enemies' }[side] ?? 'units';
    const ref = `buff ${b.id}`;
    const R = { buff: b.id };
    const known = v !== null && v !== undefined;
    if (PCT_STAT[t]) {
      const k = PCT_STAT[t];
      if (known && v === 100) return;
      if (t === 128 || t === 228) return this.fact(ctx, 'stat:cdr', known ? 100 - v : undefined, side, `cooldowns ×${num(v / 100)} for ${who} (${ref})`, R);
      // +900% and more is how kits write "always crits".
      if (k === 'crit' && known && v >= 1000) return this.fact(ctx, 'surecrit', undefined, side, `guaranteed crits for ${who} (${ref})`, R);
      return this.fact(ctx, `stat:${k}`, known ? v - 100 : undefined, side, `${STAT[k]} ${known ? `${signed(v - 100)}%` : 'changed by a formula'} for ${who} (${ref})`, R);
    }
    if (FLAT_STAT[t]) {
      const k = FLAT_STAT[t];
      if (known && v === 0) return;
      if (k === 'crit' && known && v >= 900) return this.fact(ctx, 'surecrit', undefined, side, `guaranteed crits for ${who} (${ref})`, R);
      return this.fact(ctx, `stat:${k}`, v ?? undefined, side, `${STAT[k]} ${known ? signed(v) : 'changed by a formula'} (flat) for ${who} (${ref})`, R);
    }
    const simple = {
      107: ['invuln', 'cannot take damage'], 120: ['invuln', 'immune to skill damage'], 109: ['hpshield', `an HP shield of ${num(v)}`],
      110: ['dmgtaken', `damage taken ${signed(v - 100)}%`], 122: ['forceshield', `Force Shield ${num(v)}`], 124: ['forceshield', `max Force Shield ×${num(v / 100)}`],
      224: ['forceshield', `max Force Shield ×${num(v / 100)}`], 221: ['stun', 'stunned'], 301: ['taunt', 'taunted'], 302: ['blind', 'blinded'], 303: ['phase', 'untargetable'],
      304: ['disarm', 'disarmed'], 305: ['silence', 'silenced'], 307: ['cantdie', 'cannot die'], 136: ['dot', 'damage over time'], 220: ['dot', 'burning'],
      129: ['cooldown', `remaining cooldowns ×${num(v / 100)}`], 130: ['charges', `${num(v)} charge(s)`], 131: ['charges', `max charges +${num(v)}`],
      132: ['extra', 'an extra effect on attacks'], 133: ['extra', 'an extra effect on grenades'], 134: ['extra', 'an extra effect on sniper attacks'], 135: ['extra', 'an extra attack'],
      402: ['dmgrecalc', 'damage recalculated'], 222: ['smoke', 'smoke'],
    }[t];
    if (!simple) return;
    const value = { 109: v, 110: v - 100, 122: v, 129: 100 - v, 130: v, 131: v }[t];
    this.fact(ctx, simple[0], Number.isFinite(value) ? value : undefined, side, `${simple[1]} for ${who} (${ref})`, R);
  }

  /** The buff's effect in words, with its value resolved. */
  buffEffect(b, ctx) {
    const t = b.type;
    const col = BUFF_COL[t] ?? 'parameter_value';
    const v = this.valOf(b[col], ctx);
    const val = v.html;
    if (PCT_STAT[t]) {
      const stat = STAT[PCT_STAT[t]];
      if (t === 128 || t === 228) return `cooldowns of its skills (those affected by CDR) run ×${val}/100 as long`;
      if (v.v === null || v.v === undefined) return `${stat} ×(${val})/100 per stack, multiplying with other buffs`;
      const change = v.v - 100;
      const word = `${stat} ${change >= 0 ? '+' : '−'}${num(Math.abs(change))}% (×${num(v.v / 100)})`;
      return `<b>${word}</b>${this.alt(v, ctx, (x) => `${signed(x - 100)}%`)} per stack, multiplying with other buffs (${b.max_tier > 1 ? `2 stacks = ×${num((v.v / 100) ** 2)}` : 'not added to them'})`;
    }
    if (FLAT_STAT[t]) {
      const stat = STAT[FLAT_STAT[t]];
      if (v.v === null || v.v === undefined) return `<b>${stat} +(${val})</b> flat per stack, added after all percentage buffs`;
      return `<b>${stat} ${signed(v.v)}</b>${this.alt(v, ctx)} flat per stack, added after all percentage buffs` + (t === 810 ? ' (to each hit the unit takes)' : '');
    }
    switch (t) {
      case 107: return '<b>takes no damage</b>';
      case 109: return `<b>HP shield of ${val}</b>${this.alt(v, ctx)} (absorbs damage before HP)`;
      case 110: {
        if (v.v === null || v.v === undefined) return `<b>damage taken ×(${val})/100</b> per stack`;
        const c = v.v - 100;
        return `<b>damage taken ${c >= 0 ? '+' : '−'}${num(Math.abs(c))}% (×${num(v.v / 100)})</b>${this.alt(v, ctx, (x) => `${signed(x - 100)}%`)} per stack, multiplying with other damage-taken buffs`;
      }
      case 120: return '<b>immune to skill damage</b>';
      case 122: return `<b>Force Shield ${val}</b>`;
      case 124: case 224: return `<b>max Force Shield ×${val}/100</b>`;
      case 129: {
        if (v.v === null || v.v === undefined) return `when it starts, multiplies the remaining cooldowns of the unit’s skills by ${val}/100 (at most −30% at once)`;
        return `when it starts, <b>remaining cooldowns ×${num(v.v / 100)}</b>${v.v < 70 ? ' — but the game caps one reduction at −30%, so the real effect is ×0.7' : ''} (only skills affected by CDR)`;
      }
      case 130: return `<b>${val} charge(s)</b> added to the unit’s charge skill`;
      case 131: return `<b>max charges +${val}</b>`;
      case 132: return '<b>adds an extra effect to the unit’s attacks</b>';
      case 133: return '<b>adds an extra effect to the unit’s grenade attacks</b>';
      case 134: return '<b>adds an extra effect to the unit’s sniper attacks</b>';
      case 136: return '<b>damage over time</b>';
      case 221: return '<b>stunned</b> (cannot act)';
      case 301: return '<b>taunted</b>';
      case 303: return '<b>phased</b> (cannot be targeted)';
      case 304: return '<b>disarmed</b> (blocks skills marked as disarmable)';
      case 305: return '<b>silenced</b> (blocks skills marked as silenceable)';
      case 307: return '<b>cannot die</b> (HP will not drop below 1)';
      case 401: return '';
      case 402: return '<b>recalculates damage the unit takes</b>';
      case 404: return `<b>night vision ${val}</b>`;
      case 408: return `delays matching damage by ${val} frames`;
      case 409: return `locks a stat (${val})`;
      default:
        if (MARKER_TYPES.has(t)) return '';
        return `<span class="dim">${esc(buffTypeName(t))}${b[col] !== undefined && String(b[col]).trim() !== '' ? ' ' + val : ''}</span>`;
    }
  }

  /** Buffs sharing type + conflict_type share one stack counter [BattleConditionList.Add -> RemoveConflictNum]. */
  sharedGroup(b) {
    if (!this._groups) {
      this._groups = new Map();
      for (const x of this.d.t.battle_buff.values()) {
        const k = x.type * 1e6 + x.conflict_type;
        if (!this._groups.has(k)) this._groups.set(k, []);
        this._groups.get(k).push(x.id);
      }
    }
    const others = this._groups.get(b.type * 1e6 + b.conflict_type).filter((x) => x !== b.id);
    if (!others.length) return '';
    return `<span title="${others.join(', ')}">limit shared with ${plural(others.length, 'other buff')}</span>`;
  }

  // ---------------------------------------------------------- actions, creations, hits

  actionLines(a, ctx, depth) {
    const out = [];
    const cids = list(a.creation_order); const dl = list(a.creation_delay);
    let visual = 0;
    cids.forEach((c, i) => {
      const cv = this.valOf(c, ctx); const cid = cv.v;
      if (!cid) return;
      const html = this.creationNode(cid, ctx, depth + 1);
      const d = Number(dl[i] ?? 0);
      if (html) out.push(`${d ? `At ${sec(d)}: ` : ''}${html}`);
      else visual++;
    });
    const sm = list(a.summon_order); const sd = list(a.summon_delay);
    sm.forEach((s, i) => { if (Number(s)) out.push(`${Number(sd[i]) ? `At ${sec(Number(sd[i]))}: ` : ''}${this.summonNode(Number(s), ctx, depth)}`); });
    const ts = list(a.stop_time_speed);
    if (ts.length) out.push(`Slows everything else to ${esc(ts.join('/'))}% speed for ${esc(list(a.stop_time_duration).map((x) => sec(Number(x))).join('/'))} (time stop).`);
    const mv = list(a.move_order); const mvd = list(a.move_delay);
    mv.forEach((m, i) => {
      if (!Number(m)) return;
      const d = Number(mvd[i] ?? 0);
      out.push(`${d ? `At ${sec(d)}: ` : ''}${this.moveText(Number(m), ctx)}`);
    });
    if (visual && !out.length) out.push(`<span class="dim">Only visual effects (${visual}).</span>`);
    return out;
  }

  creationHasEffect(c, seen = new Set()) {
    if (!c || seen.has(c.id)) return false;
    seen.add(c.id);
    if (ids(c.hurt_id).length || ids(c.buff_id).length || ids(c.buff_type).length || ids(c.summoner_order).length) return true;
    return list(c.trigger_creation_id).some((x) => { const n = Number(x); return n && this.creationHasEffect(this.d.t.battle_creation.get(n), seen); });
  }

  creationNode(id, ctx, depth) {
    const c = this.d.t.battle_creation.get(id);
    if (!c) return this.note('bug', `Creation ${id} is missing from battle_creation.`);
    if (!this.creationHasEffect(c)) return '';
    const key = `c:${id}@${ctx.row?.id}`;
    if (this.expanded.has(key)) return `the same object as before (creation ${id})`;
    this.expanded.add(key);
    if (depth > 12) return `creation ${id} (nesting too deep)`;
    const bits = [];
    const kind = c.code ? 'an effect' : 'an invisible object';
    const posName = (t) => POS_TYPE[t] ?? (t !== '' && t !== undefined ? `the user's "${esc(t)}" model node` : 'the user');
    const start = posName(c.start_type) + offText(c.start_offset);
    const dest = posName(c.destination_type) + offText(c.destination_offset);
    const route = ROUTE[c.route_type] ?? `moves (${c.route_type})`;
    let head;
    if (STATIONARY.has(c.route_type)) {
      head = `Creates ${kind} (creation ${id}) at ${start} that ${route}`;
      if (String(c.destination_type) !== String(c.start_type) || offText(c.destination_offset) !== offText(c.start_offset)) head += ` (its destination, ${dest}, is only used to face it)`;
    } else head = `Creates ${kind} (creation ${id}) at ${start} that ${route} to ${dest}`;
    if (c.is_tracing) head += STATIONARY.has(c.route_type) ? ', following the target' : ', homing on the target';
    if (c.is_clone) head += ' — one copy per target';
    if (c.is_form_play === 1) head += ' — <b>one per dummy link</b>';
    if (Number(c.random_number) > 0 && list(c.random_offset, ';').length) head += ` — ${plural(Number(c.random_number), 'copy', 'copies')} at random spots from ${plural(list(c.random_offset, ';').length, 'listed offset')}`;
    const life = this.valOf(c.exist_duration, ctx);
    if (life.v > 1 && life.v < 99999) head += `, lasting ${sec(life.v)}`;
    bits.push(head + '.');
    // effect_type is gsEffect.enumAffect: 0 = only the creation's target, 1 = the caster's allies, 2 = its enemies.
    const aff = c.effect_type === 1 ? 'allies' : c.effect_type === 2 ? 'enemies' : 'target';
    const p1 = this.valOf(c.effect_param_1, ctx); const p2 = this.valOf(c.effect_param_2, ctx);
    if (aff === 'target') bits.push(`Affects only its target.`);
    else switch (c.effect_area) {
      case 0: bits.push(`Affects only its target.`); break;
      case 1: {
        // Circle: hits a unit when any of its dummy links is within radius + 0.4. A non-zero effect_param_2 other
        // than 180 turns it into a sector of that half-angle facing +x (negative: facing −x) [UpdateTargetsInRange].
        if (!p1.v && p1.formula === undefined) { bits.push(`Affects the ${aff === 'allies' ? 'ally' : 'enemy'} it reaches (no splash radius).`); break; }
        const half = Number(p2.v) || 0;
        if (half && Math.abs(half) < 180) bits.push(`Affects ${aff} in a <b>${num(Math.abs(half) * 2)}° cone</b> of radius ${p1.html} facing ${half > 0 ? 'right (+x, toward the enemy side of the map)' : 'left (−x, toward the Griffin side)'}.`);
        else bits.push(`Affects ${aff} within a radius of ${p1.html} (a unit counts when one of its dummy links is within the radius + 0.4).`);
        break;
      }
      case 2: bits.push(`Affects ${aff} in a ${p1.html} (left-right) × ${p2.html} (up-down) rectangle centred on it.`); break;
      case 3: bits.push(`Affects ${aff} in ${plural(list(c.effect_param_1).length, 'tile-sized cell')} of a 5×5 grid around it (cells <code>${esc(c.effect_param_1)}</code>; 13 is the centre).`); break;
      case 4: bits.push(`Affects ${aff} in a ${p1.html} × ${p2.html} rectangle that starts at it and turns with it.`); break;
    }
    this.creationQuirks(c, aff, p1, p2, ctx);
    if (c.is_single_hurt) bits.push('Each unit can be hit by it only once.');
    const sub = [];
    const rowSide = this.d.t.battle_target_select_ai.get(ctx.row?.target_select_ai)?.target_type === 1 ? 'enemy' : 'ally';
    const side = aff === 'allies' ? 'ally' : aff === 'enemies' ? 'enemy' : rowSide;
    const hurts = list(c.hurt_id); const hcd = list(c.hurt_cd);
    const half = Number(p2.v) || 0;
    const areaPlain = aff === 'target' ? '' : c.effect_area === 1 && p1.v ? (half && Math.abs(half) < 180 ? `in a ${num(Math.abs(half) * 2)}° cone of radius ${num(p1.v)}` : `in a radius of ${num(p1.v)}`)
      : c.effect_area === 2 && p1.v ? `in a ${num(p1.v)} × ${num(p2.v ?? 0)} area` : c.effect_area === 3 ? `on ${plural(list(c.effect_param_1).length, 'tile')}` : '';
    hurts.forEach((h, i) => {
      if (h === '0') return;
      const every = Number(hcd[i] ?? 0);
      sub.push(`<li>${every ? `Every ${sec(every)}` : 'On contact'}: ${this.hurtNode(Number(h), { ...ctx, hitSide: side, area: areaPlain, every, life: life.v > 1 && life.v < 99999 ? life.v : 0 }, depth)}</li>`);
    });
    const buffs = parseBuffList(c.buff_id); const bcd = list(c.buff_cd);
    buffs.forEach((b, i) => {
      const every = Number(bcd[i] ?? 0);
      sub.push(`<li>${this.applyBuff(b, aff === 'target' ? 'its target' : `${aff} it reaches`, { ...ctx, creationList: true }, every ? ` every ${sec(every)}` : '', depth, '', side)}</li>`);
    });
    if (ids(c.buff_type).length) sub.push(`<li>Removes buffs by type: <code>${esc(c.buff_type)}</code>.</li>`);
    if (c.active_times) sub.push(`<li>Hands out its buffs at most ${c.active_times} time(s).</li>`);
    const kids = list(c.trigger_creation_id); const kd = list(c.trigger_creation_delay);
    kids.forEach((k, i) => {
      const kv = Number(k); if (!kv) return;
      const html = this.creationNode(kv, { ...ctx, inCreation: true }, depth + 1);
      if (!html) return;
      const d = Number(kd[i] ?? 0);
      sub.push(`<li>${d === -1 ? 'When it hits or ends' : d ? `After ${sec(d)}` : 'Immediately'}: ${html}</li>`);
    });
    const sm = list(c.summoner_order); const sd = list(c.summoner_delay);
    sm.forEach((s, i) => { if (Number(s)) sub.push(`<li>${Number(sd[i]) ? `After ${sec(Number(sd[i]))}: ` : ''}${this.summonNode(Number(s), ctx, depth)}</li>`); });
    const field = ctx.inCreation ? '' : this.fieldHtml(id, ctx);
    return `${bits.join(' ')}${field}${sub.length ? `<ul>${sub.join('')}</ul>` : ''}`;
  }

  /**
   * Geometry of a creation and its child creations for field.js, with pool values resolved in ctx.
   * Returns null for objects with nothing to draw.
   */
  creationSpec(id, ctx, depth = 0, seen = new Set()) {
    const c = this.d.t.battle_creation.get(id);
    if (!c || depth > 3 || seen.has(id)) return null;
    seen.add(id);
    const v = (cell) => { const r = this.valOf(cell, ctx); return typeof r.v === 'number' ? r.v : null; };
    const off = (s) => { const p = list(s).map(Number); return [p[0] || 0, p[2] || 0]; };
    const hits = this.creationHasEffect(c);
    const kids = [];
    const kd = list(c.trigger_creation_delay);
    list(c.trigger_creation_id).forEach((k, i) => { const s = this.creationSpec(Number(k), ctx, depth + 1, seen); if (s) kids.push({ delay: Number(kd[i] ?? 0), spec: s }); });
    if (!hits && !kids.length) return null;
    const aff = c.effect_type === 1 ? 'ally' : c.effect_type === 2 ? 'enemy' : 'target';
    const area = { type: aff === 'target' ? 0 : c.effect_area, p1: v(c.effect_param_1), p2: v(c.effect_param_2), cells: c.effect_area === 3 ? list(c.effect_param_1).map(Number) : [], toTarget: aff === 'target' || c.effect_area === 0 || (c.effect_area === 1 && !v(c.effect_param_1)) };
    if (area.type === 1 && !area.p1) area.type = 0;
    const rnd = Number(c.random_number) > 0 ? list(c.random_offset, ';').map((s) => off(s.replace(/^[^\d-]+/, ''))) : [];
    return {
      id, route: c.route_type, hits, affects: aff, area, random: rnd, formPlay: c.is_form_play === 1, clone: c.is_clone === 1,
      start: { type: c.start_type, off: off(c.start_offset), form: c.is_form_offset_start === 1 },
      dest: { type: c.destination_type, off: off(c.destination_offset), form: c.is_form_offset === 1 },
      children: kids,
    };
  }

  /** A collapsed battlefield drawing for a creation with an area, a path or child creations. */
  fieldHtml(id, ctx) {
    const spec = this.creationSpec(id, ctx);
    if (!spec) return '';
    // The skill's target rule, so the page can pick targets in a loaded enemy team (field.js pickTargets).
    const ai = this.d.t.battle_target_select_ai.get(ctx.row?.target_select_ai);
    if (ai) {
      const asc = list(ai.is_ascend_order).map(Number);
      spec.aim = { type: ai.target_type, n: ai.target_number, rank: ai.list_ranking, ignoreRange: !!ai.is_ingore_range,
        keys: list(ai.select_order).map(Number).map((k, i) => ({ key: k, highFirst: asc[i] === 1, name: k >= FORMULA ? `formula ${k - FORMULA}` : SORT_KEY[k] ?? `key ${k}` })) };
    }
    const drawable = (s) => s.area.type !== 0 || !STATIONARY.has(s.route) || s.children.some((k) => drawable(k.spec));
    if (!drawable(spec)) return '';
    const casterSide = this.kind === 'enemy' ? 'enemy' : 'ally';
    const { svg, hits } = drawField(spec, defaultScenario(casterSide));
    const n = casterSide === 'ally' ? hits.enemy : hits.ally;
    const m = casterSide === 'ally' ? hits.ally : hits.enemy;
    const what = `${n ? `reaches ${plural(n, 'enemy', 'enemies')}` : ''}${n && m ? ' and ' : ''}${m ? `${plural(m, 'ally', 'allies')}` : ''}`;
    return `<details class="field" data-spec="${esc(JSON.stringify(spec))}" data-side="${casterSide}"><summary>Show on the battlefield${what ? ` <span class="dim">(in the sample layout it ${what})</span>` : ''}</summary>${svg}<p class="legend">Enemy-map coordinates; the Griffin formation is on the left. Dashed squares are formation slots, numbered like a numpad (1–3 bottom row, 3/6/9 front column); dots are dummy links, red = reached. Circles show the radius and, dashed, the radius + 0.4 that a link has to be within. Green dashed lines are GFLMaps' range lines: where an enemy of range 2 or 3 reaches the front column.</p></details>`;
  }

  /**
   * A movement (catchdata battle_movement_info) in words [CSkillInstance._HandleMovementtEvent / _UpdateMovement].
   * The unit using the skill moves: for knock-backs that is the knocked unit, which is made to use the skill.
   */
  moveText(id, ctx) {
    const m = this.d.t.battle_movement_info?.get(id);
    if (!m) return this.note('bug', `Movement ${id} is missing from catchdata battle_movement_info, so nothing moves.`);
    // offset: ';' list of choices, one picked at random; each "a,b[,c]" is read as left-right a and up-down b
    // (a third number is ignored), and is not mirrored for enemies [CSkillActions._LoadEvents].
    const offs = list(m.offset, ';').map((o) => list(o).map(Number)).filter((p) => p.length >= 2).map(([x, z]) => [x || 0, z || 0]);
    const offTxt = (o) => [o[0] ? `${num(Math.abs(o[0]))} ${o[0] > 0 ? 'toward the enemy side' : 'toward the Griffin side'}` : '', o[1] ? `${num(Math.abs(o[1]))} ${o[1] > 0 ? 'up' : 'down'} the map` : ''].filter(Boolean).join(' and ');
    const shift = offs.length > 1 ? ` shifted by one of ${offs.length} offsets picked at random (${offs.map((o) => offTxt(o) || 'none').join('; ')})` : offs.length && offTxt(offs[0]) ? ` shifted ${offTxt(offs[0])}` : '';
    const dest = {
      0: null, 1: `its own position${shift}`, 2: `its first target${shift}`, 6: `its first target${shift}`,
      3: `the Griffin team origin${shift}`, 5: `the Griffin team origin${shift}`, 4: `the map's origin${shift}`, 7: 'its own position (no offset)',
    }[m.target];
    const who = m.is_character === 1 ? 'The unit (all its dummy links)' : 'The dummy link using the skill';
    const time = m.duration > 1 ? ` over ${sec(m.duration)}` : ' at once';
    let text;
    const selfStep = m.target === 1 && offs.length === 1 && offTxt(offs[0]);
    const stepLen = selfStep ? (m.distance > 0 ? Math.min(m.distance, Math.hypot(...offs[0])) : Math.hypot(...offs[0])) : 0;
    if (dest === null) text = `${who} stays where it is${time}`;
    else if (selfStep) text = `${who} moves ${num(stepLen)} ${offs[0][1] ? `(${offTxt(offs[0])}${m.distance > 0 ? `, at most ${num(m.distance)}` : ''})` : offs[0][0] > 0 ? 'toward the enemy side' : 'toward the Griffin side'}${time}`;
    else if (dest === undefined) text = `${who} moves (movement ${id}, target type ${m.target})${time}`;
    else if (m.distance > 0) text = `${who} moves ${num(m.distance)} toward ${dest} (no further than that point)${time}`;
    else text = `${who} moves to ${dest}${time}`;
    if (m.cd > 1) text += `; no other movement of that unit can start for ${sec(m.cd)}`;
    if (this._inKnock) { this._knockMove = { len: stepLen, dx: selfStep ? offs[0][0] : 0, id }; return `${text} (movement ${id}).`; }
    const dx = m.target === 1 && offs.length === 1 ? offs[0][0] : 0;
    const dist = m.target === 1 && offs.length === 1 ? (m.distance > 0 ? Math.min(m.distance, Math.hypot(...offs[0])) : Math.hypot(...offs[0])) : undefined;
    this.fact(ctx, 'move', dist, 'self', m.target === 1 ? `moves ${dist !== undefined ? num(dist) + ' ' : ''}${dx > 0 ? 'toward the enemy side' : dx < 0 ? 'toward the Griffin side' : 'sideways'}` : m.target === 2 || m.target === 6 ? 'dashes to its target' : `moves (movement ${id})`);
    return `${text} (movement ${id}).`;
  }

  /** Length and left-right direction of the first self-relative movement in a skill's action, or null. */
  knockMoveOf(group) {
    const a = this.d.t.battle_action_config.get(this.d.skillRow(group, 1)?.action_id);
    for (const id of ids(a?.move_order).map(Number)) {
      const m = this.d.t.battle_movement_info?.get(id);
      const o = list(m?.offset, ';').map((x) => list(x).map(Number)).filter((p) => p.length >= 2);
      if (m?.target === 1 && o.length === 1) { const len = Math.hypot(o[0][0] || 0, o[0][1] || 0); return { len: m.distance > 0 ? Math.min(m.distance, len) : len, dx: o[0][0] || 0, id }; }
    }
    return null;
  }

  /** Geometry quirks the game applies silently. */
  creationQuirks(c, aff, p1, p2, ctx) {
    if (!this.creationHasEffect(c) || aff === 'target') return;
    const half = Number(p2.v) || 0;
    if (c.effect_area === 1 && half && Math.abs(half) < 180) {
      const enemyCaster = this.kind === 'enemy';
      const away = (enemyCaster && aff === 'enemies' && half > 0) || (!enemyCaster && aff === 'enemies' && half < 0);
      const sev = away ? 'bug' : Math.abs(half) <= 15 ? 'warn' : 'info';
      this.addNote({ sev, cat: 'targeting', text: `Creation ${c.id}'s circle has effect_param_2 = ${num(half)}, which the game reads as a sector half-angle: only units within ${num(Math.abs(half))}° of the ${half > 0 ? '+x (rightward)' : '−x (leftward)'} direction from its centre are hit (radius ${p1.html}).${away ? ' That direction points away from the units it is meant to hit.' : Math.abs(half) <= 15 ? ' Such a narrow cone looks like a second radius value put in the angle field.' : ''}` });
    }
    if (STATIONARY.has(c.route_type) && c.effect_area && (String(c.start_type) !== String(c.destination_type) || offText(c.start_offset) !== offText(c.destination_offset))) {
      const pn = (t) => POS_TYPE[t] ?? `node ${t}`;
      this.addNote({ sev: 'warn', cat: 'targeting', text: `Creation ${c.id} does not move (route ${c.route_type}), so its area stays at its start point (${esc(pn(c.start_type))}${offText(c.start_offset)}), not at its destination (${esc(pn(c.destination_type))}${offText(c.destination_offset)}).` });
    }
  }

  hurtNode(id, ctx, depth = 0) {
    const h = this.d.t.battle_hurt_config.get(id);
    if (!h) return this.note('bug', `Hit ${id} is missing from battle_hurt_config.`);
    const r = this.valOf(h.damage_ratio, ctx);
    const parts = [];
    parts.push(`<b>${r.v !== null && r.v !== undefined ? pct(r.v) : r.html} of the user’s damage</b>${this.alt(r, ctx, pct)} (hit ${id})`);
    const flag = (cell, yes, no, f) => { const p = parseVal(cell); if (p && 'formula' in p) return `${f}: ${this.useFormula(p.formula, ctx)}`; return Number(cell) ? yes : no; };
    parts.push(flag(h.is_miss, `can miss (${Number(h.hit_type) === 2 ? 'precise roll: at least 40% chance to hit' : 'normal accuracy roll'})`, 'never misses', 'can miss when'));
    const crit = parseVal(h.is_critical_hit);
    parts.push(crit && 'formula' in crit ? `crit rule: ${this.useFormula(crit.formula, ctx)}` : { 0: 'cannot crit', 1: 'can crit', 2: 'always crits' }[Number(h.is_critical_hit)] ?? `crit ${h.is_critical_hit}`);
    parts.push(flag(h.is_armor, 'reduced by armor', '<b>ignores armor</b>', 'armor applies when'));
    if (h.float_wide) parts.push(`±${h.float_wide}% random spread`);
    const fh = parseVal(h.is_form_hurt);
    parts.push(fh && 'formula' in fh ? `area rule: ${this.useFormula(fh.formula, ctx)}` : Number(h.is_form_hurt) ? 'area hit: hits every dummy link of the target (damage × links left)' : 'single hit (cannot carry past one dummy link)');
    const sh = this.valOf(h.is_shield, ctx); if (sh.v) parts.push(`${num(sh.v)}% goes through HP shields`); else if (sh.formula !== undefined) parts.push(`shield penetration: ${sh.html}`);
    const ric = this.valOf(h.is_ricochet, ctx); if (ric.v) parts.push(`ignores ${num(ric.v)}% of Force Shield`);
    const db = this.valOf(h.defbreak_rate, ctx); const xdb = this.valOf(h.extra_defbreak, ctx);
    if ((db.v && db.v !== 100) || xdb.v) parts.push(`Force Shield break: ${db.html}% of Shield Break${xdb.v ? ` + ${xdb.html}` : ''}`);
    if (h.ui_control === 1) parts.push('number always shown as a crit');
    const sub = [];
    for (const f of list(h.fix_damage)) { const p = parseVal(f); if (p && 'formula' in p) sub.push(`<li>Damage is then recalculated: ${this.useFormula(p.formula, ctx)}</li>`); }
    const rate = this.valOf(h.buff_rate, ctx);
    const cond = { 0: 'when it lands', 1: 'on a critical hit', 2: 'unless armor stopped it', 3: '<b>only when it misses</b>' }[h.hurt_buff_trigger_type] ?? '';
    const chance = rate.v !== null && rate.v !== undefined ? (rate.v < 100 ? ` (${num(rate.v)}% chance${this.alt(rate, ctx, pct).replace(/^ /, ' ')})` : '') : rate.formula !== undefined ? ` (chance ${rate.html}%)` : '';
    for (const [col, who, side] of [['buff_id_target', 'the target', ctx.hitSide ?? 'enemy'], ['buff_id_self', 'the user', 'self'],
      ['range_buff_target', 'the targets (once per attack)', ctx.hitSide ?? 'enemy'], ['range_buff_self', 'the user (once per attack)', 'self']]) {
      for (const b of parseBuffList(h[col])) sub.push(`<li>${cap(cond)}${chance}: ${this.applyBuff(b, who, ctx, '', depth, '', side)}</li>`);
    }
    // target_skill fires with chance beat_back_percent × 0.01, only on targets that can be knocked back
    // [CSkillInstance._GenHurt -> GameData.GetProb, BattleCharacterData.CanHitBack].
    if (h.target_skill && Number(h.beat_back_percent)) {
      const ts = this.d.skillRow(Number(h.target_skill), 1);
      const isKnock = /击退/.test(ts ? this.d.text(ts.name) : '') || !!this.d.t.battle_action_config.get(ts?.action_id)?.move_order;
      // The target uses the skill, so any movement in it moves the target.
      this._inKnock = true; this._knockMove = null;
      let child;
      try { child = this.childSkill(Number(h.target_skill), '', depth, false, true); } finally { this._inKnock = false; }
      const km = this._knockMove ?? this.knockMoveOf(Number(h.target_skill));
      const how = km?.len ? ` ${num(km.len)} ${km.dx > 0 ? 'toward the enemy side' : km.dx < 0 ? 'toward the Griffin side' : ''}`.trimEnd() : '';
      this.fact(ctx, isKnock ? 'knockback' : 'forcedskill', Number(h.beat_back_percent), ctx.hitSide ?? 'enemy', `${esc(h.beat_back_percent)}% chance per hit to ${isKnock ? `knock the target back${how}` : `make the target use skill ${h.target_skill}`} (hit ${id})`, { hurt: id }, { knockLen: km?.len, knockDx: km?.dx });
      sub.push(`<li>${esc(h.beat_back_percent)}% chance the target is made to use ${child}</li>`);
    }
    // A damage formula that only depends on stack counts is recorded with its highest value and its range.
    const rg = r.formula !== undefined ? this.formulaRange(r.formula, ctx) : null;
    const dmg = r.v ?? rg?.hi ?? null;
    if (dmg !== null && dmg > 0 && dmg < 99999) this.fact(ctx, 'damage', dmg, ctx.hitSide ?? 'enemy', `a hit for ${rg ? `${pct(rg.lo)}–${pct(rg.hi)}` : pct(dmg)} of the user's damage (hit ${id})`, { hurt: id }, { lo: rg?.lo, area: ctx.area ?? '', every: ctx.every ?? 0, life: ctx.life ?? 0, ignoresArmor: Number(h.is_armor) === 0 && !(parseVal(h.is_armor) && 'formula' in parseVal(h.is_armor)), perLink: Number(h.is_form_hurt) === 1 });
    if (Number(h.is_armor) === 0 && !(parseVal(h.is_armor) && 'formula' in parseVal(h.is_armor))) this.fact(ctx, 'ignorearmor', undefined, ctx.hitSide ?? 'enemy', `hit ${id} ignores armor`, { hurt: id });
    return `${parts.join(', ')}${sub.length ? `<ul>${sub.join('')}</ul>` : ''}`;
  }

  childSkill(group, intro, depth, fromBuff = false, inline = false, force = null) {
    const owned = this.owned.has(group);
    let level = owned ? this.owned.get(group) : 1;
    if (force) level = force.level;
    const row = this.d.skillRow(group, level);
    if (!row) return `<li>${intro}: ${this.note('bug', `Skill ${group} is missing.`)}</li>`;
    let why;
    if (force) why = force.why;
    else if (fromBuff) why = 'Skills granted by a buff are always level 1 [BattleConditionList.Add].';
    else if (owned) why = `The doll owns this skill, so its own level (${level}) is used.`;
    else why = 'Not one of the doll’s own skills, so it runs at level 1 [BattleCharacterData.ForceCastSkill].';
    if (level === 1 && !owned && !(force && force.noCheck)) this.checkScales(group, why);
    if (fromBuff && owned && this.owned.get(group) !== 1) this.checkScales(group, why);
    const body = this.skillNode(row, { via: intro, levelWhy: why, depth: depth + 1 });
    return inline ? body : `<li>${body}</li>`;
  }

  /** Flag a skill that is forced to level 1 while its higher levels have different numbers. */
  checkScales(group, why) {
    const lv = this.d.skillLevels(group);
    if (lv.length < 2) return;
    const a = this.d.skillRow(group, lv[0]); const b = this.d.skillRow(group, lv[lv.length - 1]);
    if (['data_pool_1', 'data_pool_2', 'cd_time'].some((k) => String(a[k]) !== String(b[k]))) {
      this.note('bug', `Skill ${group} has level-dependent values (L1 → L${lv[lv.length - 1]} differ), but it is only ever used at level 1 here. ${why}`);
    }
  }

  watchNode(id, ctx, depth) {
    const w = this.d.t.battle_watch.get(id);
    if (!w) return `<li>${this.note('bug', `Watcher ${id} is missing from battle_watch.`)}</li>`;
    const bits = [`Watcher ${id}: whenever ${WATCH_EVENT[w.watch_trigger_type] ?? 'event ' + w.watch_trigger_type}`];
    const wt = this.d.t.battle_watch_trigger.get(w.activation_watch_trigger);
    if (wt) {
      const c = [];
      if (wt.buff_judge) c.push(`the buff change satisfies ${this.useFormula(Number(wt.buff_judge) - FORMULA, ctx)}`);
      if (String(wt.hurt_type) !== '0' && list(wt.hurt_type).length) c.push(`the hit result is ${list(wt.hurt_type).map((x) => ({ 0: 'ordinary', 1: 'stopped by armor', 2: 'armor pierced', 3: 'armor pierced and critical' }[x] ?? x)).join('/')}`);
      if (wt.is_hurt_body) c.push('the damage reaches HP');
      if (wt.hurt_judge && Number(wt.hurt_judge) !== 1) c.push(`${this.valOf(wt.hurt_judge, ctx).html}`);
      if (wt.watched_skill_type) c.push(`the skill is of type ${wt.watched_skill_type}`);
      if (wt.watched_skill_group_id) c.push(`the skill is ${this.skillRef(wt.watched_skill_group_id)}`);
      if (list(wt.hurt_from).some((x) => x !== '0')) c.push(`the damage source is ${esc(wt.hurt_from)}`);
      if (c.length) bits.push(`and ${c.join(' and ')}`);
    }
    const sp = this.triggerList(w.watch_sp_trigger, ctx);
    if (sp.length) bits.push(`while ${sp.join(' and ')}`);
    bits.push(w.max_times === 1 ? '(only once)' : '');
    const skills = list(w.activation_skills).map(Number).filter(Boolean);
    const tgt = list(w.sp_skill_target).map(Number);
    const sub = skills.map((s, i) => this.childSkill(s, `Cast by watcher ${id}${tgt[i] === 1 ? ', aimed at the watched unit' : tgt[i] === 2 ? ', aimed at the other unit in the event' : ''}`, depth));
    let tail = '';
    if (w.if_delete_buff) tail = ' When the watcher ends, the buff that carries it is removed.';
    return `<li>${bits.filter(Boolean).join(' ')}, the unit casts:${tail}<ul>${sub.join('')}</ul></li>`;
  }

  summonNode(id, ctx, depth) {
    const s = this.d.t.summoner.get(id);
    if (!s) return this.note('bug', `Summon ${id} is missing from summoner.`);
    const key = `m:${id}`;
    if (this.expanded.has(key)) return `summons <a href="#m-${id}">summon ${id}</a> again`;
    this.expanded.add(key);
    this.fact(ctx, 'summon', undefined, s.camp === 2 ? 'enemy' : 'ally', `summons ${esc(this.d.label(s.name) || s.name)} (summon ${id})`);
    const st = [];
    for (const [k, l] of [['hp', 'HP'], ['pow', 'FP'], ['hit', 'ACC'], ['dodge', 'EVA'], ['rate', 'RoF'], ['armor', 'Armor'], ['crit_hit', 'Crit'], ['range', 'Range'], ['number', 'links']]) {
      if (s[k] !== undefined && String(s[k]).trim() !== '' && String(s[k]) !== '0') st.push(`${l} ${this.valOf(s[k], ctx).html}`);
    }
    const sub = [];
    // Summons get the summoner's skill 1-3 levels copied into placeholder slots [SummonGun.InitChildSummonerBattleSkills],
    // so their dynamic passives follow skill_lv_call like the doll's own; normal attack and passives are level 1 [Gun.InitSkills].
    for (const f of ['normal_attack', 'passive_skill', 'dynamic_passive_skill']) {
      for (const sk of ids(s[f]).map(Number)) {
        let force = { level: 1, why: `The summon’s ${f === 'normal_attack' ? 'normal attack' : 'passive skills'} run at level 1 [Gun.InitSkills].`, noCheck: f === 'normal_attack' };
        if (f === 'dynamic_passive_skill') {
          const call = this.d.skillRow(sk, 1)?.skill_lv_call ?? 0;
          const lv = call === 1 ? this.levels.skill1 : call === 2 ? this.levels.skill2 : 1;
          force = { level: lv, why: call === 1 || call === 2 ? `Follows the summoner’s Skill ${call} level (the summon copies the summoner’s skill levels) [SummonGun.InitChildSummonerBattleSkills].` : 'Always level 1 (skill_lv_call 0).', noCheck: call === 1 || call === 2 };
        }
        sub.push(this.childSkill(sk, `Summon’s ${f.replace(/_/g, ' ')}`, depth, false, false, force));
      }
    }
    return `<span id="m-${id}">Summons <b>${this.d.nameHtml(s.name)}</b> (summon ${id}; ${s.camp === 2 ? 'fights for the other side' : 'fights for the user’s side'}${s.is_stay ? ', does not move' : ''}). Stats: ${st.join(', ')}.</span>${sub.length ? `<ul>${sub.join('')}</ul>` : ''}`;
  }

  // ---------------------------------------------------------- doll-wide quirks

  skillQuirks(row, desc, ctx) {
    const out = [];
    if (!desc || this.noDescCheck?.has(row.skill_group_id)) return out;
    const facts = this.numbersOf(row).concat(this.kitFacts ?? []);
    // Numbers that are part of the doll's or the skill's name ("Type 64", "64 Shiki") are not values.
    const nameNums = new Set([this.d.unitName(this.kind, this.g), this.d.text(row.name), this.g.en_name].join(' ').match(/\d+(\.\d+)?/g) ?? []);
    const said = extractNumbers(desc).filter((n) => !nameNums.has(String(n)));
    const miss = said.filter((n) => !facts.some((f) => Math.abs(f - n) < 0.051));
    if (false && miss.length) this.untraced.push(`${esc(this.d.text(row.name) || 'Skill ' + row.skill_group_id)} (level ${row.level}): ${miss.map((x) => num(x)).join(', ')}`);
    return out;
  }

  /** Every number a description could fairly mention for this skill, derived from its data. */
  numbersOf(row, seen = new Set()) {
    const out = [];
    const add = (v) => { if (typeof v === 'number' && Number.isFinite(v)) out.push(v, Math.abs(v)); };
    const addFrames = (v) => { if (typeof v === 'number') { add(v / FPS); add(v); } };
    const addPct = (v) => { if (typeof v === 'number') { add(v); add(v - 100); add(100 - v); add(v / 100); add((v - 100) / 100); } };
    const visitSkill = (r) => {
      if (!r || seen.has('s' + r.id)) return; seen.add('s' + r.id);
      curRow = r;
      for (const col of ['data_pool_1', 'data_pool_2', 'night_data_pool_1', 'night_data_pool_2', 'sp_data_pool_1', 'sp_data_pool_2']) {
        for (const x of list(r[col])) { const n = Number(x); if (!Number.isNaN(n)) { addPct(n); addFrames(n); } else if (x.startsWith('*')) visitFormula(Number(x.slice(1))); }
      }
      addFrames(Number(r.cd_time)); addFrames(Number(r.start_cd_time)); addFrames(Number(r.skill_duration));
      for (const t of list(r.trigger_id)) visitTrigger(Number(t));
      for (const t of list(r.sppool_trigger_id)) visitTrigger(Number(t));
      for (const b of [...parseBuffList(r.buff_id_target), ...parseBuffList(r.buff_id_self)]) { visitBuff(b.id); if (b.stacks?.num) add(Math.abs(b.stacks.num)); }
      const a = this.d.t.battle_action_config.get(r.action_id);
      if (a) { for (const c of list(a.creation_order)) visitCreation(Number(c)); for (const s of list(a.summon_order)) visitSummon(Number(s)); for (const x of list(a.stop_time_duration)) addFrames(Number(x)); }
      const ai = this.d.t.battle_target_select_ai.get(r.target_select_ai);
      if (ai) { add(ai.target_number); add(ai.target_parameter); }
      if (r.cd_type >= FORMULA) { const c = this.d.t.battle_skill_type_config.get(r.cd_type - FORMULA); if (c) { add(c.charge_tier); addFrames(c.charge_time); } }
    };
    const visitTrigger = (id) => { const t = this.d.t.battle_trigger.get(id); if (!t) return; for (const x of list(t.parameter)) add(Number(x)); if (t.type === 18) visitFormula(Number(t.parameter)); };
    const visitFormula = (id) => {
      if (seen.has('f' + id)) return; seen.add('f' + id);
      const f = this.d.formula(id); if (!f) return;
      for (const m of String(f).match(/\d+(\.\d+)?/g) ?? []) { addPct(Number(m)); addFrames(Number(m)); }
      const rg = this.formulaRange(id, { row: curRow });
      if (rg) for (const v of rg.values) { addPct(v); addFrames(v); }
    };
    let curRow = row;
    const visitBuff = (id) => {
      const b = this.d.t.battle_buff.get(id); if (!b || seen.has('b' + id)) return; seen.add('b' + id);
      for (const col of new Set(Object.values(BUFF_COL).concat(['parameter_value']))) { const n = Number(b[col]); if (b[col] !== '' && !Number.isNaN(n) && n) addPct(n); }
      const d = Number(b.duration); if (!Number.isNaN(d)) addFrames(d);
      add(b.max_tier);
      for (const s of list(b.forced_skill).map(Number).filter((x) => x > 0)) visitSkill(this.d.skillRow(s, 1));
      if (b.watch_id) { const w = this.d.t.battle_watch.get(b.watch_id); if (w) for (const s of list(w.activation_skills).map(Number)) visitSkill(this.d.skillRow(s, this.owned.get(s) ?? 1)); }
      if (b.orb_effect) visitSkill(this.d.skillRow(Number(b.orb_effect), 1));
      if (b.hurt_id) visitHurt(b.hurt_id); addFrames(Number(b.hurt_cd));
      for (const c of list(b.trigger_creation_id)) visitCreation(Number(c));
    };
    const visitCreation = (id) => {
      const c = this.d.t.battle_creation.get(id); if (!c || seen.has('c' + id)) return; seen.add('c' + id);
      for (const k of ['effect_param_1', 'effect_param_2']) for (const x of list(c[k])) add(Number(x));
      addFrames(Number(c.exist_duration));
      for (const h of list(c.hurt_id)) visitHurt(Number(h));
      for (const x of list(c.hurt_cd)) addFrames(Number(x));
      for (const x of list(c.buff_cd)) addFrames(Number(x));
      for (const b of parseBuffList(c.buff_id)) visitBuff(b.id);
      for (const x of list(c.trigger_creation_id)) visitCreation(Number(x));
      for (const x of list(c.trigger_creation_delay)) addFrames(Number(x));
      for (const s of list(c.summoner_order)) visitSummon(Number(s));
      add(c.active_times);
    };
    const visitHurt = (id) => {
      const h = this.d.t.battle_hurt_config.get(id); if (!h || seen.has('h' + id)) return; seen.add('h' + id);
      for (const k of ['damage_ratio', 'buff_rate', 'beat_back_percent', 'is_ricochet', 'is_shield', 'defbreak_rate', 'extra_defbreak']) { const n = Number(h[k]); if (!Number.isNaN(n)) addPct(n); }
      for (const f of list(h.fix_damage)) { const p = parseVal(f); if (p?.formula) visitFormula(p.formula); }
      for (const b of [...parseBuffList(h.buff_id_target), ...parseBuffList(h.buff_id_self), ...parseBuffList(h.range_buff_target), ...parseBuffList(h.range_buff_self)]) visitBuff(b.id);
      if (h.target_skill) visitSkill(this.d.skillRow(Number(h.target_skill), 1));
    };
    const visitSummon = (id) => {
      const s = this.d.t.summoner.get(id); if (!s || seen.has('m' + id)) return; seen.add('m' + id);
      for (const k of ['hp', 'pow', 'hit', 'dodge', 'rate', 'armor', 'crit_hit', 'range', 'number', 'phase_duration']) { const n = Number(s[k]); if (!Number.isNaN(n)) { add(n); addFrames(n); } else { const p = parseVal(s[k]); if (p?.formula) visitFormula(p.formula); } }
      for (const f of ['normal_attack', 'passive_skill', 'dynamic_passive_skill']) for (const sk of list(s[f]).map(Number)) visitSkill(this.d.skillRow(sk, 1));
    };
    visitSkill(row);
    // Pool values of the skill scaled by stacks of its own buffs (e.g. "up to 3 stacks of 10%" = 30%)
    return out;
  }

  checkLevelBugs(entries) {
    for (const e of entries) {
      if (e.field !== 'passive_skill') continue;
      const lv = this.d.skillLevels(e.group);
      if (lv.length < 2) continue;
      const a = this.d.skillRow(e.group, lv[0]); const b = this.d.skillRow(e.group, lv[lv.length - 1]);
      if (['data_pool_1', 'data_pool_2', 'cd_time'].some((k) => String(a[k]) !== String(b[k]))) {
        this.note('warn', `Passive ${e.group} has ${lv.length} levels with different values, but passive skills always run at level 1, so only its level 1 values are ever used here.`);
      }
    }
  }

  missionBonusTable(items) {
    const rows = items.map(({ e, row }) => {
      const missions = [];
      for (const t of list(row.trigger_id)) { const tr = this.d.t.battle_trigger.get(Number(t)); if (tr) missions.push(...list(tr.parameter).map(Number)); }
      const ctx = { row };
      const eff = parseBuffList(row.buff_id_self).map((b) => {
        const buff = this.d.t.battle_buff.get(b.id);
        return buff ? this.buffEffect(buff, ctx).replace(/ — multiplies.*$/, '') : `buff ${b.id}`;
      }).join('; ');
      const names = missions.map((m) => this.d.missionName(m) || m);
      return `<tr><td>${row.skill_group_id}</td><td>${eff}</td><td>${missions.length}</td><td class="missions">${esc(names.join(', '))}</td></tr>`;
    });
    return `<table class="mission-table"><thead><tr><th>Skill</th><th>Bonus to this doll</th><th>Missions</th><th>Where</th></tr></thead><tbody>${rows.join('')}</tbody></table>`;
  }

  markersHtml() {
    const rows = [];
    for (const [id, m] of [...this.markers].sort((a, b) => a[0] - b[0])) {
      const b = this.d.t.battle_buff.get(id);
      if (!b || !MARKER_TYPES.has(b.type) && b.type !== 401) continue;
      const f = (s) => [...s].map((g) => this.skillRef(g)).join(', ') || '—';
      rows.push(`<tr id="b-${id}"><td>${id}</td><td>${this.d.nameHtml(b.name)}</td><td>${b.max_tier}</td><td>${f(m.setBy)}</td><td>${f(m.removedBy)}</td><td>${f(m.checkedBy)}</td></tr>`);
    }
    if (!rows.length) return '';
    return `<table class="markers"><thead><tr><th>Buff</th><th>Name</th><th>Max stacks</th><th>Added by</th><th>Removed by</th><th>Checked by</th></tr></thead><tbody>${rows.join('')}</tbody></table>`;
  }

  formulasHtml() {
    const rows = [];
    for (const [id, f] of [...this.formulas].sort((a, b) => a[0] - b[0])) {
      rows.push(`<tr id="f-${id}"><td>${id}</td><td><code>${esc(this.d.rawFormula(id) ?? '(missing)')}</code></td><td>${f.text ? this.formulaEnglish(f.text, null) : ''}</td></tr>`);
    }
    if (!rows.length) return '';
    return `<table class="formulas"><thead><tr><th>Formula</th><th>As written</th><th>Reads as</th></tr></thead><tbody>${rows.join('')}</tbody></table>`;
  }
}

function section(title, lines) {
  const items = lines.filter((x) => x && String(x).trim());
  if (!items.length) return '';
  return `<div class="sect"><div class="sect-t">${title}</div><ul>${items.map((x) => `<li>${x}</li>`).join('')}</ul></div>`;
}
const cap = (s) => (s ? s[0].toUpperCase() + s.slice(1) : s);

/** " shifted …" for a creation offset "x,y,z" (y is height; z is the map's up-down axis). No mirroring by side. */
function offText(cell) {
  const p = list(cell).map(Number);
  const x = p[0] || 0, z = p[2] || 0;
  const bits = [];
  if (x) bits.push(`${num(Math.abs(x))} ${x > 0 ? 'toward the enemy side' : 'toward the Griffin side'}`);
  if (z) bits.push(`${num(Math.abs(z))} ${z > 0 ? 'up' : 'down'} the map`);
  return bits.length ? ` shifted ${bits.join(' and ')}` : '';
}

/** Numbers a skill description states (percentages, seconds, plain counts). */
export function extractNumbers(text) {
  const out = [];
  const t = String(text).replace(/\{[^}]*\}/g, ' ');
  // Skip numbers that belong to a name or calibre (AK-74U, M91/38, 7.62mm, G11): touching a letter, '-' or '/'.
  // "3x" and "5s" are kept: x and s are units.
  for (const m of t.matchAll(/(?<![A-Za-z\-\/.\d])(\d+(?:\.\d+)?)(?![\d.]|[A-WYZa-rt-wyz\-\/]|[sx][A-Za-z])/g)) {
    const n = Number(m[1]);
    if (Number.isNaN(n)) continue;
    out.push(n);
  }
  return [...new Set(out)];
}
