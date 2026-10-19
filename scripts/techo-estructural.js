// Techo estructural de la red (referencia de F5; plan, F5 y D19).
// Uso: npm run build && node --max-old-space-size=6144 scripts/techo-estructural.js [carpeta-resultados]
//
// Decide, sin depender de la ILS, si existe alguna ruta que no repita tramos
// (RNF-SinRepetición) para las dos variantes con longitud objetivo, con la
// banda de la ILS (±15%):
//
// 1. CIRCUITO: cada origen distinto de los dos conjuntos de pares × 30, 60 y
//    100 km. El origen se reduce al ancla de D19 (acceso hasta el núcleo
//    principal de la red pública, recorrido de ida y de vuelta); el acceso
//    repetido no puede superar el 25% del largo total (si no, corresponde una
//    ida y vuelta declarada, D18).
// 2. DESTINO FIJO: los 48 pares de los dos conjuntos con longitud objetivo de
//    1,5 y 2,5 veces su distancia mínima.
//
// Clasificación, con certificados en ambos sentidos (las cotas son las del
// motor, `src/dijkstra/structure.ts`):
// - IMPOSIBLE: circuito — la banda queda vacía por el tope de acceso; o el
//   largo total de la red donde puede vivir un circuito (fuertemente conexa con
//   el ancla, 2-arista-conexa, pública, en el disco de radio L_max/2) es menor
//   que L_min; o el ciclo más corto por el ancla supera L_max. Destino fijo —
//   la distancia mínima supera L_max, o la red pública de la elipse alcanzable
//   desde el origen y que llega al destino es más corta que L_min.
// - FACTIBLE: un constructor independiente de la ILS (piernas de largo mínimo
//   por 1, 2 o 3 puntos de giro del núcleo, con bloqueo duro de tramos) arma
//   una ruta en la banda y el verificador la valida.
// - INDETERMINADO: ninguna prueba concluye. No se resuelve con optimización
//   entera (decisión del 2026-10-18).
const fs = require('fs');
const path = require('path');
const DIST = path.join(__dirname, '..', 'dist');
const { COMPILER_VERSION } = require(path.join(DIST, 'graph-compiler', 'compile'));
const { readSnapshot } = require(path.join(DIST, 'graph-compiler', 'snapshot'));
const { haversine } = require(path.join(DIST, 'graph-compiler', 'geo'));
const { snapCandidates } = require(path.join(DIST, 'dijkstra', 'snap'));
const { astarMultiSource } = require(path.join(DIST, 'dijkstra', 'astar'));
const { TramoOverlay } = require(path.join(DIST, 'dijkstra', 'overlay'));
const { sinRepeticionViolations } = require(path.join(DIST, 'dijkstra', 'no-repeat'));
const S = require(path.join(DIST, 'dijkstra', 'structure'));
const { SETS } = require('./baseline/pairs');

const OUT_DIR = process.argv[2] || null;
const LENGTHS_KM = [30, 60, 100];
const FACTORS = [1.5, 2.5];
const BAND = 0.15;
const ACCESS_SHARE = 0.25;
const W0 = { curvinessWeight: 0, surfaceWeight: 0 }; // la existencia no depende del perfil

// Zonas de los orígenes (criterio: valle = área urbana continua del Gran
// Santiago; precordillera = cordillera de los Andes, Cajón del Maipo y
// Farellones; rural = localidades fuera del Gran Santiago).
const ZONES = {
  valle: ['plazaArmas', 'providencia', 'lasCondes', 'maipu', 'quilicura', 'laFlorida', 'puenteAlto', 'padreHurtado', 'laDehesa'],
  precordillera: ['farellones', 'sanJoseMaipo', 'sanAlfonso', 'pirque'],
  rural: ['curacavi', 'talagante', 'buin', 'penaflor', 'colina', 'lampa', 'caleraTango', 'noviciado', 'casablanca', 'melipilla', 'paine', 'islaMaipo'],
};
const zoneOf = (name) => Object.keys(ZONES).find((z) => ZONES[z].includes(name)) || 'sin zona';

const dir = process.env.GRAPH_CACHE_DIR || path.join(__dirname, '..', 'data', 'graph-cache');
const re = new RegExp(`^graph-osm-v(\\d+)-${COMPILER_VERSION.replace(/\./g, '\\.')}\\.bin$`);
const file = (fs.existsSync(dir) ? fs.readdirSync(dir) : [])
  .map((f) => ({ f, m: re.exec(f) }))
  .filter((x) => x.m)
  .sort((a, b) => Number(b.m[1]) - Number(a.m[1]))[0];
if (!file) {
  console.error(`No hay snapshot del grafo para el compilador ${COMPILER_VERSION} en ${dir}. Arrancá el servidor una vez para generarlo.`);
  process.exit(1);
}
const g = readSnapshot(path.join(dir, file.f));
const st = S.networkStructure(g);
const mainCore = [];
for (let u = 0; u < g.meta.nodeCount; u++) if (st.core[u] && st.block[u] === st.mainBlock) mainCore.push(u);

// ── Constructor de rutas (independiente de la ILS) ──
let seed = 20261018;
const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;

/** Ruta start → w1 → … → wk → end con piernas de largo mínimo y tramos bloqueados entre piernas (y los de `base`). */
function legsVia(start, end, ws, base) {
  const ov = new TramoOverlay(g);
  for (const r of base) ov.addRoute(r);
  let from = start;
  const tramos = [];
  let len = 0;
  const targets = [...ws.map((w) => [{ node: w }]), end];
  for (let j = 0; j < targets.length; j++) {
    const leg = astarMultiSource(g, from, targets[j], W0, {
      lengthOnly: true,
      blocked: ov,
      privateAccess: { origin: j === 0, dest: j === targets.length - 1 },
    });
    if (!leg) return null;
    ov.addRoute(leg);
    tramos.push(...leg.tramos);
    len += leg.sums.len;
    from = [leg.dest];
  }
  return { len, tramos };
}

/**
 * Busca una ruta en [lo, hi] con 1, 2 o 3 puntos de giro elegidos de `pool`
 * según `distOf` (distancia en línea recta que conviene al punto de giro).
 */
function construct({ start, end, base, lo, hi, target, pool, distOf, ranges }) {
  const pick = (a, b, n) => {
    const c = pool.filter((u) => { const d = distOf(u); return d >= a && d <= b; });
    const out = [];
    for (let i = 0; i < n && c.length; i++) out.push(c.splice(Math.floor(rnd() * c.length), 1)[0]);
    return out;
  };
  let tries = 0;
  let closest = null;
  let best1 = null;
  const test = (ws, method) => {
    tries++;
    const r = legsVia(start, end, ws, base);
    if (!r) return null;
    if (!closest || Math.abs(r.len - target) < Math.abs(closest.len - target)) closest = { len: r.len, method };
    if (ws.length === 1 && (!best1 || Math.abs(r.len - target) < Math.abs(best1.len - target))) best1 = { len: r.len, d: distOf(ws[0]) };
    if (r.len >= lo && r.len <= hi && sinRepeticionViolations(r.tramos).length === 0) return { len: r.len, method };
    return null;
  };
  const done = (ok) => ({ ...ok, tries, closest });
  for (let b = 0; b < 8; b++) {
    const a = ranges.one[0] + ((ranges.one[1] - ranges.one[0]) * b) / 8;
    const z = ranges.one[0] + ((ranges.one[1] - ranges.one[0]) * (b + 1)) / 8;
    for (const w of pick(a, z, 5)) { const ok = test([w], '1 punto de giro'); if (ok) return done(ok); }
  }
  for (let i = 0; i < 60 && best1; i++) {
    const center = best1.d * (target / best1.len);
    const [w] = pick(center * 0.85, center * 1.15, 1);
    if (w === undefined) break;
    const ok = test([w], '1 punto de giro');
    if (ok) return done(ok);
  }
  for (const k of [2, 3]) {
    for (let i = 0; i < 25; i++) {
      const ws = pick(ranges.many[0], ranges.many[1], k);
      if (ws.length < k) break;
      const ok = test(ws, `${k} puntos de giro`);
      if (ok) return done(ok);
    }
  }
  for (let i = 0; i < 150; i++) {
    const k = 1 + (i % 3);
    const ws = pick(ranges.wide[0], ranges.wide[1], k);
    if (ws.length < k) continue;
    const ok = test(ws, `${k} punto${k > 1 ? 's' : ''} de giro`);
    if (ok) return done(ok);
  }
  return { len: null, tries, closest };
}

// ── 1. Circuitos ──
const origins = new Map();
for (const { P, PAIRS } of Object.values(SETS)) for (const [a] of PAIRS) origins.set(a, P[a]);

function classifyCircuit(anchor, Lkm) {
  if (anchor.error) return { status: 'imposible', reason: anchor.error };
  const L = Lkm * 1000;
  const row = { accessKm: +(anchor.accessMeters / 1000).toFixed(2) };
  const band = S.circuitBand(L, BAND, anchor.accessMeters, ACCESS_SHARE);
  if (!band) return { ...row, status: 'imposible', reason: `acceso repetido ${row.accessKm} km > ${100 * ACCESS_SHARE}% del largo: ida y vuelta (D18)`, outAndBack: 'acceso' };
  const bound = S.circuitUpperBound(g, anchor, band.hi / 2);
  row.upperKm = +(bound.total / 1000).toFixed(1);
  if (bound.total < band.lo) return { ...row, status: 'imposible', reason: `red disponible ${row.upperKm} km < ${(band.lo / 1000).toFixed(1)} km` };
  const cyc = S.minCycleThrough(g, anchor);
  row.minCycleKm = Number.isFinite(cyc) ? +(cyc / 1000).toFixed(1) : null;
  if (cyc > band.hi) return { ...row, status: 'imposible', reason: `ciclo más corto por el origen ${row.minCycleKm} km > ${(band.hi / 1000).toFixed(1)} km` };
  const target = Math.min(band.hi, Math.max(band.lo, L - anchor.accessMeters));
  const pool = mainCore.filter((u) => bound.nodes[u]);
  const d = (u) => haversine(anchor.lat, anchor.lon, g.nodeLat[u], g.nodeLon[u]);
  const base = [anchor.accessOut, anchor.accessBack].filter(Boolean);
  const c = construct({
    start: [anchor.ep], end: [anchor.ep], base, lo: band.lo, hi: band.hi, target, pool, distOf: d,
    ranges: { one: [0.12 * target, 0.5 * target], many: [0.12 * target, 0.4 * target], wide: [0.08 * target, 0.5 * target] },
  });
  row.tries = c.tries;
  row.closestKm = c.closest ? +((c.closest.len + anchor.accessMeters) / 1000).toFixed(1) : null;
  if (c.len !== null) return { ...row, status: 'factible', foundKm: +((c.len + anchor.accessMeters) / 1000).toFixed(1), method: c.method };
  return { ...row, status: 'indeterminado' };
}

// ── 2. Destino fijo ──
function classifyPath(o, d, L) {
  const lo = (1 - BAND) * L, hi = (1 + BAND) * L;
  const sh = astarMultiSource(g, o, d, W0, { lengthOnly: true });
  if (!sh) return { status: 'imposible', reason: 'sin camino' };
  const row = { shortestKm: +(sh.sums.len / 1000).toFixed(1) };
  if (sh.sums.len > hi) return { ...row, status: 'imposible', reason: `distancia mínima ${row.shortestKm} km > ${(hi / 1000).toFixed(1)} km` };
  if (sh.sums.len >= lo) return { ...row, status: 'factible', foundKm: row.shortestKm, method: 'la más corta' };
  const from = { lat: o[0].lat, lon: o[0].lon, nodes: [g.chainNode0[o[0].chain], g.chainNode1[o[0].chain]] };
  const to = { lat: d[0].lat, lon: d[0].lon, nodes: [g.chainNode0[d[0].chain], g.chainNode1[d[0].chain]] };
  const ub = S.pathUpperBound(g, from, to, hi);
  row.upperKm = +(ub / 1000).toFixed(1);
  if (ub < lo) return { ...row, status: 'imposible', reason: `red disponible ${row.upperKm} km < ${(lo / 1000).toFixed(1)} km` };
  // Para el destino fijo, la "distancia" de un punto de giro es la suma de sus distancias a los dos extremos.
  const dd = (u) => haversine(from.lat, from.lon, g.nodeLat[u], g.nodeLon[u]) + haversine(g.nodeLat[u], g.nodeLon[u], to.lat, to.lon);
  // Puntos de giro: uniones con ciclos en los bloques del corredor del árbol de puentes (no solo del núcleo principal).
  const corridor = S.bridgeTreeCorridor(g, from.nodes, to.nodes);
  const pool = [];
  for (let u = 0; u < g.meta.nodeCount; u++) if (st.core[u] && (!corridor || corridor.blocks.has(st.block[u])) && dd(u) <= hi) pool.push(u);
  const direct = haversine(from.lat, from.lon, to.lat, to.lon);
  const c = construct({
    start: o, end: d, base: [], lo, hi, target: L, pool, distOf: dd,
    ranges: { one: [direct, 0.9 * L], many: [direct, 0.8 * L], wide: [direct, L] },
  });
  row.tries = c.tries;
  row.closestKm = c.closest ? +(c.closest.len / 1000).toFixed(1) : null;
  if (c.len !== null) return { ...row, status: 'factible', foundKm: +(c.len / 1000).toFixed(1), method: c.method };
  return { ...row, status: 'indeterminado' };
}

// ── Medición ──
const t0 = Date.now();
const circuits = [];
for (const [name, [lat, lon]] of origins) {
  const [cand] = snapCandidates(g, lat, lon, 1);
  const anchor = cand ? S.circuitAnchor(g, cand) : { error: 'sin snap' };
  for (const Lkm of LENGTHS_KM) {
    const r = { origin: name, zone: zoneOf(name), L: Lkm, ...classifyCircuit(anchor, Lkm) };
    circuits.push(r);
    console.log(`circuito ${name.padEnd(13)} ${r.zone.padEnd(13)} ${String(Lkm).padStart(3)} km  ${r.status.padEnd(13)} ${r.foundKm ? r.foundKm + ' km (' + r.method + ')' : r.reason || 'más cercano ' + r.closestKm + ' km'} | acceso ${r.accessKm ?? '—'} km`);
  }
}
const paths = [];
for (const [set, { P, PAIRS }] of Object.entries(SETS)) {
  for (const [a, b] of PAIRS) {
    const o = snapCandidates(g, P[a][0], P[a][1]);
    const d = snapCandidates(g, P[b][0], P[b][1]);
    const sh = o.length && d.length ? astarMultiSource(g, o, d, W0, { lengthOnly: true }) : null;
    for (const f of FACTORS) {
      const row = { set, pair: `${a}→${b}`, factor: f };
      if (!sh) { paths.push({ ...row, status: 'imposible', reason: 'sin camino' }); continue; }
      const L = Math.round((f * sh.sums.len) / 1000) * 1000;
      const r = { ...row, targetKm: L / 1000, ...classifyPath(o, d, L) };
      paths.push(r);
      console.log(`destino  ${r.pair.padEnd(28)} ×${f} ${String(r.targetKm).padStart(5)} km  ${r.status.padEnd(13)} ${r.foundKm ? r.foundKm + ' km (' + r.method + ')' : r.reason || 'más cercano ' + r.closestKm + ' km'}`);
    }
  }
}

// ── Informe ──
const lines = [];
const log = (s) => { lines.push(s); console.log(s); };
const tally = (rows) => ({
  imposible: rows.filter((r) => r.status === 'imposible').length,
  factible: rows.filter((r) => r.status === 'factible').length,
  indeterminado: rows.filter((r) => r.status === 'indeterminado').length,
});
const fmt = (c) => `${String(c.imposible).padStart(3)} imposibles · ${String(c.factible).padStart(3)} factibles · ${String(c.indeterminado).padStart(3)} indeterminados`;
log('');
log(`## Techo estructural (referencia definitiva: D19, banda ±${100 * BAND}%, acceso ≤ ${100 * ACCESS_SHARE}%) — ${new Date().toISOString()} — snapshot ${file.f} — ${((Date.now() - t0) / 1000).toFixed(0)} s`);
log('');
log(`### Circuitos (${origins.size} orígenes × ${LENGTHS_KM.join('/')} km)`);
const summary = { circuits: {}, paths: {} };
for (const z of Object.keys(ZONES)) {
  const n = new Set(circuits.filter((r) => r.zone === z).map((r) => r.origin)).size;
  for (const Lkm of LENGTHS_KM) {
    const c = tally(circuits.filter((r) => r.zone === z && r.L === Lkm));
    (summary.circuits[z] = summary.circuits[z] || {})[Lkm] = c;
    log(`${(z + ' (' + n + ')').padEnd(22)} ${String(Lkm).padStart(4)} km   ${fmt(c)}`);
  }
}
for (const Lkm of LENGTHS_KM) log(`${'todas'.padEnd(22)} ${String(Lkm).padStart(4)} km   ${fmt(tally(circuits.filter((r) => r.L === Lkm)))}`);
log(`${'total'.padEnd(22)} ${''.padStart(4)}      ${fmt(tally(circuits))}`);
log('');
log(`### Destino fijo (${paths.length / FACTORS.length} pares × ${FACTORS.map((f) => '×' + f).join(', ')} la distancia mínima)`);
for (const set of Object.keys(SETS)) {
  for (const f of FACTORS) {
    const c = tally(paths.filter((r) => r.set === set && r.factor === f));
    (summary.paths[set] = summary.paths[set] || {})[f] = c;
    log(`${set.padEnd(22)} ×${f}     ${fmt(c)}`);
  }
}
log(`${'total'.padEnd(22)}          ${fmt(tally(paths))}`);
log('');
log('### Casos no factibles');
for (const r of circuits.filter((x) => x.status !== 'factible')) log(`circuito ${r.zone.padEnd(13)} ${r.origin.padEnd(13)} ${String(r.L).padStart(3)} km  ${r.status.padEnd(13)} ${r.reason || 'más cercano ' + r.closestKm + ' km'} | acceso ${r.accessKm ?? '—'} km`);
for (const r of paths.filter((x) => x.status !== 'factible')) log(`destino  ${r.set.padEnd(11)} ${r.pair.padEnd(28)} ×${r.factor}  ${r.status.padEnd(13)} ${r.reason || 'más cercano ' + r.closestKm + ' km'}`);
if (OUT_DIR) {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.writeFileSync(path.join(OUT_DIR, 'techo.json'), JSON.stringify({ date: new Date().toISOString(), snapshot: file.f, band: BAND, accessShare: ACCESS_SHARE, lengthsKm: LENGTHS_KM, factors: FACTORS, zones: ZONES, summary, circuits, paths }, null, 1));
  fs.writeFileSync(path.join(OUT_DIR, 'report.txt'), lines.join('\n') + '\n');
  console.log(`→ ${OUT_DIR}/{techo.json, report.txt}`);
}
