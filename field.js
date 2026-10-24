// Battlefield geometry and an SVG drawing of where a creation (battle_creation row) lands and what it hits.
// Coordinates are the enemy map's: x grows toward the enemy side, y is the enemy_in_team coordinator_y.
// Every rule below was read from the EN PC client; the method is named in brackets.

// Ally slot positions. A grid id (1-9) is GridPos(x = (id-1)/3, y = (id-1)%3) [GridPos..ctor(int)], placed at
// world (2.4x - 1.7, 4.2y - 6) [BattleData.GetTSPositionFromGrid] relative to the friendly team origin
// (-3.76, 0) [BattleFieldTeamHolderNew..ctor]. Enemies sit at (coordinator_x, coordinator_y) relative to the enemy
// origin (-3.76, -5.91) [BattleCharacterData.InitStartingPos]. In enemy coordinates a slot is therefore at
// (2.4x - 1.7, 4.2y - 0.09), and the world origin is at (3.76, 5.91).
// Slots are numbered like a numpad, as GFLMaps does: 1-3 the bottom row, 7-9 the top row, 3/6/9 the front column.
// Numpad slot n is grid column (n-1)%3, row floor((n-1)/3), i.e. grid id 3*column + row + 1.
export const SLOT = { dx: 2.4, dy: 4.2, x0: -1.7, y0: -0.09 };
export const WORLD0 = [3.76, 5.91];
// Dummy-link offsets from the leader, friendly side [BattleData..cctor: arrPrefabFriendlyMemberPosition].
// Enemy links all stand on the leader's spot (arrPrefabEnemyMemberPosition is all zeros).
export const LINKS = [[0, 0], [-1.5, -1], [-1.5, 1], [-0.75, -0.6], [-0.75, 0.6]];
// A circle reaches a unit when distance <= radius + UNIT_RADIUS. With more than 35 units on a side the game only
// tests unit centres, with 1.82 instead [BattleFieldTeamHolderNew.UpdateTargetsInRange].
export const UNIT_RADIUS = 0.4;
export const CELL = [2.4, 4.2];   // effect_area 3 cells [BattleFieldTeamHolderNew.GetCenterOffsetbyAreaPos]

export function slotPos(slot) {
  const c = (slot - 1) % 3, r = Math.floor((slot - 1) / 3);
  return [SLOT.x0 + c * SLOT.dx, SLOT.y0 + r * SLOT.dy];
}

// Range lines as GFLMaps draws them: where an enemy of range 2 or 3 reaches the Griffin front column, standing
// still or while moving.
export const RANGE_LINES = [[8.76, 'range 2, moving'], [9.76, 'range 2, standing'], [10.76, 'range 3, moving'], [11.76, 'range 3, standing']];

/** Offset of an effect_area 3 cell (1-25, 13 = centre): x varies fastest. */
export function cellOffset(id) {
  return [((id - 1) % 5 - 2) * CELL[0], (Math.floor((id - 1) / 5) - 2) * CELL[1]];
}

/** Units on the field for a scenario. side: 'ally' | 'enemy'. */
export function defaultScenario(casterSide = 'ally') {
  const allies = [];
  for (let s = 1; s <= 9; s++) allies.push({ side: 'ally', slot: s, pos: slotPos(s), links: s === 5 ? 5 : 0 });
  const enemies = [[12.5, 4.11], [13.5, 1.5], [13.5, 6.7], [15.5, 4.11], [17, 2.5], [17, 5.7]].map((p) => ({ side: 'enemy', pos: p, links: 1 }));
  if (casterSide === 'enemy') {
    for (const a of allies) a.links = 5;
    return { caster: enemies[0], target: allies[5], allies, enemies };
  }
  return { caster: allies[4], target: enemies[0], allies, enemies };
}

// Sort keys pickTargets can evaluate (battle_target_select_ai.select_order); others keep the listed order.
const SORTABLE = {
  0: () => 0, 1: (u) => u.hp ?? 0, 2: () => 100, 3: (u) => u.hp ?? 0,
  4: (u, c) => Math.hypot(u.pos[0] - c.pos[0], u.pos[1] - c.pos[1]),
  9: (u, c) => Math.abs(u.pos[0] - c.pos[0]), 10: (u, c) => Math.abs(u.pos[0] - c.pos[0]), 11: (u, c) => Math.abs(u.pos[1] - c.pos[1]),
};

/**
 * The units a skill's target rule picks, best first. Candidates keep their listed order (for enemies, the
 * enemy_in_team order with summons after them) and the sort is stable, so ties go to the earlier unit; this
 * matches what has been observed in battle. Range limits are not applied. aim comes from Analysis.creationSpec.
 * Returns { picked: units, unsupported: [keys] }.
 */
export function pickTargets(aim, sc) {
  if (!aim) return { picked: [sc.target].filter(Boolean), unsupported: [] };
  const foes = sc.caster.side === 'ally' ? sc.enemies : sc.allies.filter((u) => u.links);
  const friends = sc.caster.side === 'ally' ? sc.allies.filter((u) => u.links) : sc.enemies;
  let pool = aim.type === 1 ? foes : aim.type === 4 ? [sc.caster] : aim.type === 3 ? friends.filter((u) => u !== sc.caster) : friends;
  pool = pool.map((u, i) => ({ u, i }));
  const unsupported = [];
  const keys = aim.keys.filter((k) => k.key !== 0);
  pool.sort((a, b) => {
    for (const k of keys) {
      const f = SORTABLE[k.key];
      if (!f) { if (!unsupported.includes(k.key)) unsupported.push(k.key); continue; }
      const va = f(a.u, sc.caster), vb = f(b.u, sc.caster);
      if (va !== vb) return k.highFirst ? vb - va : va - vb;
    }
    return a.i - b.i;
  });
  let picked = pool.map((x) => x.u).slice(Math.max(0, (aim.rank || 1) - 1));
  if (aim.n) picked = picked.slice(0, aim.n);
  return { picked, unsupported };
}

/** World positions of a unit's dummy links. */
export function linkPositions(u) {
  const n = Math.max(1, u.links || 1);
  if (u.side === 'enemy') return [u.pos];
  return LINKS.slice(0, n).map(([dx, dy]) => [u.pos[0] + dx, u.pos[1] + dy]);
}

const add = (a, b) => [a[0] + b[0], a[1] + b[1]];

/**
 * The point a position type refers to [gsEffect.GetPosByType]. The node, gun and body types add a model bone offset
 * on top of the unit's position; it is small on the ground plane and left out here.
 */
export function pointOf(type, sc, parentPos, link) {
  const me = link ?? sc.caster.pos; const tg = sc.target?.pos ?? me;
  const t = Number(type);
  if (Number.isNaN(t)) return me;               // a named model node ("hip", "muzzle2"): on the user
  switch (t) {
    case 0: case 1: case 2: case 3: return me;
    case 4: case 5: case 6: case 15: case 99: return tg;
    case 7: return parentPos ?? me;
    case 8: return WORLD0;                       // friendly team origin, whoever casts it
    case 9: return [WORLD0[0], me[1]];           // x set to 0
    case 10: return [me[0], WORLD0[1]];          // z set to 0
    case 11: case 13: return [WORLD0[0], tg[1]];
    case 12: case 14: return [tg[0], WORLD0[1]];
    default: return me;
  }
}

/**
 * Where the creation's area is centred. Creations with route 0 or 3 never move: they stay at their start point
 * and use the destination only to face it [gsEffect.InitData: no move node for those routes]. Moving ones
 * are judged where they arrive.
 */
export function placements(spec, sc, parentPos) {
  // is_clone: one copy per chosen target.
  if (spec.clone && sc.targets?.length > 1 && !sc._one) return sc.targets.flatMap((t) => placements(spec, { ...sc, target: t, _one: true }, parentPos));
  const casters = spec.formPlay && sc.caster.side === 'ally' ? linkPositions(sc.caster) : [sc.caster.pos];
  const out = [];
  casters.forEach((lp, i) => {
    const link = spec.start.form || spec.dest.form ? lp : sc.caster.pos;
    if (i > 0 && !spec.start.form && !spec.dest.form) return;   // every link's copy lands on the same spot
    const start = add(pointOf(spec.start.type, sc, parentPos, spec.start.form ? link : null), spec.start.off);
    const dest = add(pointOf(spec.dest.type, sc, parentPos, spec.dest.form ? link : null), spec.dest.off);
    const moving = ![0, 3].includes(spec.route);
    out.push({ start, dest, at: moving ? dest : start, moving, target: sc.target });
  });
  return out;
}

const esc = (t) => String(t).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const near = (p, q, r) => Math.hypot(p[0] - q[0], p[1] - q[1]) <= r;
function inSector(c, p, half, dir) {
  if (half >= 180) return true;
  const v = [p[0] - c[0], p[1] - c[1]];
  const len = Math.hypot(v[0], v[1]);
  if (len === 0) return true;
  const ang = Math.acos(Math.max(-1, Math.min(1, (v[0] * dir) / len))) * 180 / Math.PI;
  return ang <= half;
}

/** Does the area centred at `at` reach point p? */
export function reaches(area, at, p) {
  switch (area.type) {
    case 1: {
      if (area.p1 === null) return false;
      const half = area.p2 ? Math.abs(area.p2) : 180;
      return near(at, p, area.p1 + UNIT_RADIUS) && inSector(at, p, half, area.p2 < 0 ? -1 : 1);
    }
    case 2: return area.p1 !== null && area.p2 !== null && Math.abs(p[0] - at[0]) <= area.p1 / 2 && Math.abs(p[1] - at[1]) <= area.p2 / 2;
    case 3: return area.cells.some((id) => { const o = add(at, cellOffset(id)); return Math.abs(p[0] - o[0]) <= CELL[0] / 2 && Math.abs(p[1] - o[1]) <= CELL[1] / 2; });
    default: return false;
  }
}

// ---------------------------------------------------------------- drawing

const VIEW0 = { x0: -5.5, x1: 22, y0: -2.6, y1: 11.2, s: 22 };
let VIEW = VIEW0;   // widened by drawField to fit the units
const X = (x) => (x - VIEW.x0) * VIEW.s;
const Y = (y) => (VIEW.y1 - y) * VIEW.s;
const f1 = (n) => Math.round(n * 10) / 10;

function areaSvg(area, at, cls) {
  const cx = X(at[0]), cy = Y(at[1]);
  switch (area.type) {
    case 1: {
      if (area.p1 === null) return '';
      const r = area.p1 * VIEW.s, R = (area.p1 + UNIT_RADIUS) * VIEW.s;
      const half = area.p2 ? Math.abs(area.p2) : 180;
      if (half >= 180) return `<circle class="${cls}" cx="${f1(cx)}" cy="${f1(cy)}" r="${f1(Math.max(r, 1.5))}"/><circle class="reach" cx="${f1(cx)}" cy="${f1(cy)}" r="${f1(R)}"/>`;
      const dir = area.p2 < 0 ? Math.PI : 0;
      const a0 = dir - half * Math.PI / 180, a1 = dir + half * Math.PI / 180;
      const pt = (a, rr) => `${f1(cx + rr * Math.cos(a))},${f1(cy - rr * Math.sin(a))}`;
      const large = half * 2 > 180 ? 1 : 0;
      return `<path class="${cls}" d="M${f1(cx)},${f1(cy)} L${pt(a0, R)} A${f1(R)},${f1(R)} 0 ${large} 0 ${pt(a1, R)} Z"/>`;
    }
    case 2: {
      if (area.p1 === null || area.p2 === null) return '';
      return `<rect class="${cls}" x="${f1(cx - area.p1 * VIEW.s / 2)}" y="${f1(cy - area.p2 * VIEW.s / 2)}" width="${f1(area.p1 * VIEW.s)}" height="${f1(area.p2 * VIEW.s)}"/>`;
    }
    case 3: return area.cells.map((id) => { const o = add(at, cellOffset(id)); return `<rect class="${cls}" x="${f1(X(o[0] - CELL[0] / 2))}" y="${f1(Y(o[1] + CELL[1] / 2))}" width="${f1(CELL[0] * VIEW.s)}" height="${f1(CELL[1] * VIEW.s)}"/>`; }).join('');
    case 4: {
      if (area.p1 === null || area.p2 === null) return '';
      return `<rect class="${cls}" x="${f1(cx)}" y="${f1(cy - area.p2 * VIEW.s / 2)}" width="${f1(area.p1 * VIEW.s)}" height="${f1(area.p2 * VIEW.s)}"/>`;
    }
    default: return `<circle class="${cls}" cx="${f1(cx)}" cy="${f1(cy)}" r="4"/>`;
  }
}

/**
 * Draw a creation and its child creations on the field. spec comes from Analysis.creationSpec; sc from
 * defaultScenario(). Returns { svg, hits: { ally: n, enemy: n } }.
 */
export function drawField(spec, sc) {
  const all = [...sc.allies, ...sc.enemies];
  VIEW = { ...VIEW0, x1: Math.max(VIEW0.x1, ...all.map((u) => u.pos[0] + 2)), y0: Math.min(VIEW0.y0, ...all.map((u) => u.pos[1] - 1.5)), y1: Math.max(VIEW0.y1, ...all.map((u) => u.pos[1] + 1.5)) };
  const shapes = []; const paths = []; const hitPts = new Set();
  const victims = (s) => (s.affects === 'ally') === (sc.caster.side === 'ally') ? sc.allies.filter((u) => u.links) : sc.enemies;
  const walk = (s, parentPos, depth, tone) => {
    if (!s || depth > 3 || shapes.length > 40) return;
    for (const pl of placements(s, sc, parentPos)) {
      if (pl.moving) paths.push(`<line class="path" x1="${f1(X(pl.start[0]))}" y1="${f1(Y(pl.start[1]))}" x2="${f1(X(pl.dest[0]))}" y2="${f1(Y(pl.dest[1]))}"/>`);
      const spots = [pl.at, ...(s.random ?? []).map((o) => add(pl.at, o))];
      spots.forEach((at, i) => {
        if (s.area.type) shapes.push(areaSvg(s.area, at, `area t${tone}${i ? ' rnd' : ''}`));
        if (s.hits && s.area.type) for (const u of victims(s)) for (const lp of linkPositions(u)) if (reaches(s.area, at, lp)) hitPts.add(lp.join(','));
      });
      if (s.hits && !s.area.type && s.area.toTarget) hitPts.add((pl.target?.pos ?? pl.dest).join(','));
      for (const k of s.children ?? []) walk(k.spec, pl.at, depth + 1, (tone + 1) % 4);
    }
  };
  walk(spec, null, 0, 0);
  const grid = [];
  for (let x = Math.ceil(VIEW.x0 / 5) * 5; x <= VIEW.x1; x += 5) grid.push(`<line class="grid" x1="${f1(X(x))}" y1="0" x2="${f1(X(x))}" y2="${f1(Y(VIEW.y0))}"/><text class="tick" x="${f1(X(x) + 2)}" y="${f1(Y(VIEW.y0) - 3)}">${x}</text>`);
  RANGE_LINES.forEach(([x, t], i) => grid.push(`<line class="rng" x1="${f1(X(x))}" y1="0" x2="${f1(X(x))}" y2="${f1(Y(VIEW.y0))}"/><text class="rngt" x="${f1(X(x) + 2)}" y="${f1(10 + i * 11)}">${t}</text>`));
  const units = [];
  for (let s = 1; s <= 9; s++) {
    const p = slotPos(s);
    units.push(`<rect class="tile" x="${f1(X(p[0] - SLOT.dx / 2))}" y="${f1(Y(p[1] + SLOT.dy / 2))}" width="${f1(SLOT.dx * VIEW.s)}" height="${f1(SLOT.dy * VIEW.s)}"/><text class="slot" x="${f1(X(p[0] + SLOT.dx / 2) - 3)}" y="${f1(Y(p[1] + SLOT.dy / 2) + 11)}" text-anchor="end">${s}</text>`);
  }
  const dot = (u, lp, i) => {
    const hit = hitPts.has(lp.join(','));
    const me = u === sc.caster, tg = u === sc.target || !!sc.targets?.includes(u);
    const title = u.name ? `<title>${esc(u.order ? `${u.order}. ` : '')}${esc(u.name)}${u.links > 1 ? ` ×${u.links}` : ''}${u.hp ? ` · ${Math.round(u.hp)} HP` : ''}</title>` : '';
    return `<circle class="u ${u.side}${hit ? ' hit' : ''}${me && i === 0 ? ' me' : ''}${tg && i === 0 ? ' tg' : ''}" cx="${f1(X(lp[0]))}" cy="${f1(Y(lp[1]))}" r="${f1(UNIT_RADIUS * VIEW.s)}">${title}</circle>`;
  };
  for (const u of [...sc.allies.filter((x) => x.links), ...sc.enemies]) linkPositions(u).forEach((lp, i) => units.push(dot(u, lp, i)));
  const lab = (u, t) => `<text class="lab" x="${f1(X(u.pos[0]))}" y="${f1(Y(u.pos[1]) - UNIT_RADIUS * VIEW.s - 4)}" text-anchor="middle">${t}</text>`;
  // Enemies of a loaded team carry their enemy_in_team order: the order ties are broken in.
  for (const u of sc.enemies) if (u.order) units.push(`<text class="ord" x="${f1(X(u.pos[0]) + UNIT_RADIUS * VIEW.s + 2)}" y="${f1(Y(u.pos[1]) + 3)}">${u.order}</text>`);
  units.push(lab(sc.caster, 'user'));
  const tgs = sc.targets?.length ? sc.targets : [sc.target].filter(Boolean);
  tgs.forEach((t, i) => { if (t !== sc.caster) units.push(lab(t, tgs.length > 1 ? `target ${i + 1}` : 'target')); });
  const W = f1((VIEW.x1 - VIEW.x0) * VIEW.s), H = f1((VIEW.y1 - VIEW.y0) * VIEW.s);
  const count = { ally: 0, enemy: 0 };
  for (const u of [...sc.allies.filter((x) => x.links), ...sc.enemies]) if (linkPositions(u).some((lp) => hitPts.has(lp.join(',')))) count[u.side]++;
  // Copies that land on the same spot (one per dummy link) are drawn once; units go on top so hits stay visible.
  const svg = `<svg class="bf" viewBox="0 0 ${W} ${H}" role="img" aria-label="Battlefield: where the effect lands">${grid.join('')}${[...new Set(shapes)].join('')}${[...new Set(paths)].join('')}${units.join('')}</svg>`;
  return { svg, hits: count };
}

export const FIELD_CSS = `
.bf{width:100%;max-width:640px;height:auto;display:block;background:var(--quote);border-radius:6px;margin:.4em 0}
.bf .grid{stroke:var(--line);stroke-width:1}
.bf .tick,.bf .slot,.bf .lab,.bf .ord,.bf .rngt{font:10px system-ui,sans-serif;fill:var(--dim)}
.bf .rng{stroke:var(--code);stroke-width:1;stroke-dasharray:6 3;opacity:.7} .bf .rngt{fill:var(--code)}
.bf .lab{fill:var(--fg);font-weight:600}
.bf .tile{fill:none;stroke:var(--line);stroke-dasharray:3 3}
.bf .u{stroke:var(--card);stroke-width:1}
.bf .u.ally{fill:var(--accent)} .bf .u.enemy{fill:var(--warn)}
.bf .u.hit{fill:var(--bug);stroke:var(--fg);stroke-width:1.5}
.bf .u.me,.bf .u.tg{stroke:var(--fg);stroke-width:2}
.bf .path{stroke:var(--dim);stroke-width:1.5;stroke-dasharray:5 4}
.bf .area{fill-opacity:.22;stroke-width:1.5}
.bf .area.t0{fill:var(--alt);stroke:var(--alt)} .bf .area.t1{fill:var(--code);stroke:var(--code)}
.bf .area.t2{fill:var(--info);stroke:var(--info)} .bf .area.t3{fill:var(--warn);stroke:var(--warn)}
.bf .area.rnd{fill-opacity:.1;stroke-dasharray:4 3}
.bf .reach{fill:none;stroke:var(--dim);stroke-dasharray:2 3}
details.field>summary{cursor:pointer;color:var(--accent);font-size:.88rem}
.fieldctl{display:flex;flex-wrap:wrap;gap:6px 12px;font-size:.85rem;color:var(--dim);align-items:center}
.fieldctl input{width:5em}
`;
