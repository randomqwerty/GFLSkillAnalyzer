// Bug and quirk detectors for one unit's kit (doll, enemy or Coalition unit). Called by analyzeDoll (analyzer.js); returns notes
// { sev: 'bug' | 'warn' | 'info', cat, text } that the page shows under "Quirks found".
//
// Everything here works on the raw tables, independently of the page text, so that each check
// looks at every level of every skill the unit can run, not only the levels being displayed.
import {
  esc, list, ids, num, parseVal, parseBuffList, FORMULA, FPS, BUFF_COL, PCT_STAT, FLAT_STAT, MARKER_TYPES,
  buffTypeName, parseFormula, evalFormula,
} from './analyzer.js';

export { Checker as __Checker };
export const CATEGORIES = {
  levels: 'Skill levels', desc: 'Description vs data', values: 'Buff values', stacking: 'Stacking',
  targeting: 'Targeting', triggers: 'Triggers', priority: 'Skill order', formulas: 'Formulas', data: 'Missing data',
  hidden: 'Hidden effects',
};

const isNum = (s) => s !== '' && s !== null && s !== undefined && !Number.isNaN(Number(s));

export function runChecks(d, g, entries, levels, opts = {}) {
  const C = new Checker(d, g, entries, levels, opts);
  C.run();
  return { notes: C.notes, untraced: C.untraced };
}

class Checker {
  constructor(d, g, entries, levels, opts = {}) {
    this.d = d; this.g = g; this.entries = entries; this.levels = levels;
    this.kind = opts.kind ?? 'gun'; this.mag = opts.mag ?? (Number(g.special) || 0);
    this.notes = [];
    this.kit = new Map();      // group -> { group, level, label, all: bool (levels follow training) }
    this.applies = [];         // { buff, stacks, side, via, viaLevel }
    this.removes = [];
    this.checks = [];          // { buff, isType, kind: 'has'|'not'|'formula', n, subject, via, how }
    this.formulas = [];        // { id, via, use, isCondition }
    this.links = [];           // [parent group, child group]: skills started by another skill
    this.untraced = [];        // description numbers found nowhere in the related data
  }

  note(sev, cat, text) {
    if (!this.notes.some((n) => n.text === text)) this.notes.push({ sev, cat, text });
  }
  skillName(group) {
    const r = this.d.skillRow(group, 1);
    const n = r ? this.d.text(r.name) : '';
    const en = n && /[㐀-鿿]/.test(n) ? (this.d.label(n) || n) : n;
    return `skill ${group}${en ? ` «${esc(en)}»` : ''}`;
  }
  buffName(id) {
    const b = this.d.t.battle_buff.get(id);
    if (!b) return `buff ${id}`;
    const en = this.d.label(b.name);
    return `buff ${id} «${esc(en || b.name)}»`;
  }

  // ------------------------------------------------------------------ kit

  run() {
    for (const e of this.entries) this.addKit(e.group, e.level, e.label, e.trained ?? (e.field === 'skill1' || e.field === 'skill2' || (e.field === 'dynamic_passive_skill' && [1, 2].includes(this.d.skillRow(e.group, 1)?.skill_lv_call))));
    // Walk effects of every kit skill at the level it runs at (the kit grows while walking).
    for (const k of this.kit.values()) { k.walked = true; this.walkSkill(this.d.skillRow(k.group, k.level), k); }
    this.checkLevels();
    this.checkDescriptions();
    this.checkBuffValues();
    this.checkStacking();
    this.checkTriggersAndTargets();
    this.checkPriority();
    this.checkFormulas();
    this.checkBossMarkers();
  }

  addKit(group, level, label, followsTraining = false) {
    if (!group || this.kit.has(group)) return;
    if (!this.d.skills.has(group)) { this.note('bug', 'data', `${esc(label)} refers to skill ${group}, which does not exist.`); return; }
    this.kit.set(group, { group, level, label, followsTraining });
  }

  sideOfTarget(row) {
    const a = this.d.t.battle_target_select_ai.get(row.target_select_ai);
    if (!a) return 'ally';
    return a.target_type === 1 ? 'enemy' : a.target_type === 4 ? 'self' : 'ally';
  }

  /** Collect what a skill row applies, removes and checks; queue child skills into the kit. */
  walkSkill(row, k, seen = new Set()) {
    if (!row || seen.has('s' + row.id)) return;
    seen.add('s' + row.id);
    const via = row.skill_group_id;
    for (const t of ids(row.trigger_id)) this.walkTrigger(Number(t), via, 'its trigger');
    for (const t of ids(row.sppool_trigger_id)) this.walkTrigger(Number(t), via, 'its special-pool trigger');
    this.walkTarget(row.target_select_ai, via);
    const side = this.sideOfTarget(row);
    this.walkBuffList(row.buff_id_target, side, via, seen);
    this.walkBuffList(row.buff_id_self, 'self', via, seen);
    for (const col of ['data_pool_1', 'data_pool_2', 'night_data_pool_1', 'night_data_pool_2', 'sp_data_pool_1', 'sp_data_pool_2']) {
      for (const x of list(row[col])) if (x.startsWith('*')) this.useFormula(Number(x.slice(1)), via, 'a data pool value');
    }
    const a = this.d.t.battle_action_config.get(row.action_id);
    if (a) for (const c of ids(a.creation_order)) this.walkCreation(Number(c), via, seen);
    if (a) for (const s of ids(a.summon_order)) this.walkSummon(Number(s), via, seen);
  }

  walkBuffList(cell, side, via, seen) {
    for (const b of parseBuffList(cell)) {
      if (b.idFormula !== null) { this.useFormula(b.idFormula, via, 'the choice of buff'); continue; }
      const n = b.stacks && 'num' in b.stacks ? b.stacks.num : null;
      if (b.stacks && 'formula' in b.stacks) this.useFormula(b.stacks.formula, via, 'a stack count');
      if (n !== null && n < 0) this.removes.push({ buff: b.id, n: -n, via });
      else this.applies.push({ buff: b.id, stacks: n, side, via });
      this.walkBuff(b.id, via, seen);
    }
  }

  walkBuff(id, via, seen) {
    if (seen.has('b' + id)) return;
    seen.add('b' + id);
    const b = this.d.t.battle_buff.get(id);
    if (!b) { this.note('bug', 'data', `${this.skillName(via)} applies buff ${id}, which does not exist, so nothing is applied.`); return; }
    for (const s of ids(b.forced_skill).map(Number)) { this.addKit(s, 1, `buff ${id}`); this.links.push([via, s]); }
    if (b.watch_id) {
      const w = this.d.t.battle_watch.get(b.watch_id);
      if (!w) this.note('bug', 'data', `${this.buffName(id)} attaches watcher ${b.watch_id}, which does not exist.`);
      else {
        for (const t of ids(w.watch_sp_trigger)) this.walkTrigger(Number(t), via, `watcher ${w.id}`);
        for (const s of ids(w.activation_skills).map(Number)) { this.addKit(s, 1, `watcher ${w.id}`); this.links.push([via, s]); }
      }
    }
    if (b.orb_effect && Number(b.orb_effect)) { this.addKit(Number(b.orb_effect), 1, `buff ${id}`); this.links.push([via, Number(b.orb_effect)]); }
    for (const c of ids(b.trigger_creation_id)) if (isNum(c)) this.walkCreation(Number(c), via, seen);
    for (const col of new Set([...Object.values(BUFF_COL), 'parameter_value', 'duration', 'fix_damage'])) {
      const p = parseVal(b[col]); if (p && 'formula' in p) this.useFormula(p.formula, via, `${this.buffName(id)}'s value`);
    }
  }

  walkCreation(id, via, seen) {
    if (seen.has('c' + id)) return;
    seen.add('c' + id);
    const c = this.d.t.battle_creation.get(id);
    if (!c) { this.note('bug', 'data', `${this.skillName(via)} creates object ${id}, which does not exist, so it is never created.`); return; }
    const side = c.effect_type === 1 ? 'ally' : 'enemy';
    for (const h of ids(c.hurt_id)) this.walkHurt(Number(h), side, via, seen, id);
    this.walkBuffList(c.buff_id, side, via, seen);
    for (const x of ids(c.trigger_creation_id)) if (isNum(x)) this.walkCreation(Number(x), via, seen);
    for (const s of ids(c.summoner_order)) this.walkSummon(Number(s), via, seen);
  }

  walkHurt(id, side, via, seen, creation) {
    const h = this.d.t.battle_hurt_config.get(id);
    if (!h) { this.note('bug', 'data', `${this.skillName(via)} uses hit ${id}, which does not exist.`); return; }
    if (side === 'ally') {
      const r = parseVal(h.damage_ratio);
      if (r && ('pool' in r || ('num' in r && r.num > 0))) this.note('warn', 'targeting', `${this.skillName(via)}: object ${creation} affects <b>allies</b> but carries hit ${id} with ${esc(h.damage_ratio)}% damage, so it would damage friendly units.`);
    }
    for (const f of list(h.fix_damage)) { const p = parseVal(f); if (p?.formula) this.useFormula(p.formula, via, `hit ${id}'s damage`); }
    for (const k of ['is_miss', 'is_critical_hit', 'is_armor', 'is_shield', 'is_form_hurt']) { const p = parseVal(h[k]); if (p?.formula) this.useFormula(p.formula, via, `hit ${id}`); }
    if (seen.has('h' + id)) return;
    seen.add('h' + id);
    this.walkBuffList(h.buff_id_target, side, via, seen);
    this.walkBuffList(h.range_buff_target, side, via, seen);
    this.walkBuffList(h.buff_id_self, 'self', via, seen);
    this.walkBuffList(h.range_buff_self, 'self', via, seen);
  }

  walkSummon(id, via, seen) {
    if (seen.has('m' + id)) return;
    seen.add('m' + id);
    const s = this.d.t.summoner.get(id);
    if (!s) { this.note('bug', 'data', `${this.skillName(via)} summons unit ${id}, which does not exist.`); return; }
    for (const k of ['hp', 'pow', 'hit', 'dodge', 'rate', 'armor', 'crit_hit', 'range', 'number', 'angle']) { const p = parseVal(s[k]); if (p?.formula) this.useFormula(p.formula, via, `the summon's ${k}`); }
    for (const f of ['normal_attack', 'passive_skill', 'dynamic_passive_skill']) {
      for (const sk of ids(s[f]).map(Number)) {
        const call = this.d.skillRow(sk, 1)?.skill_lv_call ?? 0;
        const lv = f === 'dynamic_passive_skill' ? (call === 1 ? this.levels.skill1 : call === 2 ? this.levels.skill2 : 1) : 1;
        this.addKit(sk, lv, `summon ${id}`, f === 'dynamic_passive_skill' && (call === 1 || call === 2));
        this.links.push([via, sk]);
      }
    }
  }

  walkTrigger(id, via, how) {
    const t = this.d.t.battle_trigger.get(id);
    if (!t) { this.note('bug', 'data', `${this.skillName(via)} uses trigger ${id} (${how}), which does not exist.`); return; }
    const subject = { 0: 'self', 1: 'self', 2: 'target', 3: 'ally', 4: 'enemy' }[t.target] ?? 'self';
    if (t.type === 6 || t.type === 7) this.checks.push({ buff: t.buff_id, isType: !!t.is_buff_type, kind: t.type === 6 ? 'has' : 'not', n: Number(t.parameter) || 1, subject, via, how, trigger: id });
    if (t.type === 18) this.useFormula(Number(t.parameter) >= FORMULA ? Number(t.parameter) - FORMULA : Number(t.parameter), via, how, true);
  }

  walkTarget(aiId, via) {
    const a = this.d.t.battle_target_select_ai.get(aiId);
    if (!a) { if (aiId) this.note('bug', 'data', `${this.skillName(via)} uses target rule ${aiId}, which does not exist.`); return; }
    const subject = a.target_type === 1 ? 'enemy' : 'ally';
    if ((a.buff_trigger_type === 6 || a.buff_trigger_type === 7) && a.target_buff_id) {
      this.checks.push({ buff: a.target_buff_id, isType: !!a.is_buff_type, kind: a.buff_trigger_type === 6 ? 'has' : 'not', n: a.target_parameter || 1, subject, via, how: `its target filter (rule ${a.id})`, filter: a.id });
    }
    if (a.buff_trigger_type === 18) this.useFormula(a.target_parameter >= FORMULA ? a.target_parameter - FORMULA : a.target_parameter, via, `its target filter (rule ${a.id})`, true);
    for (const k of list(a.select_order).map(Number)) if (k >= FORMULA) this.useFormula(k - FORMULA, via, `its target ordering (rule ${a.id})`);
  }

  useFormula(id, via, use, isCondition = false) {
    if (!id) return;
    this.formulas.push({ id, via, use, isCondition });
    const text = this.d.formula(id);
    if (text === null) return;
    for (const m of text.matchAll(/([st])buffidtier\((\d+)\)/g)) {
      this.checks.push({ buff: Number(m[2]), isType: false, kind: 'formula', n: null, subject: m[1] === 's' ? 'self' : 'target', via, how: `formula ${id}`, formula: id });
    }
  }
}

// ====================================================================== per-level fingerprint
//
// A flat list of { p (path), k: 's' structure | 'n' number, v, label } describing one level of a
// skill and everything it creates, hits and buffs. Ids are left out of the structure so that
// per-level copies (buff 8934 at level 2, 8935 at level 3...) compare equal; their numbers go
// into 'n' entries so their trend across levels can be checked.

const POOL_LABEL = { data_pool_1: 'pool 1', data_pool_2: 'pool 2', night_data_pool_1: 'night pool 1', night_data_pool_2: 'night pool 2', sp_data_pool_1: 'special pool 1', sp_data_pool_2: 'special pool 2' };
const valKind = (s) => { const p = parseVal(s); if (!p) return 'none'; if ('pool' in p) return `*${p.pool}`; if ('formula' in p) return 'formula'; if ('num' in p) return 'num'; return 'str'; };
/** Describe a formula by what it reads and by its values at sample stack counts (texts differ even when results agree). */
function formulaSample(d, id, q, l, S, N) {
  const text = d.formula(id);
  if (text === null) { S(q + '.f', l + ' formula', 'missing'); return; }
  let tree; try { tree = parseFormula(text); } catch { S(q + '.reads', l + ' formula reads', 'MALFORMED (formula ' + id + ')'); return; }
  const names = new Set(); const tiers = new Set();
  const walk = (t) => { if (!t) return; if (t.n === 'var') names.add(t.side + t.v); if (t.n === 'dyn') names.add('$' + t.v); if (t.n === 'fn') { names.add(t.v); if (/buffidtier$/.test(t.v) && t.args[0]?.n === 'num') tiers.add(t.v[0] + t.args[0].v); } for (const k of ['a', 'b', 'c']) walk(t[k]); for (const a of t.args ?? []) walk(a); };
  walk(tree);
  S(q + '.reads', l + ' formula reads', [...names].sort().join(','));
  const samples = [0, 1, 2, 3, 5, 10];
  samples.forEach((n, i) => {
    const v = evalFormula(tree, (t) => (t.n === 'fn' ? n : t.n === 'var' || t.n === 'dyn' ? 100 : undefined));
    if (typeof v === 'number' || typeof v === 'boolean') N(`${q}.s${i}`, `${l} formula value with ${n} stack${n === 1 ? '' : 's'}`, Number(v));
  });
}
const formulaConsts = (t) => (String(t ?? '').match(/\d+(\.\d+)?/g) ?? []).map(Number);
const monotonic = (v) => v.every((x, i) => i === 0 || x >= v[i - 1]) || v.every((x, i) => i === 0 || x <= v[i - 1]);
function rangeText(ls) {
  const s = [...ls].sort((a, b) => a - b); const out = [];
  for (let i = 0; i < s.length; i++) { let j = i; while (j + 1 < s.length && s[j + 1] === s[j] + 1) j++; out.push(j > i ? `${s[i]}–${s[j]}` : `${s[i]}`); i = j; }
  return out.join(', ');
}

Object.assign(Checker.prototype, {
  fingerprint(row) {
    const out = [];
    const S = (p, label, v) => out.push({ p, k: 's', v: String(v), label });
    const N = (p, label, v) => { if (isNum(v)) out.push({ p, k: 'n', v: Number(v), label }); };
    const seen = new Set();
    const d = this.d;
    const skill = (r, p, L, depth) => {
      if (!r || depth > 4) return;
      S(`${p}.type`, `${L}skill type`, r.type); S(`${p}.cdr`, `${L}affected by CDR`, r.is_cdr);
      if (r.cd_type >= FORMULA) {
        // Charge skills often point to one charge config per level: compare the configs' contents.
        const c = d.t.battle_skill_type_config.get(r.cd_type - FORMULA);
        S(`${p}.cdt`, `${L}cooldown type`, c ? 'charges' : 'missing charge config');
        if (c) { N(`${p}.ch1`, `${L}max charges`, c.charge_tier); N(`${p}.ch2`, `${L}starting charges`, c.start_charge_tier); N(`${p}.ch3`, `${L}charge time`, c.charge_time); }
      } else S(`${p}.cdt`, `${L}cooldown type`, r.cd_type);
      S(`${p}.sbt`, `${L}blocked by`, r.special_buff_trigger); S(`${p}.dn`, `${L}day/night`, r.daynight_only <= 1 ? 'always' : r.daynight_only);
      const ai = d.t.battle_target_select_ai.get(r.target_select_ai);
      if (!ai) S(`${p}.ai`, `${L}target rule`, r.target_select_ai ? 'missing' : 'none');
      else {
        // Compare what the target rule does, not its id (some skills use one rule per level).
        for (const [f, l] of [['target_type', 'targets'], ['is_ingore_range', 'ignores range'], ['buff_trigger_type', 'target filter'], ['is_buff_type', 'filter by buff type'], ['is_ascend_order', 'order direction'], ['target_priority', 'target special mode'], ['is_search_all', 'searches everyone']]) S(`${p}.ai.${f}`, `${L}target rule: ${l}`, ai[f]);
        list(ai.select_order).map(Number).forEach((k, i) => {
          if (k >= FORMULA) { S(`${p}.ai.o${i}`, `${L}target rule: order key ${i + 1}`, 'formula'); formulaSample(d, k - FORMULA, `${p}.ai.o${i}`, `${L}target rule: order key ${i + 1}`, S, N); }
          else S(`${p}.ai.o${i}`, `${L}target rule: order key ${i + 1}`, k);
        });
        N(`${p}.ai.n`, `${L}target rule: number of targets`, ai.target_number); N(`${p}.ai.rank`, `${L}target rule: list position`, ai.list_ranking);
        if (ai.buff_trigger_type === 6 || ai.buff_trigger_type === 7) S(`${p}.ai.fb`, `${L}target rule: filter buff type`, d.t.battle_buff.get(ai.target_buff_id)?.type ?? 'missing');
      }
      S(`${p}.prio`, `${L}priority`, r.skill_priority);
      N(`${p}.cd`, `${L}cooldown`, r.cd_time); N(`${p}.scd`, `${L}initial cooldown`, r.start_cd_time);
      N(`${p}.dur`, `${L}skill duration`, r.skill_duration);
      for (const col of Object.keys(POOL_LABEL)) {
        const arr = list(r[col]);
        S(`${p}.${col}.n`, `${L}${POOL_LABEL[col]} size`, arr.length);
        arr.forEach((x, i) => {
          const q = `${p}.${col}.${i}`; const l = `${L}${POOL_LABEL[col]} value ${i + 1}`;
          if (isNum(x)) N(q, l, x);
          else if (x.startsWith('*') && isNum(x.slice(1))) {
            // One formula per level is normal; compare the formulas' numbers instead of their ids.
            S(q, l, 'formula');
            formulaSample(d, Number(x.slice(1)), q, l, S, N);
          } else S(q, l, x);
        });
      }
      ids(r.trigger_id).forEach((t, i) => trig(Number(t), `${p}.t${i}`, `${L}trigger ${i + 1}: `));
      ids(r.sppool_trigger_id).forEach((t, i) => trig(Number(t), `${p}.st${i}`, `${L}special-pool trigger ${i + 1}: `));
      for (const [col, who] of [['buff_id_target', 'target'], ['buff_id_self', 'self']]) {
        parseBuffList(r[col]).forEach((b, i) => {
          const q = `${p}.${who}${i}`; const l = `${L}${who} buff ${i + 1}`;
          S(`${q}.sign`, `${l} add/remove`, b.stacks?.num < 0 ? 'remove' : 'add');
          if (b.stacks && 'num' in b.stacks) N(`${q}.st`, `${l} stacks`, Math.abs(b.stacks.num));
          if (b.idFormula !== null) S(`${q}.f`, `${l} chosen by formula`, 'yes'); else buff(b.id, q, `${l} (buff ${b.id}) `, depth);
        });
      }
      S(`${p}.purge`, `${L}removes buff types`, `${r.buff_type_target}|${r.buff_type_self}`);
      const a = d.t.battle_action_config.get(r.action_id);
      const cs = a ? ids(a.creation_order) : []; const cd = a ? list(a.creation_delay) : [];
      S(`${p}.nc`, `${L}number of created objects`, cs.length);
      cs.forEach((c, i) => { N(`${p}.c${i}.at`, `${L}object ${i + 1} delay`, cd[i]); creation(Number(c), `${p}.c${i}`, `${L}object ${i + 1} (creation ${c}) `, depth); });
      if (a) S(`${p}.sum`, `${L}summons`, ids(a.summon_order).length);
    };
    const trig = (id, p, L) => {
      const t = d.t.battle_trigger.get(id);
      if (!t) { S(p, `${L}trigger`, 'missing'); return; }
      S(`${p}.type`, `${L}type`, t.type); S(`${p}.tg`, `${L}subject`, t.target);
      if (t.type === 6 || t.type === 7) S(`${p}.bt`, `${L}checked buff type`, t.is_buff_type ? `type ${t.buff_id}` : d.t.battle_buff.get(t.buff_id)?.type ?? 'missing');
      if (isNum(t.parameter)) N(`${p}.par`, `${L}value`, t.parameter);
    };
    const buff = (id, p, L, depth) => {
      const b = d.t.battle_buff.get(id);
      if (!b) { S(p, `${L}`, 'missing'); return; }
      S(`${p}.type`, `${L}type`, `${b.type} (${buffTypeName(b.type)})`);
      N(`${p}.max`, `${L}max stacks`, b.max_tier);
      S(`${p}.dk`, `${L}duration kind`, valKind(b.duration)); N(`${p}.dur`, `${L}duration`, b.duration);
      const col = BUFF_COL[b.type] ?? 'parameter_value';
      S(`${p}.vk`, `${L}value kind`, valKind(b[col])); N(`${p}.v`, `${L}value`, b[col]);
      S(`${p}.boss`, `${L}works on bosses`, b.boss_available);
      S(`${p}.agt`, `${L}restricted to`, b.available_gun_type);
      if (b.type === 402) formulaConsts(d.formula(Number(b.fix_damage) - FORMULA)).forEach((v, i) => N(`${p}.fx${i}`, `${L}damage formula number ${i + 1}`, v));
      if (seen.has(p) || depth > 3) return;
      seen.add(p);
      ids(b.forced_skill).forEach((s, i) => skill(d.skillRow(Number(s), 1), `${p}.fs${i}`, `${L}→ granted skill ${s} `, depth + 1));
      S(`${p}.watch`, `${L}watcher`, b.watch_id ? (d.t.battle_watch.get(b.watch_id)?.watch_trigger_type ?? 'missing') : 0);
      if (b.watch_id) ids(d.t.battle_watch.get(b.watch_id)?.activation_skills).forEach((s, i) => skill(d.skillRow(Number(s), 1), `${p}.ws${i}`, `${L}→ watcher skill ${s} `, depth + 1));
      ids(b.trigger_creation_id).forEach((c, i) => creation(Number(c), `${p}.tc${i}`, `${L}→ object ${c} `, depth + 1));
    };
    const creation = (id, p, L, depth) => {
      const c = d.t.battle_creation.get(id);
      if (!c) { S(p, `${L}`, 'missing'); return; }
      if (depth > 6) return;
      S(`${p}.et`, `${L}affects`, c.effect_type === 1 ? 'allies' : 'enemies'); S(`${p}.ea`, `${L}area shape`, c.effect_area); S(`${p}.fp`, `${L}per dummy link`, c.is_form_play);
      N(`${p}.a1`, `${L}area size`, c.effect_param_1); N(`${p}.a2`, `${L}area size 2`, c.effect_param_2); N(`${p}.life`, `${L}lifetime`, c.exist_duration);
      const hc = list(c.hurt_cd);
      ids(c.hurt_id).forEach((h, i) => { N(`${p}.h${i}.cd`, `${L}hit ${i + 1} interval`, hc[i]); hurt(Number(h), `${p}.h${i}`, `${L}hit ${i + 1} (hit ${h}) `, depth); });
      const bc = list(c.buff_cd);
      parseBuffList(c.buff_id).forEach((b, i) => { N(`${p}.b${i}.cd`, `${L}buff ${i + 1} interval`, bc[i]); if (b.idFormula === null) buff(b.id, `${p}.b${i}`, `${L}buff ${i + 1} (buff ${b.id}) `, depth); });
      ids(c.trigger_creation_id).filter(isNum).forEach((x, i) => creation(Number(x), `${p}.k${i}`, `${L}→ object ${x} `, depth + 1));
      S(`${p}.sum`, `${L}summons`, ids(c.summoner_order).length);
    };
    const hurt = (id, p, L, depth) => {
      const h = d.t.battle_hurt_config.get(id);
      if (!h) { S(p, `${L}`, 'missing'); return; }
      for (const [k, l] of [['is_miss', 'can miss'], ['is_critical_hit', 'crit rule'], ['is_armor', 'armor applies'], ['is_form_hurt', 'area hit'], ['hit_type', 'hit roll'], ['hurt_buff_trigger_type', 'on-hit buff condition']]) S(`${p}.${k}`, `${L}${l}`, h[k]);
      S(`${p}.dk`, `${L}damage kind`, valKind(h.damage_ratio)); N(`${p}.dmg`, `${L}damage %`, h.damage_ratio); N(`${p}.rate`, `${L}on-hit buff chance`, h.buff_rate);
      for (const [col, who] of [['buff_id_target', 'target'], ['buff_id_self', 'self']]) parseBuffList(h[col]).forEach((b, i) => { if (b.idFormula === null) buff(b.id, `${p}.${who}${i}`, `${L}on-hit ${who} buff ${i + 1} (buff ${b.id}) `, depth); });
      list(h.fix_damage).forEach((f, i) => { const q = parseVal(f); if (q?.formula) formulaConsts(d.formula(q.formula)).forEach((v, j) => N(`${p}.fd${i}.${j}`, `${L}damage formula ${i + 1} number ${j + 1}`, v)); });
    };
    skill(row, 'S', '', 0);
    return out;
  },

  // ==================================================================== levels

  checkLevels() {
    for (const k of this.kit.values()) {
      const lv = this.d.skillLevels(k.group);
      if (lv.length < 2) continue;
      const fps = lv.map((l) => ({ l, fp: this.fingerprint(this.d.skillRow(k.group, l)) }));
      k.fps = fps;
      this.compareStructure(k, fps);
      this.compareTrends(k, fps);
    }
  },

  compareStructure(k, fps) {
    const key = (fp) => fp.filter((x) => x.k === 's').map((x) => `${x.p}=${x.v}`).join('|');
    const groups = new Map();
    for (const f of fps) { const kk = key(f.fp); if (!groups.has(kk)) groups.set(kk, []); groups.get(kk).push(f); }
    if (groups.size < 2) return;
    const gs = [...groups.values()].sort((a, b) => b.length - a.length || b[b.length - 1].l - a[a.length - 1].l);
    const major = gs[0];
    if (gs.length === fps.length && fps.length > 2) {
      // Every level is different: describe the first difference between level 1 and the top level once.
      const A = new Map(fps[0].fp.filter((x) => x.k === 's').map((x) => [x.p, x])); const B = new Map(fps[fps.length - 1].fp.filter((x) => x.k === 's').map((x) => [x.p, x]));
      const diffs = [...A].filter(([p, a]) => B.get(p)?.v !== a.v).map(([, a]) => `${esc(a.label)}: ${esc(a.v)} at level ${fps[0].l} but ${esc(B.get(a.p)?.v ?? 'absent')} at level ${fps[fps.length - 1].l}`);
      this.note('warn', 'levels', `${this.skillName(k.group)}: every level is built differently. ${diffs.slice(0, 3).join('; ')}.`);
      return;
    }
    for (const minor of gs.slice(1)) {
      const A = new Map(minor[0].fp.filter((x) => x.k === 's').map((x) => [x.p, x]));
      const B = new Map(major[0].fp.filter((x) => x.k === 's').map((x) => [x.p, x]));
      const diffs = [];
      let substitution = false;
      for (const [p, a] of A) { const b = B.get(p); if (!b) diffs.push(`${esc(a.label)} only exists here`); else if (b.v !== a.v) { diffs.push(`${esc(a.label)}: <b>${esc(a.v)}</b> instead of ${esc(b.v)}`); substitution = true; } }
      for (const [p, b] of B) if (!A.has(p)) diffs.push(`${esc(b.label)} is missing`);
      if (!diffs.length) continue;
      const ls = minor.map((x) => x.l);
      const others = major.map((x) => x.l);
      const where = ls.length === 1 ? `Level ${ls[0]}` : `Levels ${rangeText(ls)}`;
      const later = ls.every((l) => l > Math.max(...others));
      let sev, lead;
      if (later && !substitution) { sev = 'info'; lead = `${where} add${ls.length === 1 ? 's' : ''} to the skill`; }
      else if (ls.length === 1 && others.length >= 2 && substitution) { sev = 'bug'; lead = `${where} is built differently from level${others.length > 1 ? 's' : ''} ${rangeText(others)}`; }
      else { sev = 'warn'; lead = `${where} ${ls.length === 1 ? 'is' : 'are'} built differently from level${others.length > 1 ? 's' : ''} ${rangeText(others)}`; }
      this.note(sev, 'levels', `${this.skillName(k.group)}: ${lead}. ${diffs.slice(0, 4).join('; ')}${diffs.length > 4 ? `; and ${diffs.length - 4} more differences` : ''}.`);
    }
  },

  compareTrends(k, fps) {
    const series = new Map();
    for (const { l, fp } of fps) for (const x of fp) if (x.k === 'n') { if (!series.has(x.p)) series.set(x.p, { label: x.label, vals: new Map() }); series.get(x.p).vals.set(l, x.v); }
    for (const { label, vals } of series.values()) {
      if (vals.size !== fps.length) continue;
      const ls = [...vals.keys()]; const vs = ls.map((l) => vals.get(l));
      if (new Set(vs).size < 2 || monotonic(vs)) continue;
      // A single level that breaks an otherwise steady trend.
      const bad = ls.filter((_, i) => { const rest = vs.filter((__, j) => j !== i); return monotonic(rest) && new Set(rest).size > 1; });
      if (bad.length !== 1) continue;
      const i = ls.indexOf(bad[0]);
      const ctx = [i > 0 ? `L${ls[i - 1]} ${num(vs[i - 1])}` : '', i < ls.length - 1 ? `L${ls[i + 1]} ${num(vs[i + 1])}` : ''].filter(Boolean).join(', ');
      this.note('warn', 'levels', `${this.skillName(k.group)}: ${esc(label.replace(/ \((buff|creation|hit) \d+\)/g, '').trim())} is <b>${num(vs[i])}</b> at level ${bad[0]}, breaking the trend of the other levels (${ctx}).`);
    }
  },
});

// ====================================================================== shared helpers

const NUM_RE = /(?<![A-Za-z\-\/.\d])(\d+(?:\.\d+)?)(?![\d.]|[A-WYZa-rt-wyz\-\/]|[sx][A-Za-z])/g;
// Equal, rounded or truncated the way the game's texts do it (6.8667 is written 6.8 or 6.9).
const near = (a, b) => Math.abs(a - b) <= 0.051 || Math.abs(a - b) <= Math.abs(b) * 0.006 || Math.round(b) === a || Math.round(b * 10) / 10 === a || (b % 1 !== 0 && Math.floor(b * 10 + 1e-9) / 10 === a && a % 1 !== 0);
const TRANSFORMS = [
  ['', (x) => x], ['−100', (x) => x - 100], ['100−', (x) => 100 - x], ['/100', (x) => x / 100], ['(−100)/100', (x) => (x - 100) / 100],
  ['frames→s', (x) => x / FPS], ['abs', (x) => Math.abs(x)], ['×100', (x) => x * 100], ['/10', (x) => x / 10],
];

/** Every buff id applied anywhere in the game data (cached on the GameData object). */
function appliedAnywhere(d) {
  if (d._applied) return d._applied;
  const s = new Set();
  const add = (cell) => { for (const b of parseBuffList(cell)) { if (b.id) s.add(b.id); if (b.idFormula) for (const m of (d.formula(b.idFormula) ?? '').matchAll(/[?:]\s*(\d+)/g)) s.add(Number(m[1])); } };
  for (const r of d.t.battle_skill_config.values()) { add(r.buff_id_target); add(r.buff_id_self); }
  for (const c of d.t.battle_creation.values()) add(c.buff_id);
  for (const h of d.t.battle_hurt_config.values()) { add(h.buff_id_target); add(h.buff_id_self); add(h.range_buff_target); add(h.range_buff_self); }
  d._applied = s;
  return s;
}

/** +1 if the buff helps whoever has it, −1 if it hurts, 0 if unknown. */
function effectSign(b, v) {
  const t = b.type;
  if (PCT_STAT[t]) return t === 128 || t === 228 ? (v < 100 ? 1 : v > 100 ? -1 : 0) : v > 100 ? 1 : v < 100 ? -1 : 0;
  if (t === 810) return v > 0 ? -1 : v < 0 ? 1 : 0;
  if (FLAT_STAT[t]) return v > 0 ? 1 : v < 0 ? -1 : 0;
  if (t === 110) return v > 100 ? -1 : v < 100 ? 1 : 0;
  if ([109, 107, 120, 307].includes(t)) return 1;
  if ([221, 301, 304, 305, 220, 222, 302].includes(t)) return -1;
  return 0;
}

Object.assign(Checker.prototype, {
  /** Value of a buff column in the context of the skill that applies it (its run level). */
  resolve(cell, viaGroup) {
    const p = parseVal(cell);
    if (!p) return null;
    if ('num' in p) return p.num;
    if ('pool' in p) {
      const row = this.d.skillRow(viaGroup, this.kit.get(viaGroup)?.level ?? 1);
      if (!row) return null;
      const which = Math.floor(p.pool / 100) === 1 ? 1 : 2;
      const vals = list(row[`data_pool_${which}`]); const i = (p.pool % 100) - 1;
      const s = vals[i];
      return s !== undefined && isNum(s) ? Number(s) : null;
    }
    return null;
  },

  /** Stack counts actually given to a buff in this kit (for evaluating formulas that read them). */
  givenStacks(id) {
    const out = new Set([0]);
    const b = this.d.t.battle_buff.get(id);
    for (const a of this.applies) if (a.buff === id) out.add(a.stacks > 0 ? Math.min(a.stacks, b?.max_tier ?? a.stacks) : a.stacks === 0 ? this.mag : 1);
    if (b && b.max_tier <= 20) for (let n = 0; n <= b.max_tier; n++) out.add(n);
    else if (b) out.add(b.max_tier);
    return [...out];
  },

  /** Results of a formula over the stack counts the kit can produce; null if other unknowns are involved. */
  formulaValues(id, viaGroup) {
    const text = this.d.formula(id);
    if (!text) return null;
    let tree; try { tree = parseFormula(text); } catch { return null; }
    const vars = [];
    const walk = (t) => { if (!t) return; if (t.n === 'fn' && /^[st]buffidtier$/.test(t.v) && t.args[0]?.n === 'num') { const k = t.v[0] + t.args[0].v; if (!vars.some((v) => v.k === k)) vars.push({ k, vals: this.givenStacks(t.args[0].v) }); } for (const x of ['a', 'b', 'c']) walk(t[x]); for (const a of t.args ?? []) walk(a); };
    walk(tree);
    if (vars.length > 3) return null;
    const res = []; const cur = {};
    const env = (t) => {
      if (t.n === 'fn' && /^[st]buffidtier$/.test(t.v)) return cur[t.v[0] + t.args[0]?.v];
      if (t.n === 'fn' && (t.v === 'salivecount' || t.v === 'talivecount')) return cur[t.v];
      return undefined;
    };
    if (/[st]alivecount/.test(text)) for (const f of ['salivecount', 'talivecount']) if (text.includes(f)) vars.push({ k: f, vals: [0, 1, 2, 3, 4, 5] });
    const rec = (i) => { if (i === vars.length) { const v = evalFormula(tree, env); if (v !== undefined) res.push(v); return; } for (const x of vars[i].vals) { cur[vars[i].k] = x; rec(i + 1); } };
    rec(0);
    return res.length ? res : null;
  },

  // ==================================================================== descriptions

  relatedGroups(group) {
    if (!this._comp) {
      const parent = new Map();
      const find = (x) => { while (parent.get(x) !== undefined && parent.get(x) !== x) x = parent.get(x); return x; };
      const join = (a, b) => { if (!parent.has(a)) parent.set(a, a); if (!parent.has(b)) parent.set(b, b); const ra = find(a); const rb = find(b); if (ra !== rb) parent.set(ra, rb); };
      for (const k of this.kit.values()) join(k.group, k.group);
      const setBy = new Map();
      for (const a of this.applies) { if (!setBy.has(a.buff)) setBy.set(a.buff, new Set()); setBy.get(a.buff).add(a.via); }
      for (const c of this.checks) for (const v of setBy.get(c.buff) ?? []) join(v, c.via);
      for (const [a, b] of this.links) join(a, b);
      this._comp = (g) => [...parent.keys()].filter((x) => find(x) === find(g));
    }
    return this._comp(group);
  },

  factsFor(group) {
    const facts = [];
    const push = (v) => { if (typeof v === 'number' && Number.isFinite(v)) for (const [, f] of TRANSFORMS) facts.push(f(v)); };
    for (const g of this.relatedGroups(group)) {
      const k = this.kit.get(g);
      const fps = k?.fps ?? [{ fp: this.fingerprint(this.d.skillRow(g, k?.level ?? 1)) }];
      for (const { fp } of fps) for (const x of fp) if (x.k === 'n') push(x.v);
      for (const f of this.formulas) if (f.via === g) for (const v of this.formulaValues(f.id, g) ?? []) push(Number(v));
      for (const f of this.formulas) if (f.via === g) for (const v of formulaConsts(this.d.formula(f.id))) push(v);
    }
    for (const a of this.applies) if (this.relatedGroups(group).includes(a.via) && a.stacks > 0) push(a.stacks);
    return facts;
  },

  checkDescriptions() {
    const done = new Set();
    for (const e of this.entries) {
      if (e.equip || done.has(e.group)) continue;
      done.add(e.group);
      const lv = this.d.skillLevels(e.group);
      const texts = lv.map((l) => ({ l, t: this.d.text(this.d.skillRow(e.group, l)?.description) })).filter((x) => x.t && !/[㐀-鿿]/.test(x.t));
      if (!texts.length) continue;
      const name = this.skillName(e.group);
      // Remove numbers that belong to names ("Type 64", "AK-74U").
      const nameNums = new Set([this.d.unitName(this.kind, this.g), this.g.en_name, this.d.text(this.d.skillRow(e.group, 1)?.name)].join(' ').match(/\d+(\.\d+)?/g) ?? []);
      const nums = (t) => [...t.matchAll(NUM_RE)].map((m) => Number(m[1]));
      const tpl = (t) => normWords(t.replace(/\d+(\.\d+)?/g, ' # ').replace(/%/g, ' % ')).join(' ');
      // 1. Wording that differs between levels.
      const groups = new Map();
      for (const x of texts) { const k = tpl(x.t); if (!groups.has(k)) groups.set(k, []); groups.get(k).push(x); }
      const gs = [...groups.values()].sort((a, b) => b.length - a.length);
      const major = gs[0];
      if (gs.length > 1 && major.length >= 2) {
        for (const minor of gs.slice(1)) {
          if (minor.length > major.length / 2) continue;
          const ref = major.reduce((best, x) => (Math.abs(x.l - minor[0].l) < Math.abs(best.l - minor[0].l) ? x : best), major[0]);
          const [wa, wb] = wordDiff(minor[0].t, ref.t);
          this.note('warn', 'desc', `${name}: level ${rangeText(minor.map((x) => x.l))} description is worded differently from the other levels: “…${esc(wa)}…” where level ${ref.l} says “…${esc(wb)}…”.`);
        }
      }
      // 2. Numbers that change with level: match each against a data series.
      const k = this.kit.get(e.group);
      const fps = k?.fps;
      const rows = major.filter((x) => nums(x.t).length === nums(major[0].t).length);
      const nPos = rows.length ? nums(rows[0].t).length : 0;
      const constant = [];
      const explained = new Set();
      const pending = [];
      for (let pos = 0; pos < nPos; pos++) {
        const ds = rows.map((x) => ({ l: x.l, v: nums(x.t)[pos] }));
        if (new Set(ds.map((x) => x.v)).size === 1) { constant.push(ds[0].v); continue; }
        if (!fps) continue;
        let best = null;
        const seriesByPath = new Map();
        // This skill's own values, plus those of related skills that level up with it (hidden skills it controls).
        const sources = [[e.group, fps], ...this.relatedGroups(e.group).filter((x) => x !== e.group && this.kit.get(x)?.fps?.length === fps.length).map((x) => [x, this.kit.get(x).fps])];
        for (const [grp, f2] of sources) for (const { l, fp } of f2) for (const x of fp) if (x.k === 'n') {
          const p = `${grp}:${x.p}`;
          if (!seriesByPath.has(p)) seriesByPath.set(p, { label: grp === e.group ? x.label : `${this.skillName(grp).replace(/<[^>]+>/g, '')} ${x.label}`, v: new Map(), own: grp === e.group, sample: /formula value with/.test(x.label), path: p });
          seriesByPath.get(p).v.set(l, x.v);
        }
        for (const s of seriesByPath.values()) {
          for (const [tn, f] of TRANSFORMS) {
            let hit = 0; const miss = [];
            if (ds.some((x) => !s.v.has(x.l))) continue;          // only series that exist at every level
            if (new Set(ds.map((x) => s.v.get(x.l))).size < 2) continue; // the text changes with level, so must the data
            for (const x of ds) { const dv = f(s.v.get(x.l)); if (near(x.v, dv)) hit++; else miss.push({ ...x, dv }); }
            const first = !miss.some((m) => m.l === ds[0].l);
            const score = hit * 2 + (first ? 1 : 0);
            if (!best || score > best.score) best = { hit, miss, label: s.label, tn, score, own: s.own, sample: s.sample, first, path: s.path };
          }
        }
        if (!best) continue;
        if (best.hit === ds.length) { explained.add(best.path); continue; }
        pending.push({ ds, best, seriesByPath });
      }
      for (const { ds, best, seriesByPath } of pending) {
        const clean = (l) => esc(l.replace(/ \((buff|creation|hit) \d+\)/g, '').trim());
        const allowedMisses = best.own && !best.sample ? 2 : 1;
        if (best.hit >= Math.max(ds.length - allowedMisses, Math.ceil(ds.length * 0.7)) && best.miss.every((m) => m.dv !== null)) {
          for (const m of best.miss) this.note('bug', 'desc', `${name}: the level ${m.l} description says <b>${num(m.v)}</b>, but the data gives <b>${num(m.dv)}</b> (${clean(best.label)}), which matches the description at every other level.`);
          continue;
        }
        // A data series that agrees at some levels and moves the same way, but drifts apart: the text scales differently.
        const exactFirst = best.first && ['', '−100', '100−', '/100'].includes(best.tn) && ds[0] && Math.abs(ds[0].v - TRANSFORMS.find((t) => t[0] === best.tn)[1](seriesByPath.get(best.path)?.v.get(ds[0].l) ?? NaN)) < 0.051;
        if (best.own && !best.sample && exactFirst && best.miss.length && !explained.has(best.path)) {
          const lo = ds[0]; const hi = ds[ds.length - 1];
          const dlo = best.miss.find((m) => m.l === lo.l)?.dv ?? lo.v; const dhi = best.miss.find((m) => m.l === hi.l)?.dv ?? hi.v;
          if (Math.sign(hi.v - lo.v) === Math.sign(dhi - dlo) && Math.abs((dhi - dlo) - (hi.v - lo.v)) > 0.2 * Math.abs(hi.v - lo.v)) {
            this.note('bug', 'desc', `${name}: the description gives <b>${num(lo.v)} → ${num(hi.v)}</b> from level ${lo.l} to ${hi.l}, but the matching value in the data (${clean(best.label)}) goes <b>${num(dlo)} → ${num(dhi)}</b>; they agree only at level${best.hit > 1 ? 's' : ''} ${rangeText(ds.filter((x) => !best.miss.some((m) => m.l === x.l)).map((x) => x.l))}.`);
            continue;
          }
        }
        this.untraced.push(`${name}: ${ds.map((x) => num(x.v)).join(' / ')} (levels ${ds[0].l}–${ds[ds.length - 1].l})`);
      }
      // Stack caps and target choices the text promises.
      this.checkTextPromises(e.group, name, texts[texts.length - 1]);
      // 3. Numbers that are the same at every level: they must appear somewhere in this skill or the hidden skills it controls.
      const single = rows.length ? [] : nums(texts[texts.length - 1].t);
      const facts = this.factsFor(e.group);
      const bad = [...new Set([...constant, ...single])].filter((v) => !nameNums.has(String(v)) && !facts.some((f) => near(v, f)));
      if (bad.length) this.untraced.push(`${name}: ${bad.map(num).join(', ')}`);
    }
  },

  /** "stacking up to N times" must match a stack cap; "furthest/nearest/highest HP" must match a target ordering. */
  checkTextPromises(group, name, last) {
    const t = last.t;
    const related = this.relatedGroups(group);
    const buffs = new Set(this.applies.filter((a) => related.includes(a.via)).map((a) => a.buff));
    const caps = new Set([...buffs].map((b) => this.d.t.battle_buff.get(b)?.max_tier).filter(Boolean));
    const params = new Set(this.checks.filter((c) => related.includes(c.via)).map((c) => c.n));
    for (const m of t.matchAll(/(?:stack(?:ing|s)? up to|up to a maximum of|max(?:imum)?(?: of)?) (\d+) (?:times|stacks)/gi)) {
      const n = Number(m[1]);
      if (!caps.has(n) && !params.has(n) && !params.has(n + 1) && !this.factsFor(group).some((f) => f === n)) {
        this.note('warn', 'stacking', `${name}: the level ${last.l} text says “${esc(m[0])}”, but no buff this skill and its hidden skills apply has a cap of ${n} (caps: ${[...caps].sort((a, b) => a - b).join(', ') || 'none'}), and no condition checks for ${n} stacks.`);
      }
    }
    const want = [];
    if (/\b(furthest|farthest|most distant)\b/i.test(t)) want.push({ word: 'furthest', keys: [4, 9, 10, 11], dir: 'highest' });
    if (/\b(nearest|closest)\b/i.test(t)) want.push({ word: 'nearest', keys: [4, 9, 10, 11], dir: 'lowest' });
    if (/\bhighest (current )?HP\b/i.test(t)) want.push({ word: 'highest HP', keys: [1, 2, 3], dir: 'highest' });
    if (/\blowest (current )?HP\b/i.test(t)) want.push({ word: 'lowest HP', keys: [1, 2, 3], dir: 'lowest' });
    if (!want.length) return;
    const rules = related.map((g) => this.d.skillRow(g, this.kit.get(g)?.level ?? 1)).filter(Boolean).map((r) => this.d.t.battle_target_select_ai.get(r.target_select_ai)).filter(Boolean);
    for (const w of want) {
      const ok = rules.some((a) => list(a.select_order).map(Number).some((k, i) => (k >= FORMULA) || (w.keys.includes(k) && ((Number(list(a.is_ascend_order)[i]) === 1) === (w.dir === 'highest')))));
      if (!ok) this.note('warn', 'targeting', `${name}: the text says it targets the <b>${w.word}</b> enemy, but none of the target rules used by this skill and its hidden skills sorts that way (${[...new Set(rules.map((a) => `rule ${a.id}: ${list(a.select_order).join(',') || 'no order'}/${a.is_ascend_order}`))].join('; ')}).`);
    }
  },

  // ==================================================================== buff values and sides

  checkBuffValues() {
    const done = new Set();
    for (const a of this.applies) {
      const key = `${a.buff}@${a.via}@${a.side}`;
      if (done.has(key)) continue;
      done.add(key);
      const b = this.d.t.battle_buff.get(a.buff);
      if (!b) continue;
      const col = BUFF_COL[b.type];
      const statType = PCT_STAT[b.type] || FLAT_STAT[b.type] || [109, 110, 122].includes(b.type);
      if (col && statType) {
        const raw = String(b[col] ?? '').trim();
        const others = Object.entries(b).filter(([c, v]) => c !== col && Object.values(BUFF_COL).includes(c) && String(v ?? '').trim() !== '' && String(v) !== '0');
        if ((raw === '' || raw === '0') && others.length) this.note('bug', 'values', `${this.buffName(a.buff)} is a ${esc(buffTypeName(b.type))} buff, but its value is in the <code>${esc(others[0][0])}</code> column instead of <code>${col}</code>, so the game reads 0.`);
        const v = this.resolve(b[col], a.via);
        if (PCT_STAT[b.type] && v === 0 && b.type < 200 && ![105, 215].includes(b.type) && !this.hasAltPool(b[col], a.via)) this.note('bug', 'values', `${this.buffName(a.buff)} (from ${this.skillName(a.via)}) multiplies ${esc(buffTypeName(b.type).replace(' ×', ''))} by <b>0</b>.`);
        if (v !== null && v !== undefined) {
          const sign = effectSign(b, v);
          if (sign > 0 && a.side === 'enemy') this.note('warn', 'targeting', `${this.skillName(a.via)} gives <b>enemies</b> ${this.buffName(a.buff)}, which helps them (${esc(buffTypeName(b.type))} ${num(v)}).`);
          if (sign < 0 && (a.side === 'ally' || a.side === 'self') && !this.hasEnemyIntent(a)) this.note('info', 'targeting', `${this.skillName(a.via)} gives ${a.side === 'self' ? (this.kind === 'gun' ? 'the doll herself' : 'the unit itself') : '<b>allies</b>'} ${this.buffName(a.buff)}, which weakens them (${esc(buffTypeName(b.type))} ${num(v)}).`);
        }
      }
      if (a.stacks > b.max_tier && b.max_tier > 0) this.note('warn', 'stacking', `${this.skillName(a.via)} gives ${a.stacks} stacks of ${this.buffName(a.buff)}, which can only hold ${b.max_tier}.`);
    }
  },
  hasEnemyIntent() { return false; },
  /** True if a pool reference has a night or special-pool alternative (the normal pool's 0 is then a placeholder). */
  hasAltPool(cell, via) {
    const p = parseVal(cell); if (!p || !('pool' in p)) return false;
    const row = this.d.skillRow(via, this.kit.get(via)?.level ?? 1); const w = Math.floor(p.pool / 100) === 1 ? 1 : 2;
    return list(row?.[`night_data_pool_${w}`]).length > 0 || list(row?.[`sp_data_pool_${w}`]).length > 0;
  },

  // ==================================================================== stacking

  checkStacking() {
    const groups = new Map();
    for (const a of this.applies) {
      const b = this.d.t.battle_buff.get(a.buff);
      if (!b || MARKER_TYPES.has(b.type) || b.type === 401) continue;
      const k = `${b.type}:${b.conflict_type}`;
      if (!groups.has(k)) groups.set(k, new Map());
      groups.get(k).set(a.buff, a.via);
    }
    for (const [k, m] of groups) {
      if (m.size < 2) continue;
      const vias = new Set(m.values());
      const b = this.d.t.battle_buff.get([...m.keys()][0]);
      const list2 = [...m].map(([id, via]) => `${this.buffName(id)} (from ${this.skillName(via)})`).join(', ');
      this.note(vias.size > 1 ? 'warn' : 'info', 'stacking', `These buffs share one stack counter (type ${b.type}, group ${b.conflict_type}, cap ${b.max_tier}), so applying one can push out another: ${list2}.`);
    }
  },

  // ==================================================================== triggers and targeting

  checkTriggersAndTargets() {
    const applied = appliedAnywhere(this.d);
    const done = new Set();
    for (const c of this.checks) {
      if (c.isType) continue;
      const key = `${c.buff}@${c.via}@${c.kind}@${c.n}@${c.how}`;
      if (done.has(key)) continue;
      done.add(key);
      const b = this.d.t.battle_buff.get(c.buff);
      const where = `${this.skillName(c.via)} (${esc(c.how)})`;
      if (!b) { this.note('bug', c.kind === 'formula' ? 'formulas' : 'triggers', `${where} checks buff ${c.buff}, which does not exist, so the check always reads 0 stacks.`); continue; }
      if (c.kind !== 'formula' && c.n > b.max_tier) {
        this.note('bug', 'triggers', `${where} needs ${c.kind === 'has' ? 'at least' : 'fewer than'} ${c.n} stacks of ${this.buffName(c.buff)}, but that buff holds at most ${b.max_tier}, so the condition is ${c.kind === 'has' ? 'never' : 'always'} true.`);
      }
      if (!applied.has(c.buff)) {
        this.note('bug', c.kind === 'formula' ? 'formulas' : 'triggers', `${where} checks ${this.buffName(c.buff)}, but nothing in the game ever applies that buff, so the check always reads 0 stacks.`);
      }
    }
    for (const k of this.kit.values()) {
      const r = this.d.skillRow(k.group, k.level);
      if (!r) continue;
      for (const t of ids(r.trigger_id).map((x) => this.d.t.battle_trigger.get(Number(x))).filter(Boolean)) {
        const p = Number(t.parameter);
        if (t.type === 11 && (p >= 100 || p <= 0)) this.note('warn', 'triggers', `${this.skillName(k.group)} has a ${p}% chance trigger (trigger ${t.id}), so it ${p >= 100 ? 'always' : 'never'} passes.`);
        if ((t.type === 2 || t.type === 3) && (p > 100 || p < 0)) this.note('warn', 'triggers', `${this.skillName(k.group)} checks HP ${t.type === 2 ? '≤' : '≥'} ${p}% (trigger ${t.id}), which is outside 0–100%.`);
      }
    }
  },

  // ==================================================================== skill order

  checkPriority() {
    const order = [...this.kit.keys()];
    const rows = order.map((g) => ({ g, r: this.d.skillRow(g, this.kit.get(g).level) })).filter((x) => x.r);
    const conds = (r) => ids(r.trigger_id).map((t) => this.d.t.battle_trigger.get(Number(t))).filter(Boolean)
      .filter((t) => (t.type === 6 || t.type === 7) && !t.is_buff_type && (t.target === 0 || t.target === 1))
      .map((t) => ({ buff: t.buff_id, has: t.type === 6, n: Number(t.parameter) || 1 }));
    const removes = (r) => parseBuffList(r.buff_id_self).filter((b) => b.stacks && 'num' in b.stacks && b.stacks.num < 0).map((b) => b.id);
    const attacks = rows.filter((x) => x.r.type === 3);
    // 1. Attacks below a repeating skill's priority delay it until right after the attack.
    const top = attacks.length ? Math.max(...attacks.map((a) => a.r.skill_priority)) : null;
    for (const { g, r } of rows) {
      if (top === null || [3, 4, 7, 8].includes(r.type) || ![1, 6, 10].includes(r.type)) continue;
      if (r.skill_priority < top) this.note('info', 'priority', `${this.skillName(g)} has priority ${r.skill_priority}, below the ${this.kind === 'gun' ? 'doll' : 'unit'}'s attack priority (${top}): when both are ready in the same frame the attack goes first and the skill follows.`);
    }
    // 2. Two skills waiting for the same marker, where the one that goes first removes it.
    for (const a of rows) for (const b of rows) {
      if (a.g === b.g) continue;
      const ra = removes(a.r);
      for (const c of conds(a.r).filter((c) => c.has && ra.includes(c.buff))) {
        if (!conds(b.r).some((x) => x.has && x.buff === c.buff)) continue;
        if (removes(b.r).includes(c.buff)) continue;
        const aFirst = a.r.skill_priority > b.r.skill_priority || (a.r.skill_priority === b.r.skill_priority && order.indexOf(a.g) < order.indexOf(b.g));
        // A only always wins if it is allowed whenever B is (its conditions are a subset of B's), is never on
        // cooldown, and is not an attack (attacks only run when the attack timer allows).
        const sig = (t) => { const x = this.d.t.battle_trigger.get(Number(t)); return x ? `${x.type}|${x.target}|${x.parameter}|${x.buff_id}|${x.is_buff_type}` : t; };
        const ta = ids(a.r.trigger_id).map(sig); const tb = new Set(ids(b.r.trigger_id).map(sig));
        const subset = ta.every((t) => tb.has(t));
        const alwaysReady = a.r.type !== 3 && (Number(a.r.cd_time) <= 1 || a.r.cd_type === 0);
        if (!aFirst || !subset || !alwaysReady || b.r.type === 4) continue;
        this.note('warn', 'priority', `${this.skillName(a.g)} and ${this.skillName(b.g)} both wait for ${this.buffName(c.buff)}. ${this.skillName(a.g)} goes first (priority ${a.r.skill_priority} vs ${b.r.skill_priority}${a.r.skill_priority === b.r.skill_priority ? ', earlier in the list' : ''}) and removes it. Only one skill starts per frame, so ${this.skillName(b.g)} is never used while the other is ready.`);
      }
    }
    // 3. Attacks with the same priority whose conditions can hold together: only the first listed is used.
    const byPrio = new Map();
    for (const a of attacks) { if (!byPrio.has(a.r.skill_priority)) byPrio.set(a.r.skill_priority, []); byPrio.get(a.r.skill_priority).push(a); }
    for (const [p, as] of byPrio) {
      if (as.length < 2) continue;
      const exclusive = (x, y) => conds(x.r).some((c) => conds(y.r).some((d) => d.buff === c.buff && d.has !== c.has && d.n === c.n));
      const clash = as.filter((x) => as.some((y) => y !== x && !exclusive(x, y)));
      if (clash.length > 1) this.note('info', 'priority', `Attacks ${clash.map((a) => this.skillName(a.g)).join(', ')} share priority ${p} and nothing in their conditions rules out both being allowed at once; in that case the one listed first is used.`);
    }
  },

  // ==================================================================== formulas

  checkFormulas() {
    const done = new Set();
    for (const f of this.formulas) {
      if (!f.isCondition || done.has(f.id)) continue;
      done.add(f.id);
      const text = this.d.formula(f.id);
      if (!text || /[@#~]/.test(text) || /\$\d/.test(text)) continue;
      if (!/[st]buffidtier/.test(text)) continue;
      const vals = this.formulaValues(f.id, f.via);
      if (!vals) continue;
      const truth = new Set(vals.map((v) => !!v));
      if (truth.size === 1) this.note('warn', 'formulas', `${this.skillName(f.via)}: the condition in formula ${f.id} (<code>${esc(this.d.rawFormula(f.id))}</code>) is ${[...truth][0] ? 'always true' : 'never true'} for every stack count this kit can produce.`);
    }
  },

  // ==================================================================== bosses

  checkBossMarkers() {
    const onEnemies = new Set(this.applies.filter((a) => a.side === 'enemy').map((a) => a.buff));
    const done = new Set();
    for (const c of this.checks) {
      if (c.isType || done.has(c.buff) || !onEnemies.has(c.buff) || !['target', 'enemy'].includes(c.subject)) continue;
      const b = this.d.t.battle_buff.get(c.buff);
      if (!b || b.boss_available !== 0) continue;
      done.add(c.buff);
      const users = [...new Set(this.checks.filter((x) => x.buff === c.buff).map((x) => this.skillName(x.via)))].join(', ');
      this.note('bug', 'triggers', `${this.buffName(c.buff)} cannot be applied to bosses, but ${users} check${users.includes(',') ? '' : 's'} whether the target has it. Against a boss the marker is never there, so “has it” is never true and “doesn't have it” is always true.`);
    }
  },
});

/** The differing stretch of two texts, with a little context, as [a, b]. */
/** Words of a text in a form that ignores case, plurals, punctuation and spacing. */
function normWords(t) {
  return String(t).toLowerCase().replace(/[“”"'.,;:()!]/g, ' ').split(/\s+/).filter(Boolean).map((w) => (w.length > 3 && w.endsWith('s') ? w.slice(0, -1) : w));
}
function wordDiff(a, b) {
  const A = a.split(/\s+/); const B = b.split(/\s+/);
  const key = (w) => normWords(w.replace(/\d+(\.\d+)?/g, ' # ').replace(/%/g, ' % ')).join(' ');
  let i = 0; while (i < A.length && i < B.length && key(A[i]) === key(B[i])) i++;
  let j = 0; while (j < A.length - i && j < B.length - i && key(A[A.length - 1 - j]) === key(B[B.length - 1 - j])) j++;
  const s = Math.max(0, i - 3);
  return [A.slice(s, Math.min(A.length, A.length - j + 3)).join(' '), B.slice(s, Math.min(B.length, B.length - j + 3)).join(' ')];
}
