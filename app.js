// Web front end: loads GFLData from GitHub, lists units, renders one unit's analysis.
import { loadData, analyzeUnit, GUN_TYPES, dollCategory, esc, UNIT_KINDS } from './analyzer.js';
import { renderDoll, renderScan, PAGE_CSS } from './render.js';
import { CATEGORIES } from './analyzer.js';
import { drawField, defaultScenario, pickTargets } from './field.js';

document.getElementById('page-css').textContent = PAGE_CSS;
const $ = (id) => document.getElementById(id);
const state = { data: null, unit: 'gun', types: new Set(), kinds: new Set(['normal', 'collab', 'mod']), current: null, scanRows: {}, scanKey: {} };
const KINDS = { normal: 'T-Doll', collab: 'Collab', mod: 'Neural Upgrade', variant: 'Variant' };
const HASH_KEY = { gun: 'id', enemy: 'enemy', sangvis: 'sangvis' };
const LEVELS = ['s1', 's2', 's3', 'sa'];
const LEVEL_DEFAULT = { s1: '10', s2: '10', s3: '5', sa: '5' };

// ---------------------------------------------------------------- URL state

function readHash() {
  const p = new URLSearchParams(location.hash.slice(1));
  let unit = null, id = null;
  for (const [k, v] of Object.entries(HASH_KEY)) if (p.get(v)) { unit = k; id = p.get(v); }
  const o = { unit, id, scan: p.get('scan'), region: p.get('region'), repo: p.get('repo') };
  for (const k of LEVELS) o[k] = p.get(k);
  return o;
}
function writeHash() {
  const p = new URLSearchParams();
  if (state.scanning) p.set('scan', state.scanScope);
  else if (state.current) p.set(HASH_KEY[state.unit], state.current);
  for (const k of LEVELS) if ($(k).value !== LEVEL_DEFAULT[k]) p.set(k, $(k).value);
  if ($('region').value !== 'en') p.set('region', $('region').value);
  if ($('repo').value.trim() !== 'randomqwerty/GFLData') p.set('repo', $('repo').value.trim());
  history.replaceState(null, '', `#${p}`);
}
const levels = () => ({ skill1: Number($('s1').value), skill2: Number($('s2').value), skill3: Number($('s3').value), advance: Number($('sa').value) });

// ---------------------------------------------------------------- data loading with a cache keyed by commit

const CACHE = 'gfl-skill-analyzer-v1';
async function latestCommit(repo) {
  try {
    const r = await fetch(`https://api.github.com/repos/${repo}/commits/main`, { headers: { Accept: 'application/vnd.github.sha' } });
    if (r.ok) return (await r.text()).trim();
  } catch { /* offline or rate-limited */ }
  try { return localStorage.getItem(`sha:${repo}`) || 'refs/heads/main'; } catch { return 'refs/heads/main'; }
}
async function cachedJson(url) {
  let cache = null;
  try { cache = await caches.open(CACHE); } catch { /* no Cache Storage (file://) */ }
  if (cache) {
    const hit = await cache.match(url);
    if (hit) return hit.json();
  }
  const r = await fetch(url);
  if (!r.ok) throw new Error(`${r.status} ${r.statusText} — ${url}`);
  if (cache && !url.includes('/refs/heads/')) { try { await cache.put(url, r.clone()); } catch { /* quota */ } }
  return r.json();
}
async function pruneCache(keepPrefix) {
  try {
    const cache = await caches.open(CACHE);
    for (const req of await cache.keys()) if (!req.url.startsWith(keepPrefix)) await cache.delete(req);
  } catch { /* ignore */ }
}

async function load({ fresh = false } = {}) {
  const repo = $('repo').value.trim() || 'randomqwerty/GFLData';
  const region = $('region').value;
  setStatus('Checking for the latest data…');
  if (fresh) { try { await caches.delete(CACHE); } catch { /* ignore */ } }
  const sha = await latestCommit(repo);
  try { if (sha !== 'refs/heads/main') localStorage.setItem(`sha:${repo}`, sha); } catch { /* ignore */ }
  const base = `https://raw.githubusercontent.com/${repo}/${sha}/${region}`;
  state.base = base; state.inTeam = null; state.inTeamLoading = null;
  await pruneCache(`https://raw.githubusercontent.com/${repo}/${sha}/`);
  try {
    let glossary = null;
    try { glossary = await (await fetch('glossary-en.json')).json(); } catch { /* labels stay in Chinese */ }
    state.data = await loadData(base, {
      glossary,
      fetchJson: cachedJson,
      onProgress: (d, n, t) => setStatus(`Loading tables ${d}/${n} (${t})…`),
    });
  } catch (e) {
    setStatus(`Could not load the data: ${e.message}`, true);
    return;
  }
  state.scanRows = {}; state.scanKey = {};
  const d = state.data;
  setStatus(`${d.dolls().length} dolls, ${d.units('enemy').length} enemies, ${d.units('sangvis').length} Coalition units · data ${sha.length === 40 ? sha.slice(0, 7) : 'latest'} · ${region.toUpperCase()}`);
  buildList();
  const h = readHash();
  if (h.scan) scan(h.scan);
  else if (h.id && d.unitRow(h.unit, h.id)) { setUnit(h.unit, false); show(Number(h.id)); }
}

function setStatus(msg, err = false) { const s = $('status'); s.textContent = msg; s.classList.toggle('err', err); }

// ---------------------------------------------------------------- list and filters

function chip(label, pressed, onclick) {
  const b = document.createElement('button');
  b.className = 'chip'; b.textContent = label; b.setAttribute('aria-pressed', String(pressed));
  b.onclick = () => onclick(b);
  return b;
}

function buildChips() {
  const uc = $('unitChips');
  for (const [k, v] of Object.entries({ gun: 'T-Dolls', enemy: 'Enemies', sangvis: 'Coalition' })) {
    uc.append(chip(v, k === state.unit, () => setUnit(k)));
  }
  const tc = $('typeChips');
  for (const [k, v] of Object.entries(GUN_TYPES)) {
    tc.append(chip(v, false, (b) => { if (state.types.has(k)) state.types.delete(k); else state.types.add(k); b.setAttribute('aria-pressed', String(state.types.has(k))); buildList(); }));
  }
  const kc = $('kindChips');
  for (const [k, v] of Object.entries(KINDS)) {
    kc.append(chip(v, state.kinds.has(k), (b) => { if (state.kinds.has(k)) state.kinds.delete(k); else state.kinds.add(k); b.setAttribute('aria-pressed', String(state.kinds.has(k))); buildList(); }));
  }
}

function setUnit(unit, rebuild = true) {
  state.unit = unit;
  const names = Object.keys(HASH_KEY);
  [...$('unitChips').children].forEach((b, i) => b.setAttribute('aria-pressed', String(names[i] === unit)));
  for (const el of document.querySelectorAll('.gun-only')) el.hidden = unit !== 'gun';
  for (const el of document.querySelectorAll('.sangvis-only')) el.hidden = unit !== 'sangvis';
  for (const el of document.querySelectorAll('.not-enemy')) el.hidden = unit === 'enemy';
  $('q').placeholder = unit === 'enemy' ? 'Name, code or number' : 'Name or number';
  $('qlabel').textContent = { gun: 'Find a doll', enemy: 'Find an enemy', sangvis: 'Find a Coalition unit' }[unit];
  if (rebuild) buildList();
}

function buildList() {
  if (!state.data) return;
  const d = state.data;
  const q = $('q').value.trim().toLowerCase();
  const out = [];
  for (const g of d.units(state.unit)) {
    let tag = '', ty = '';
    if (state.unit === 'gun') {
      const cat = dollCategory(g.id);
      if (!state.kinds.has(cat)) continue;
      if (state.types.size && !state.types.has(String(g.type))) continue;
      tag = cat === 'mod' ? ' <span class="dim">MOD</span>' : ''; ty = GUN_TYPES[g.type] ?? '';
    } else ty = state.unit === 'enemy' ? (g.boss_hp ? 'boss' : '') : '';
    const name = d.unitName(state.unit, g);
    const hay = [name, g.en_name, g.code].filter(Boolean).join(' ').toLowerCase();
    if (q && !(hay.includes(q) || String(g.id) === q)) continue;
    out.push(`<button data-id="${g.id}"${state.current === g.id ? ' aria-current="true"' : ''}><span class="id">${g.id}</span><span>${esc(name)}${tag}${state.unit === 'enemy' && g.code && g.code !== name ? ` <span class="dim">${esc(g.code)}</span>` : ''}</span><span class="ty">${ty}</span></button>`);
    if (out.length > 1500) break;
  }
  $('list').innerHTML = out.join('') || '<p class="dim" style="padding:8px 4px">Nothing matches.</p>';
}

// ---------------------------------------------------------------- one unit

function show(id) {
  if (!state.data) return;
  state.current = id; state.scanning = false;
  let html;
  try {
    const a = analyzeUnit(state.data, state.unit, id, { levels: levels() });
    html = renderDoll(a);
    document.title = `${a.name} · GFL Skill Analyzer`;
  } catch (e) {
    html = `<div class="doll"><p class="bad">Could not analyse ${esc(UNIT_KINDS[state.unit])} ${id}: ${esc(e.message)}</p></div>`;
    console.error(e);
  }
  $('main').innerHTML = html;
  for (const b of $('list').querySelectorAll('button')) b.toggleAttribute('aria-current', Number(b.dataset.id) === id);
  writeHash();
  $('main').scrollTop = 0; window.scrollTo({ top: 0 });
  if (matchMedia('(max-width:820px)').matches) setSide(false);
}

function setSide(open) {
  $('side').classList.toggle('collapsed', !open);
  $('toggleSide').textContent = open ? 'Hide list' : 'Show list';
  $('toggleSide').setAttribute('aria-expanded', String(open));
}

// ---------------------------------------------------------------- battlefield controls

/** enemy_in_team rows of one team, in table order (34 MB, so it is only downloaded when first asked for). */
async function teamRows(teamId) {
  if (!state.inTeam) {
    state.inTeamLoading ??= cachedJson(`${state.base}/stc/enemy_in_team.json`).then((rows) => {
      const m = new Map();
      for (const r of rows) { if (!m.has(r.enemy_team_id)) m.set(r.enemy_team_id, []); m.get(r.enemy_team_id).push(r); }
      for (const l of m.values()) l.sort((a, b) => a.id - b.id);
      state.inTeam = m;
    });
    await state.inTeamLoading;
  }
  return state.inTeam.get(Number(teamId)) ?? null;
}

/** Enemy units of a team for field.js: listed order, links, and max HP at the row's level. */
function teamUnits(rows) {
  const d = state.data;
  return rows.map((r, i) => {
    const e = d.unitRow('enemy', r.enemy_character_type_id);
    const per = e ? d.enemyStat(e, 'maxlife', r.level) : 0;
    return { side: 'enemy', pos: [r.coordinator_x, r.coordinator_y], links: r.number || 1, order: i + 1, wave: r.batch,
      name: e ? d.unitName('enemy', e) : `enemy ${r.enemy_character_type_id}`, hp: per * (r.number || 1), typeId: r.enemy_character_type_id };
  });
}

const keyText = (k) => `${k.highFirst ? 'highest' : 'lowest'} ${k.name}`;

/** Give an opened "Show on the battlefield" box controls: user and target positions, or a real enemy team. */
function wireField(det) {
  if (det.dataset.wired) return;
  det.dataset.wired = '1';
  const spec = JSON.parse(det.dataset.spec);
  const side = det.dataset.side;
  const sc = defaultScenario(side);
  const box = document.createElement('div');
  box.className = 'fieldctl';
  const slotSel = (label, cur) => `<label>${label} <select data-k="${label}">${[1, 2, 3, 4, 5, 6, 7, 8, 9].map((s) => `<option${s === cur ? ' selected' : ''}>${s}</option>`).join('')}</select></label>`;
  const xy = (label, p) => `<label>${label} x <input type="number" step="0.5" data-k="${label}x" value="${p[0]}"></label><label>y <input type="number" step="0.5" data-k="${label}y" value="${p[1]}"></label>`;
  const team = `<label>Enemy team <input type="number" data-k="team" placeholder="id" style="width:7em"></label><label data-show="wave" hidden>Wave <select data-k="wave"></select></label>`;
  box.innerHTML = side === 'ally'
    ? `${slotSel('User slot', 5)}${team}<label>Target <select data-k="tmode"><option value="rule">by the skill’s target rule</option><option value="manual">manual</option></select></label><span data-show="manual" hidden>${xy('Target', sc.target.pos)}</span><label><input type="checkbox" data-k="full"> Fill every slot</label>`
    : `${team}<span data-show="userxy">${xy('User', sc.caster.pos)}</span><label data-show="usersel" hidden>User <select data-k="usersel"></select></label>${slotSel('Target slot', 6)}`;
  const note = document.createElement('p');
  note.className = 'legend';
  det.querySelector('svg').before(box, note);
  let units = null;   // the loaded team, if any
  const v = (k) => box.querySelector(`[data-k="${k}"]`);
  const show = (k, on) => { const el = box.querySelector(`[data-show="${k}"]`); if (el) el.hidden = !on; };
  const redraw = () => {
    const s = defaultScenario(side);
    const msg = [];
    if (units) {
      const wave = v('wave').value;
      s.enemies = units.filter((u) => wave === '' || String(u.wave) === wave).map((u) => ({ ...u, pos: [...u.pos] }));
    }
    if (side === 'ally') {
      const slot = Number(v('User slot').value);
      const full = v('full').checked;
      for (const a of s.allies) a.links = a.slot === slot ? 5 : full ? 5 : 0;
      s.caster = s.allies[slot - 1];
      const manual = v('tmode').value === 'manual';
      show('manual', manual);
      if (manual) {
        const p = [Number(v('Targetx').value), Number(v('Targety').value)];
        s.target = s.enemies.find((e) => e.pos[0] === p[0] && e.pos[1] === p[1]);
        if (!s.target) { s.target = { side: 'enemy', pos: p, links: 1 }; s.enemies = [...s.enemies, s.target]; }
      } else if (spec.aim) {
        const { picked, unsupported } = pickTargets(spec.aim, s);
        s.targets = picked; s.target = picked[0] ?? null;
        const keys = spec.aim.keys.filter((k) => k.key);
        const who = spec.aim.type === 1 ? (spec.aim.n === 1 ? 'enemy' : 'enemies') : spec.aim.n === 1 ? 'ally' : 'allies';
        msg.push(`Target rule: ${spec.aim.type === 4 ? 'the user' : `${spec.aim.n || 'all'} ${who}`}${keys.length ? `, ${keys.map(keyText).join(', then ')} first` : ''}; ties go to the unit listed first${units ? ' in enemy_in_team' : ''}. Range is not checked.`);
        if (unsupported.length) msg.push(`It also sorts by ${spec.aim.keys.filter((k) => unsupported.includes(k.key)).map((k) => k.name).join(', ')}, which the drawing cannot evaluate, so that step keeps the listed order.`);
        msg.push(picked.length ? `Picked: ${picked.map((u) => u.name ? `${u.order ? u.order + '. ' : ''}${u.name}` : `the unit at (${u.pos.join(', ')})`).join('; ')}.` : 'No unit qualifies.');
      }
    } else {
      if (units && s.enemies.length) s.caster = s.enemies[Math.min(Number(v('usersel').value) || 0, s.enemies.length - 1)];
      else s.caster.pos = [Number(v('Userx').value), Number(v('Usery').value)];
      s.target = s.allies[Number(v('Target slot').value) - 1];
    }
    note.textContent = msg.join(' ');
    det.querySelector('svg').outerHTML = drawField(spec, s).svg;
  };
  const loadTeam = async () => {
    const id = v('team').value.trim();
    units = null; show('wave', false); show('usersel', false); show('userxy', true);
    if (id) {
      note.textContent = state.inTeam ? '' : 'Loading enemy_in_team.json (about 34 MB, once)…';
      let rows = null;
      try { rows = await teamRows(id); } catch (e) { note.textContent = `Could not load enemy teams: ${e.message}`; return; }
      if (!rows) { note.textContent = `There is no enemy team ${id}.`; return; }
      units = teamUnits(rows);
      const waves = [...new Set(units.map((u) => u.wave))].sort((a, b) => a - b);
      v('wave').innerHTML = waves.map((w) => `<option value="${w}">${w}</option>`).join('');
      show('wave', waves.length > 1);
      if (side === 'enemy') {
        const me = Number(det.closest('.doll')?.dataset.unit);
        const fill = () => {
          const w = v('wave').value;
          const list = units.filter((u) => String(u.wave) === w);
          v('usersel').innerHTML = list.map((u, i) => `<option value="${i}"${u.typeId === me ? ' selected' : ''}>${u.order}. ${esc(u.name)}</option>`).join('');
        };
        fill(); v('wave').addEventListener('change', fill);
        show('usersel', true); show('userxy', false);
      }
    }
    redraw();
  };
  box.addEventListener('input', (e) => { if (e.target.dataset.k !== 'team') redraw(); });
  v('team').addEventListener('change', loadTeam);
  redraw();
}

// ---------------------------------------------------------------- bug scan

const SCOPE_NAME = { gun: 'dolls', enemy: 'enemies', sangvis: 'Coalition units', all: 'all units' };

async function scan(scope = 'gun') {
  if (!state.data) return;
  if (!SCOPE_NAME[scope]) scope = 'gun';
  state.scanning = true; state.scanScope = scope; state.current = null; writeHash();
  const lv = levels();
  const key = JSON.stringify(lv);
  const main = $('main');
  const kinds = scope === 'all' ? ['gun', 'enemy', 'sangvis'] : [scope];
  for (const kind of kinds) {
    if (state.scanKey[kind] === key) continue;
    const units = state.data.units(kind);
    const rows = [];
    for (let i = 0; i < units.length; i++) {
      if (i % 20 === 0) { main.innerHTML = `<div class="doll"><h1>Bug scan</h1><p class="legend">Checking ${i} of ${units.length} ${SCOPE_NAME[kind]}…</p></div>`; await new Promise((r) => setTimeout(r, 0)); }
      try {
        const a = analyzeUnit(state.data, kind, units[i].id, { levels: lv });
        for (const n of a.notes) if (n.sev !== 'tech') rows.push({ kind, id: units[i].id, name: a.name, sev: n.sev, cat: n.cat ?? 'other', text: n.text });
      } catch (e) { rows.push({ kind, id: units[i].id, name: state.data.unitName(kind, units[i]), sev: 'bug', cat: 'other', text: `The analyzer failed on this unit: ${esc(e.message)}` }); }
    }
    state.scanRows[kind] = rows; state.scanKey[kind] = key;
  }
  const all = kinds.flatMap((k) => state.scanRows[k]);
  const cats = [...new Set(all.map((r) => r.cat))];
  main.innerHTML = `<div class="doll"><h1>Bug scan <span class="meta">${SCOPE_NAME[scope]} · skill levels ${lv.skill1}/${lv.skill2}</span></h1>
    <div class="btnrow"><label>Units <select id="scanScope">${Object.entries(SCOPE_NAME).map(([k, v]) => `<option value="${k}"${k === scope ? ' selected' : ''}>${v}</option>`).join('')}</select></label>
    <label>Show <select id="scanSev"><option value="bug">likely bugs</option><option value="warn">bugs and checks</option><option value="info">everything</option></select></label>
    <label>Category <select id="scanCat"><option value="">all</option>${cats.map((c) => `<option value="${c}">${esc(CATEGORIES[c] ?? 'Other')}</option>`).join('')}</select></label></div>
    <div id="scanOut"></div></div>`;
  const draw = () => { $('scanOut').innerHTML = renderScan(all, { sev: $('scanSev').value, cat: $('scanCat').value }); };
  $('scanSev').onchange = draw; $('scanCat').onchange = draw; $('scanScope').onchange = () => scan($('scanScope').value); draw();
  document.title = 'Bug scan · GFL Skill Analyzer';
}

// ---------------------------------------------------------------- wiring

buildChips();
const h = readHash();
for (const k of LEVELS) if (h[k]) $(k).value = h[k];
if (h.region) $('region').value = h.region;
if (h.repo) $('repo').value = h.repo;
setUnit(h.unit ?? 'gun', false);
for (const k of LEVELS) {
  $(`${k}v`).textContent = $(k).value;
  $(k).addEventListener('input', () => { $(`${k}v`).textContent = $(k).value; });
  $(k).addEventListener('change', () => { if (state.scanning) scan(state.scanScope); else if (state.current) show(state.current); else writeHash(); });
}
$('q').addEventListener('input', buildList);
$('q').addEventListener('keydown', (e) => { if (e.key === 'Enter') { const b = $('list').querySelector('button'); if (b) show(Number(b.dataset.id)); } });
$('list').addEventListener('click', (e) => { const b = e.target.closest('button[data-id]'); if (b) show(Number(b.dataset.id)); });
$('region').addEventListener('change', () => { writeHash(); load(); });
$('repo').addEventListener('change', () => { writeHash(); load(); });
$('reload').addEventListener('click', () => load({ fresh: true }));
$('scanBtn').addEventListener('click', () => scan(state.unit));
$('toggleSide').addEventListener('click', () => setSide($('side').classList.contains('collapsed')));
$('main').addEventListener('toggle', (e) => { if (e.target.matches?.('details.field') && e.target.open) wireField(e.target); }, true);
$('main').addEventListener('click', (e) => {
  const a = e.target.closest('a[href^="#"]');
  if (!a || a.getAttribute('href').includes('=')) return;
  e.preventDefault();
  const t = document.getElementById(a.getAttribute('href').slice(1));
  if (t) { t.scrollIntoView({ behavior: 'smooth', block: 'center' }); t.classList.add('flash'); setTimeout(() => t.classList.remove('flash'), 1200); }
});
window.addEventListener('hashchange', () => {
  const x = readHash();
  if (x.scan && !(state.scanning && state.scanScope === x.scan)) scan(x.scan);
  else if (x.id && (Number(x.id) !== state.current || x.unit !== state.unit)) { setUnit(x.unit); show(Number(x.id)); }
});
load();
