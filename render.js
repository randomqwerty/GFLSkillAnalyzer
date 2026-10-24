// HTML for one analysed unit (shared by the web page and build-report.mjs).
import { esc, CATEGORIES, UNIT_KINDS } from './analyzer.js';
import { FIELD_CSS } from './field.js';

export const PAGE_CSS = `
:root{--bg:#fbfbf9;--fg:#1d1f21;--dim:#6b6f76;--line:#e1e1dc;--card:#fff;--accent:#2f6fb0;--code:#107c10;
--bug:#b3261e;--bugbg:#fdecea;--warn:#8a5a00;--warnbg:#fff4dc;--info:#2f5f8f;--infobg:#eaf2fb;--alt:#7a5aa6;--quote:#f3f3ef}
@media (prefers-color-scheme:dark){:root:not([data-theme="light"]){--bg:#16181b;--fg:#e4e4e2;--dim:#9aa0a6;--line:#30343a;--card:#1d2024;--accent:#7fb2ea;--code:#6fcf74;
--bug:#ff8a80;--bugbg:#3a1c1a;--warn:#f2c46b;--warnbg:#3a2f15;--info:#9cc4ee;--infobg:#1b2a3a;--alt:#c4a6ef;--quote:#23262b}}
:root[data-theme="dark"]{--bg:#16181b;--fg:#e4e4e2;--dim:#9aa0a6;--line:#30343a;--card:#1d2024;--accent:#7fb2ea;--code:#6fcf74;
--bug:#ff8a80;--bugbg:#3a1c1a;--warn:#f2c46b;--warnbg:#3a2f15;--info:#9cc4ee;--infobg:#1b2a3a;--alt:#c4a6ef;--quote:#23262b}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.5 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}
a{color:var(--accent);text-decoration:none} a:hover{text-decoration:underline}
code{font-family:ui-monospace,Consolas,monospace;color:var(--code);font-size:.92em;overflow-wrap:anywhere}
.doll{max-width:1100px;margin:0 auto;padding:16px}
.doll h1{font-size:1.5rem;margin:.2em 0}
.doll h2{font-size:1.15rem;margin:1.6em 0 .5em;border-bottom:1px solid var(--line);padding-bottom:.2em}
.meta{color:var(--dim)}
.skill-card{background:var(--card);border:1px solid var(--line);border-radius:8px;padding:10px 14px;margin:10px 0}
.skill-card .skill-card{margin:8px 0;border-left:3px solid var(--accent)}
.skill-head{display:flex;flex-wrap:wrap;gap:.2em .6em;align-items:baseline}
.sname{font-weight:650;font-size:1.05rem}
.sid,.via{color:var(--dim);font-size:.85rem}
.via{border:1px solid var(--line);border-radius:10px;padding:0 .5em}
blockquote.desc{margin:.5em 0;padding:.4em .8em;background:var(--quote);border-radius:6px;font-style:italic}
.why{color:var(--dim);font-size:.88rem;margin:.3em 0}
.sect{margin:.5em 0}
.sect-t{font-weight:600;font-size:.82rem;text-transform:uppercase;letter-spacing:.04em;color:var(--dim)}
.sect ul,.skill-card ul{margin:.2em 0;padding-left:1.3em}
.sect li{margin:.15em 0}
.binfo{color:var(--dim)}
.binfo b{color:var(--fg)}
.cn{color:var(--dim);font-size:.85em}
.bt{font-size:.78em;border:1px solid var(--line);border-radius:8px;padding:0 .35em;color:var(--dim)}
.alt{color:var(--alt);font-size:.88em}
.dim{color:var(--dim)}
.bad{color:var(--bug)}
.ref{color:var(--dim);font-size:.9rem}
.flag{border-radius:4px;padding:0 .3em}
.flag-bug{background:var(--bugbg);color:var(--bug)}
.flag-warn{background:var(--warnbg);color:var(--warn)}
.flag-info{background:var(--infobg);color:var(--info)}
.flag-tech{background:var(--quote);color:var(--dim);font-size:.85em}
details.tech{margin:.6em 0;color:var(--dim);font-size:.9rem}
.notes li{margin:.25em 0}
.qcat{margin:.4em 0 .8em}
table.scan td:nth-child(1){white-space:nowrap}
table.scan td:nth-child(2),table.scan td:nth-child(3){white-space:nowrap}
.missions{color:var(--dim);font-size:.85em}
table{border-collapse:collapse;width:100%;font-size:.9rem;margin:.4em 0}
th,td{border:1px solid var(--line);padding:4px 6px;text-align:left;vertical-align:top}
th{background:var(--quote)}
.tablewrap{overflow-x:auto}
a.formula{color:var(--code)}
.legend{font-size:.88rem;color:var(--dim)}
@media (max-width:640px){.doll{padding:12px 16px}.skill-card{padding:8px 10px}}
.hidden-list li{margin:.25em 0}
.plain{margin:.4em 0;padding:.35em .7em;border-left:3px solid var(--code);background:var(--card)}
${FIELD_CSS}`;

const SEV = { bug: 'Likely bug', warn: 'Check', info: 'Note' };

const CATEGORY_NAME = { normal: 'T-Doll', collab: 'Collab doll', mod: 'Neural Upgrade', variant: 'Variant', story: 'Story copy', enemy: 'Enemy', sangvis: 'Coalition unit' };

/** Effects none of the unit's texts state; shared class mechanics are folded away. */
function renderHidden(a) {
  const list = a.hidden ?? [];
  if (!list.length) return '';
  const item = (x) => `<li><b>${esc(x.entries.join(', '))}</b> <span class="dim">(skill ${x.group})</span>: ${x.text} <span class="dim">— ${esc(x.why)}</span></li>`;
  const own = list.filter((x) => !x.shared); const shared = list.filter((x) => x.shared);
  const h = [`<h2>Hidden effects</h2><p class="legend">What the kit does that none of its in-game texts states${a.kind === 'enemy' ? ' (for enemies, the encyclopedia entries)' : ''}. An effect counts as stated when a sentence names it and quotes its number.</p>`];
  if (own.length) h.push(`<ul class="hidden-list">${own.map(item).join('')}</ul>`);
  else h.push('<p class="dim">None specific to this unit.</p>');
  if (shared.length) h.push(`<details class="tech"><summary>Shared mechanics (${shared.length})</summary><p class="legend">From skills that at least eight units share, such as class reload or ammo rules.</p><ul class="hidden-list">${shared.map(item).join('')}</ul></details>`);
  return h.join('');
}

export function renderDoll(a, { standalone = false } = {}) {
  const g = a.gun;
  const h = [];
  h.push(`<div class="doll" data-unit="${g.id}">`);
  h.push(`<h1>${esc(a.name)} <span class="meta">#${g.id}${a.type ? ` · ${esc(a.type)}` : ''} · ${esc(CATEGORY_NAME[a.category] ?? UNIT_KINDS[a.kind] ?? '')}</span></h1>`);
  h.push(`<details class="legend"><summary>How to read this page</summary><ul>
<li>Times are in seconds; the battle runs at 30 frames per second.</li>
<li><b>Percentage buffs multiply</b> with each other, with their own stacks and with tile bonuses: two +20% buffs give ×1.44, not +40%. Flat (+N) buffs are added after all percentages.</li>
<li><b>Stacking</b>: a buff that takes “up to N stacks” gets a separate copy with its own timer each time it is applied; past N the oldest copies are dropped. “Refreshes when reapplied” means it holds one copy and a new application restarts its timer. Some buffs share their stack limit with other buffs of the same group.</li>
<li>Values are shown at the chosen skill levels. <span class="alt">Purple notes</span> give the level 1 → max range, night or special values, and formula ranges.</li>
<li><b>Markers</b> are buffs with no effect of their own; the kit uses them as switches and counters. The table at the bottom shows which skills add, remove and check each one.</li>
<li>Grey Chinese text is the developers' internal label, shown for reference.</li>
<li><b>Show on the battlefield</b> under an area effect draws where it lands in a sample layout and which dummy links it reaches.</li></ul></details>`);
  const notes = a.notes.filter((n) => n.sev !== 'tech');
  if (notes.length) h.push(`<h2>Quirks found</h2>${renderNotes(notes)}`);
  if (a.untraced?.length) h.push(`<details class="tech"><summary>Description numbers not traced (${a.untraced.length})</summary><p class="legend">Numbers in the in-game text that the analyzer could not find among the skill's values. Most are results of formulas, equipment stats or summon stats rather than text errors.</p><ul class="notes">${a.untraced.map((t) => `<li>${t}</li>`).join('')}</ul></details>`);
  const tech = a.notes.filter((n) => n.sev === 'tech');
  if (tech.length) h.push(`<details class="tech"><summary>Harmless data errors (${tech.length})</summary><ul class="notes">${tech.map((n) => `<li>${n.text}</li>`).join('')}</ul></details>`);
  h.push(renderHidden(a));
  if (a.kitTexts?.length) h.push(`<h2>Encyclopedia</h2><ul class="hidden-list">${a.kitTexts.map((k) => `<li><b>${esc(k.name)}</b>: ${esc(k.text)}</li>`).join('')}</ul>`);
  h.push(`<h2>Skills</h2>`);
  for (const s of a.sections.filter((x) => !x.equip)) h.push(s.html);
  const eq = a.sections.filter((x) => x.equip);
  if (eq.length) {
    h.push(`<h2>With exclusive equipment</h2><p class="legend">Skills that only exist while the doll wears its exclusive equipment or set.</p>`);
    for (const s of eq) h.push(s.html);
  }
  if (a.missionCount) h.push(`<h2>Mission-specific bonuses (${a.missionCount})</h2><p class="legend">Passive skills that only switch on in certain missions. Each fires once at the start of battle.</p><div class="tablewrap">${a.missionHtml}</div>`);
  if (a.markersHtml) h.push(`<h2>Markers and counters</h2><p class="legend">Buffs with no effect of their own. The kit uses them as switches and counters: one skill adds stacks, another checks them.</p><div class="tablewrap">${a.markersHtml}</div>`);
  if (a.formulasHtml) h.push(`<h2>Formulas</h2><p class="legend"><code>@</code> = the skill's user, <code>#</code> = the target, <code>$N</code> = a value passed in by the game (for damage formulas, <code>$1</code> is the damage so far).</p><div class="tablewrap">${a.formulasHtml}</div>`);
  h.push(`</div>`);
  const body = h.join('\n');
  if (!standalone) return body;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(a.name)} skills</title><style>${PAGE_CSS}</style></head><body>${body}</body></html>`;
}

const SEV_ORDER = { bug: 0, warn: 1, info: 2 };
const catName = (c) => CATEGORIES[c] ?? 'Other';

/** Quirk notes grouped by category, most severe first. */
export function renderNotes(notes) {
  const groups = new Map();
  for (const n of [...notes].sort((x, y) => SEV_ORDER[x.sev] - SEV_ORDER[y.sev])) {
    const c = n.cat ?? 'other';
    if (!groups.has(c)) groups.set(c, []);
    groups.get(c).push(n);
  }
  const worst = (l) => Math.min(...l.map((n) => SEV_ORDER[n.sev]));
  return [...groups].sort((a, b) => worst(a[1]) - worst(b[1])).map(([c, l]) => `<div class="qcat"><div class="sect-t">${esc(catName(c))}</div><ul class="notes">${l.map((n) => `<li><span class="flag flag-${n.sev}">${SEV[n.sev]}</span> ${n.text}</li>`).join('')}</ul></div>`).join('');
}

/** Roster-wide table of quirks: rows = { id, name, type, sev, cat, text }. */
export function renderScan(rows, { sev = 'bug', cat = '' } = {}) {
  const shown = rows.filter((r) => SEV_ORDER[r.sev] <= SEV_ORDER[sev] && (!cat || r.cat === cat));
  const counts = {};
  for (const r of rows) counts[r.sev] = (counts[r.sev] ?? 0) + 1;
  const body = shown.map((r) => `<tr><td><a href="#${r.kind && r.kind !== 'gun' ? r.kind : 'id'}=${r.id}">${esc(r.name)}</a> <span class="dim">#${r.id}${r.kind && r.kind !== 'gun' ? ` · ${esc(UNIT_KINDS[r.kind])}` : ''}</span></td><td><span class="flag flag-${r.sev}">${SEV[r.sev]}</span></td><td>${esc(catName(r.cat))}</td><td>${r.text}</td></tr>`).join('');
  return `<p class="legend">${counts.bug ?? 0} likely bugs, ${counts.warn ?? 0} checks and ${counts.info ?? 0} notes across ${new Set(rows.map((r) => `${r.kind}:${r.id}`)).size} units. Showing ${shown.length}.</p><div class="tablewrap"><table class="scan"><thead><tr><th>Unit</th><th>Severity</th><th>Category</th><th>Finding</th></tr></thead><tbody>${body}</tbody></table></div>`;
}

export function renderIndex(summary) {
  const rows = summary.map((s) => {
    const c = { bug: 0, warn: 0, info: 0, tech: 0 };
    for (const n of s.notes) c[n.sev]++;
    return `<tr><td>${s.id}</td><td><a href="${esc(s.file)}">${esc(s.name)}</a></td><td>${esc(s.type)}</td><td>${esc(s.category)}</td><td>${c.bug || ''}</td><td>${c.warn || ''}</td><td>${c.info || ''}</td></tr>`;
  });
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Doll skill analysis</title><style>${PAGE_CSS}</style></head><body><div class="doll"><h1>Doll skill analysis</h1><div class="tablewrap"><table><thead><tr><th>ID</th><th>Doll</th><th>Type</th><th>Kind</th><th>Likely bugs</th><th>Checks</th><th>Notes</th></tr></thead><tbody>${rows.join('')}</tbody></table></div></div></body></html>`;
}
