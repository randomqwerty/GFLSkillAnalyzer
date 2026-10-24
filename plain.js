// "In short": a plain one-paragraph summary of a skill, put together from the data with fixed phrases.
// It reads the skill row (when it fires, whom it targets) and the effects Analysis.fact() recorded while the
// skill was written out (buffs with their durations, hits with their areas, knock-back, summons).
import { list, num, FPS, FORMULA } from './analyzer.js';

const STAT_WORD = {
  pow: 'damage', hit: 'accuracy', dodge: 'evasion', rate: 'rate of fire', move: 'movement speed', crit: 'crit rate',
  critdmg: 'crit damage', armor: 'armor', ap: 'armor penetration', shieldbreak: 'shield break', range: 'range',
  tenacity: 'tenacity', immunity: 'debuff resistance', cdr: 'cooldown speed', night: 'night vision', dmgtaken: 'damage taken',
};
const SIDE = { self: 'self', ally: 'allies', enemy: 'enemies' };
const SORT_WORD = {
  1: ['the lowest HP', 'the highest HP'], 2: ['the lowest HP %', 'the highest HP %'], 3: ['the lowest max HP', 'the highest max HP'],
  4: ['the nearest', 'the farthest'], 5: ['the lowest damage', 'the highest damage'], 6: ['the lowest evasion', 'the highest evasion'],
  7: ['the lowest armor', 'the highest armor'], 9: ['the nearest', 'the farthest'], 10: ['the nearest', 'the farthest'],
  11: ['the nearest up or down', 'the farthest up or down'],
};
const s = (n, one, many) => `${num(n)} ${Math.abs(n) === 1 ? one : many}`;
const secs = (f) => `${num(f / FPS)} s`;

function when(A, e, row) {
  const d = A.d;
  if (row.type === 3) return 'Normal attack';
  const conds = [];
  for (const t of list(row.trigger_id).filter((x) => x !== '0').map((x) => d.t.battle_trigger.get(Number(x))).filter(Boolean)) {
    const p = String(t.parameter ?? '');
    const who = t.target === 2 ? 'the target' : t.target === 3 ? 'an ally' : t.target === 4 ? 'an enemy' : 'the user';
    if (t.type === 2) conds.push(`${who} is at ${p}% HP or less`);
    else if (t.type === 3) conds.push(`${who} is at ${p}% HP or more`);
    else if (t.type === 4) conds.push(`${who} dies`);
    else if (t.type === 8) conds.push('in certain missions');
    else if (t.type === 10) conds.push(`${who} dodges`);
    else if (t.type === 11) conds.push(`a ${p}% chance succeeds`);
    else if (t.type === 13) conds.push(`${who} is hit`);
    else if ([6, 7, 18].includes(t.type)) { if (!conds.includes('certain conditions hold')) conds.push('certain conditions hold'); }
  }
  let base;
  if (row.cd_type >= FORMULA) {
    const c = d.t.battle_skill_type_config.get(row.cd_type - FORMULA);
    base = c ? `Holds up to ${s(c.charge_tier, 'charge', 'charges')}, regaining one every ${secs(c.charge_time)}` : 'Uses charges';
  } else {
    const cd = A.valOf(row.cd_time, { row }).v; const st = A.valOf(row.start_cd_time, { row }).v;
    if (row.cd_type === 0) base = 'Whenever it can';
    else if (cd >= 9999) base = st ? `Once per battle, after ${secs(st)}` : e.field === 'passive_skill' && !conds.length ? 'At the start of battle' : 'Once per battle';
    else if (cd !== null && cd <= 1) base = conds.length ? 'Whenever' : 'Constantly';
    else base = cd ? `Every ${secs(cd)}${st ? ` (first after ${secs(st)})` : ''}` : 'Whenever it can';
  }
  if (!conds.length) return base;
  return base === 'Whenever' ? `Whenever ${conds.join(' and ')}` : `${base}, when ${conds.join(' and ')}`;
}

function targets(A, row) {
  const a = A.d.t.battle_target_select_ai.get(row.target_select_ai);
  if (!a || a.target_type === 4) return '';
  const n = a.target_number;
  const kind = a.target_type === 1 ? ['enemy', 'enemies'] : a.target_type === 3 ? ['other ally', 'other allies'] : ['ally', 'allies'];
  if (!n) return `all ${kind[1]}${a.target_type === 1 && !a.is_ingore_range ? ' in range' : ''}`;
  const key = list(a.select_order).map(Number).find((k) => k && SORT_WORD[k]);
  const asc = list(a.is_ascend_order).map(Number)[list(a.select_order).map(Number).indexOf(key)];
  const pick = key ? `${SORT_WORD[key][asc === 1 ? 1 : 0]} ` : '';
  return n === 1 ? `${pick ? pick + kind[0] : `one ${kind[0]}`}` : `${num(n)} ${pick ? pick.replace(/^the /, '') : ''}${kind[1]}`;
}

/** One effect in plain words, or '' when it is not worth saying. */
function phrase(f, A) {
  const side = SIDE[f.side] ?? 'units';
  const dur = f.dur ? ` ${f.dur}` : '';
  const v = f.value;
  if (f.kind.startsWith('stat:')) {
    const w = STAT_WORD[f.kind.slice(5)] ?? f.kind.slice(5);
    if (v === undefined) return `changes ${side === 'self' ? 'its own' : side + "'"} ${w}${dur}`;
    const flat = /\(flat\)/.test(f.text);
    const amt = `${v >= 0 ? '+' : '−'}${num(Math.abs(v))}${flat ? '' : '%'} ${w}`;
    return `${amt} to ${side}${dur}`;
  }
  switch (f.kind) {
    case 'damage': {
      const x = `${f.lo !== undefined && f.lo !== v ? `${num(f.lo / 100)}–` : ''}${num(v / 100)}× damage`;
      const rep = f.every ? ` every ${secs(f.every)}${f.life ? ` for ${secs(f.life)}` : ''}` : '';
      return `${x} to ${side === 'self' ? 'the user' : side}${f.area ? ` ${f.area}` : ''}${rep}${f.ignoresArmor ? ' (ignores armor)' : ''}`;
    }
    case 'knockback': return `${num(v)}% chance per hit to knock the target back${f.knockLen ? ` ${num(f.knockLen)}${f.knockDx > 0 ? ' (toward the enemy side)' : f.knockDx < 0 ? ' (toward the Griffin side)' : ''}` : ''}`;
    case 'surecrit': return `guaranteed crits for ${side}${dur}`;
    case 'hpshield': return `a ${v === undefined ? '' : num(v) + '-point '}shield for ${side}${dur}`;
    case 'dmgtaken': return v === undefined ? `changes damage taken by ${side}${dur}` : `${side} take ${v >= 0 ? '+' : '−'}${num(Math.abs(v))}% damage${dur}`;
    case 'invuln': return `${side} are immune to damage${dur}`;
    case 'forceshield': return `Force Shield for ${side}${dur}`;
    case 'stun': return `stuns ${side}${dur}`;
    case 'taunt': return `taunts ${side}${dur}`;
    case 'blind': return `blinds ${side}${dur}`;
    case 'phase': return `makes ${side} untargetable${dur}`;
    case 'disarm': return `disarms ${side}${dur}`;
    case 'silence': return `silences ${side}${dur}`;
    case 'cantdie': return `${side} cannot die${dur}`;
    case 'dot': return `damage over time to ${side}${dur}`;
    case 'cooldown': return v === undefined ? 'changes remaining cooldowns' : `${num(v)}% off remaining cooldowns`;
    case 'charges': return f.text.split(' for ')[0];
    case 'extra': return `${f.text.split(' for ')[0]} for ${side}${dur}`;
    case 'summon': return f.text.replace(/ \(summon \d+\)$/, '');
    case 'move': return f.text;
    default: return '';
  }
}

/** Plain summary for one kit entry, or '' if nothing can be said. */
export function plainSummary(A, e, row) {
  const facts = A.effects.filter((f) => f.entry === e);
  const seen = new Set(); const out = [];
  const equipGroups = A.noDescCheck ?? new Set();
  for (const f of facts) {
    let p = phrase(f, A);
    if (!p) continue;
    if (f.gate?.length) {
      const setters = f.gate.flatMap((id) => [...(A.markers.get(id)?.setBy ?? [])]);
      if (!setters.length) continue;   // can never happen for this unit
      p += setters.every((g) => equipGroups.has(g)) ? ' (with its exclusive gear)' : ' (under some conditions)';
    }
    if (seen.has(p)) continue;
    seen.add(p); out.push(p);
  }
  const w = when(A, e, row);
  const t = targets(A, row);
  if (!out.length) {
    // Skills whose only job is to add markers (switches and counters other skills check).
    const marks = [...A.markers.values()].some((m) => m.setBy.has(row.skill_group_id) || m.removedBy.has(row.skill_group_id));
    if (marks) return `${w}: only updates internal markers that other parts of the kit check.`;
    return row.type === 3 ? '' : `${w}: no direct effect of its own${t ? ` (targets ${t})` : ''}.`;
  }
  const shown = out.slice(0, 8);
  return `${w}${t ? `, targeting ${t}` : ''}: ${shown.join('; ')}${out.length > shown.length ? `; and ${out.length - shown.length} more` : ''}.`;
}
