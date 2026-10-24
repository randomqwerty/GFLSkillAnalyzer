// Hidden effects: what a unit's kit does that none of its in-game texts states.
//
// While the page is written, Analysis.fact() records every effect (stat buffs, shields, crowd control,
// knock-back chances, damage hits, summons, movement) together with the kit entry it belongs to and the number
// a text would quote. An effect counts as stated when one clause of any text of the kit (skill descriptions,
// equipment and set texts) names that kind of effect and, if the effect has a number, quotes it. The word lists
// are English, so with other server languages only effects of entries that have no text at all are reported.
import { esc } from './analyzer.js';

const WORDS = {
  'stat:pow': /damage|firepower|\bfp\b|\bdmg\b/i, 'stat:hit': /accuracy|\bacc\b/i, 'stat:dodge': /evasion|evade|\beva\b/i,
  'stat:rate': /rate of fire|\brof\b|fire rate|attack speed/i, 'stat:move': /move|movement|speed/i,
  'stat:crit': /crit/i, 'stat:critdmg': /crit/i, 'stat:armor': /armou?r/i, 'stat:ap': /armou?r pen|penetrat|\bap\b/i,
  'stat:dmgtaken': /damage|dmg/i, 'stat:shieldbreak': /shield/i, 'stat:range': /range/i, 'stat:cdr': /cooldown|\bcd\b/i,
  'stat:tenacity': /tenacity/i, 'stat:immunity': /immun|resist/i, 'stat:night': /night/i,
  invuln: /invulnerab|immune|invincib|cannot (be|take) dam|no damage/i, hpshield: /shield|barrier/i, dmgtaken: /damage|dmg|vulnerab/i,
  forceshield: /force shield|shield/i, stun: /stun|paraly|immobil/i, taunt: /taunt|provok/i, blind: /blind/i, phase: /untargetable|cannot be targeted|stealth|invisib/i,
  disarm: /disarm/i, silence: /silenc/i, cantdie: /cannot die|survive|not die|endure|last stand/i, dot: /burn|bleed|over time|per second|every \d/i,
  cooldown: /cooldown|\bcd\b/i, charges: /charge/i, extra: /additional|extra|bonus/i, dmgrecalc: /damage|dmg/i, smoke: /smoke/i,
  knockback: /knock|push(es)? back|repel/i, surecrit: /crit/i, forcedskill: /./, damage: /damage|dmg|deal|explo|attack|shot|hit|strike/i,
  summon: /summon|deploy|call|drone|turret|construct/i, move: /move|dash|charge|jump|retreat|advance|push|pull|knock|teleport/i,
};
// Sentences: a '.' only ends one before a space or the end, so "4.5x/1.8x" stays whole.
const clausesOf = (t) => String(t ?? '').replace(/<[^>]+>/g, ' ').split(/\.(?=\s|$)|[;。；！？!?\n]/).map((s) => s.trim()).filter(Boolean);
const numbersIn = (s) => (s.match(/\d+(?:\.\d+)?/g) ?? []).map(Number);
const near = (a, b) => Math.abs(a - b) < 0.051 || Math.abs(a - b) <= Math.abs(b) * 0.001;
/** Does a clause quote v (or its absolute value, its x100 / /100 form, or a whole-number rounding)? */
function quotes(clause, v) {
  const ns = numbersIn(clause);
  const want = [v, Math.abs(v), Math.abs(v) * 100, Math.abs(v) / 100, Math.trunc(Math.abs(v)), Math.round(Math.abs(v))];
  return ns.some((n) => want.some((w) => near(n, w)));
}
const english = (texts) => { const s = texts.join(' '); return s.length > 0 && (s.match(/[A-Za-z]/g) ?? []).length > s.length * 0.4; };

/**
 * A: the Analysis (effects, d, kind). entries: the kit entries. Returns { list, notes }:
 * list items { entry, text, why, shared } for the page; notes are quirk notes in category 'hidden'.
 */
export function findHidden(A, entries) {
  const d = A.d;
  const texts = [];
  const entryText = new Map();
  for (const e of entries) {
    const r = d.skillRow(e.group, e.level);
    const own = [r ? d.text(r.description) : '', ...(e.text ?? [])].filter(Boolean);
    entryText.set(e, own);
    texts.push(...own);
  }
  for (const k of A.kitTexts ?? []) texts.push(k.text);
  const en = english(texts);
  const clauses = texts.flatMap(clausesOf);
  const seen = new Map();
  const list = [];
  for (const f of A.effects) {
    const e = f.entry;
    // A normal attack's own plain hit is not an effect worth stating.
    if (f.kind === 'damage' && (f.rowType === 3 || e.field === 'normal_attack') && near(f.value ?? 100, 100)) continue;
    if (f.kind === 'damage' && !(f.value > 0)) continue;
    if (f.kind === 'ignorearmor' && e.field !== 'normal_attack') continue;
    if (f.kind === 'forcedskill') continue;
    // Effects whose stack count or buff choice reads a marker this unit's kit never applies cannot happen for
    // this unit (for example another doll's set bonus inside a shared skill).
    if (f.gate?.some((id) => !(A.markers.get(id)?.setBy.size))) continue;
    const key = `${f.kind}|${f.value}|${f.side}|${f.text.replace(/\(.*\)$/, '')}`;
    const dup = seen.get(key);
    if (dup) { if (!dup.entries.includes(e.label)) dup.entries.push(e.label); continue; }
    const hasOwnText = (entryText.get(e) ?? []).length > 0;
    let why = '';
    if (en) {
      const re = WORDS[f.kind] ?? null;
      if (!re) continue;
      const named = clauses.filter((c) => re.test(c));
      if (named.length && (f.value === undefined || named.some((c) => quotes(c, f.value) || (f.lo !== undefined && f.lo > 0 && quotes(c, f.lo))))) continue;
      why = named.length ? 'the text mentions this kind of effect but not this value' : 'no text of the kit mentions it';
    } else {
      if (hasOwnText) continue;
      why = 'its skill has no text';
    }
    const shared = d.sharedCount(e.group) >= 8 || d.refCount(f.ref) >= 20;
    const item = { entries: [e.label], group: e.group, field: e.field, kind: f.kind, value: f.value, text: f.text, why, shared, attack: f.rowType === 3 };
    seen.set(key, item);
    list.push(item);
  }
  const notes = [];
  for (const h of list) {
    if (h.shared) continue;
    // Enemies have no skill texts except the encyclopedia, so their findings stay notes.
    // Attack damage ratios are rarely quoted anywhere, so an unquoted one is only a note.
    const sev = A.kind === 'enemy' || (h.kind === 'damage' && (h.attack || h.value === 100)) ? 'info' : ['knockback', 'stat:pow', 'stat:rate', 'stat:hit', 'stat:dodge', 'stat:armor', 'stat:crit', 'stat:critdmg', 'surecrit', 'dmgtaken', 'hpshield', 'invuln', 'stun', 'damage', 'cantdie', 'forceshield'].includes(h.kind) ? 'warn' : 'info';
    notes.push({ sev, cat: 'hidden', text: `<b>${esc(h.entries.join(', '))}</b> (skill ${h.group}): ${h.text} — ${h.why}.` });
  }
  return { list, notes };
}

