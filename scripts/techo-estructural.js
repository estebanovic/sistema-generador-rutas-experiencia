// Techo estructural de la red (medición previa de F5; plan, F5).
// Uso: npm run build && node --max-old-space-size=6144 scripts/techo-estructural.js [carpeta-resultados]
//
// Para cada origen distinto de los dos conjuntos de pares y cada longitud
// objetivo (30, 60 y 100 km, banda ±10%), decide si existe algún circuito que
// no repita tramos (RNF-SinRepetición), sin depender de la ILS:
//
// - El origen se reduce a X (D14): si su tramo es un puente, X es el primer
//   nodo del núcleo y el acceso (ida y vuelta) se descuenta de la banda. Si no
//   es puente, el circuito parte del punto del snap y debe usar ese tramo.
// - IMPOSIBLE (certificado): un circuito es un subgrafo euleriano conexo que
//   contiene el origen, así que vive en la parte de la red que es a la vez
//   fuertemente conexa con él (sentidos únicos), 2-arista-conexa (sin puentes),
//   pública y dentro del disco de radio L_max/2. Se restringe iterando hasta
//   que no cambie; si el largo total que queda es menor que L_min, no hay
//   circuito.
//   Además, si el ciclo más corto que pasa por el origen ya mide más que
//   L_max, tampoco hay circuito (todo circuito contiene un ciclo por el origen).
// - FACTIBLE (certificado): un constructor independiente de la ILS arma un
//   circuito dentro de la banda con piernas de largo mínimo y bloqueo duro de
//   tramos (overlay): origen → w → origen, origen → w1 → w2 → origen y
//   origen → w1 → w2 → w3 → origen, con puntos de giro del núcleo al azar
//   (semilla fija). El verificador de no repetición lo valida.
// - INDETERMINADO: ninguna de las dos pruebas concluye. No se resuelve con
//   optimización entera (decisión del 2026-10-18).
// - Columna aparte, "D14 ampliada" (solo informativa, no es la regla vigente):
//   si el bloque del origen no es el núcleo principal (la mayor componente
//   2-arista-conexa pública), el acceso llega hasta el núcleo principal.
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
const { SETS } = require('./baseline/pairs');

const OUT_DIR = process.argv[2] || null;
const LENGTHS_KM = [30, 60, 100];
const BAND = 0.1;
const W0 = { curvinessWeight: 0, surfaceWeight: 0 }; // la existencia no depende del perfil
const PRIVATE = 1; // EDGE_FLAG_DESTINATION_ONLY

// Zonas de los orígenes (criterio: valle = área urbana continua del Gran
// Santiago; precordillera = cordillera de los Andes, Cajón del Maipo y
// Farellones; rural = localidades fuera del Gran Santiago, en los valles del
// Maipo y de Chacabuco, la cordillera de la Costa y hacia la costa).
const ZONES = {
  valle: ['plazaArmas', 'providencia', 'lasCondes', 'maipu', 'quilicura', 'laFlorida', 'puenteAlto', 'padreHurtado', 'laDehesa'],
  precordillera: ['farellones', 'sanJoseMaipo', 'sanAlfonso', 'pirque'],
  rural: ['curacavi', 'talagante', 'buin', 'penaflor', 'colina', 'lampa', 'caleraTango', 'noviciado', 'casablanca', 'melipilla', 'paine', 'islaMaipo'],
};
const zoneOf = (name) => Object.keys(ZONES).find((z) => ZONES[z].includes(name)) || 'sin zona';

// ── Grafo ──
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
const N = g.meta.nodeCount;
const T = g.meta.chainCount;
const chainLen = (c) => g.geoCumLen[g.chainStart[c + 1] - 1];
const isPublic = (c) => (g.chainFlags[c] & PRIVATE) === 0;

// Tramos incidentes por nodo (no dirigido; un lazo aparece dos veces).
const incStart = new Int32Array(N + 1);
for (let c = 0; c < T; c++) { incStart[g.chainNode0[c] + 1]++; incStart[g.chainNode1[c] + 1]++; }
for (let i = 0; i < N; i++) incStart[i + 1] += incStart[i];
const incChain = new Int32Array(2 * T);
{ const pos = incStart.slice(0, N); for (let c = 0; c < T; c++) { incChain[pos[g.chainNode0[c]]++] = c; incChain[pos[g.chainNode1[c]]++] = c; } }
const other = (c, u) => (g.chainNode0[c] === u ? g.chainNode1[c] : g.chainNode0[c]);

/** Puentes del subgrafo no dirigido formado por los tramos con inChain (Tarjan iterativo, multigrafo). */
function bridgesOf(inChain) {
  const disc = new Int32Array(N).fill(-1), low = new Int32Array(N);
  const bridge = new Uint8Array(T);
  let time = 0;
  for (let s0 = 0; s0 < N; s0++) {
    if (disc[s0] >= 0) continue;
    const stack = [[s0, -1, incStart[s0]]]; disc[s0] = low[s0] = time++;
    while (stack.length) {
      const top = stack[stack.length - 1];
      const u = top[0], viaChain = top[1];
      if (top[2] < incStart[u + 1]) {
        const c = incChain[top[2]++];
        if (!inChain[c] || c === viaChain) continue;
        const v = other(c, u);
        if (disc[v] < 0) { disc[v] = low[v] = time++; stack.push([v, c, incStart[v]]); }
        else low[u] = Math.min(low[u], disc[v]);
      } else {
        stack.pop();
        if (stack.length) {
          const p = stack[stack.length - 1][0];
          low[p] = Math.min(low[p], low[u]);
          if (low[u] > disc[p]) bridge[viaChain] = 1;
        }
      }
    }
  }
  return bridge;
}

// Puentes de la red PÚBLICA: un circuito no puede usar vías privadas, así que
// un tramo que solo forma ciclo gracias a una calle privada es, para el
// circuito, un puente (los del compilador, `chainIsBridge`, incluyen las privadas).
const publicMask = new Uint8Array(T);
for (let c = 0; c < T; c++) if (isPublic(c)) publicMask[c] = 1;
const publicBridge = bridgesOf(publicMask);

// Núcleo (D14): nodos de la CFC mayor con al menos dos tramos públicos que no son puente.
const core = new Uint8Array(N);
for (let u = 0; u < N; u++) {
  if (!g.nodeInMainScc[u]) continue;
  const seen = new Set();
  for (let p = incStart[u]; p < incStart[u + 1]; p++) { const c = incChain[p]; if (isPublic(c) && !publicBridge[c]) seen.add(c); }
  if (seen.size >= 2) core[u] = 1;
}
const coreNodes = [];
for (let u = 0; u < N; u++) if (core[u]) coreNodes.push(u);

// Núcleo principal: la mayor componente 2-arista-conexa de la red pública (por largo).
const block = new Int32Array(N).fill(-1);
const blockKm = [];
for (let s0 = 0; s0 < N; s0++) {
  if (block[s0] >= 0) continue;
  const id = blockKm.length; blockKm.push(0);
  const st = [s0]; block[s0] = id;
  while (st.length) {
    const u = st.pop();
    for (let p = incStart[u]; p < incStart[u + 1]; p++) {
      const c = incChain[p]; if (!isPublic(c) || publicBridge[c]) continue;
      if (g.chainNode0[c] === u) blockKm[id] += chainLen(c) / 1000;
      const v = other(c, u); if (block[v] < 0) { block[v] = id; st.push(v); }
    }
  }
}
const MAIN_BLOCK = blockKm.indexOf(Math.max(...blockKm));
const mainCoreNodes = coreNodes.filter((u) => block[u] === MAIN_BLOCK);

// ── Cota superior: la parte de la red donde puede vivir un circuito ──
/**
 * Restringe la red al disco de radio R alrededor del ancla, a tramos públicos de
 * la CFC mayor, y luego itera: (a) nodos fuertemente conexos con el ancla
 * dentro de lo que queda; (b) sin puentes, componente del ancla. Devuelve el
 * largo total (m) y los nodos que quedan, o largo 0 si el ancla no sobrevive.
 */
function structuralBound(anchor, R) {
  const inNode = new Uint8Array(N);
  for (let u = 0; u < N; u++) if (g.nodeInMainScc[u] && haversine(anchor.lat, anchor.lon, g.nodeLat[u], g.nodeLon[u]) <= R) inNode[u] = 1;
  const inChain = new Uint8Array(T);
  for (let c = 0; c < T; c++) if (isPublic(c) && inNode[g.chainNode0[c]] && inNode[g.chainNode1[c]]) inChain[c] = 1;
  const root = anchor.nodes[0];
  const alive = () => inNode[root] && anchor.nodes.every((u) => inNode[u]) && (anchor.chain === undefined || inChain[anchor.chain]);
  for (let round = 0; round < 20; round++) {
    if (!alive()) return { total: 0, nodes: null };
    let changed = false;
    // (a) Alcanzable desde la raíz y que vuelve a ella, respetando los sentidos.
    const reach = (fwd) => {
      const seen = new Uint8Array(N); const st = [root]; seen[root] = 1;
      while (st.length) {
        const u = st.pop();
        for (let p = incStart[u]; p < incStart[u + 1]; p++) {
          const c = incChain[p]; if (!inChain[c]) continue;
          const v = other(c, u); if (seen[v]) continue;
          // Sentido u→v permitido (fwd) o v→u permitido (bwd, para "vuelve a la raíz").
          const atStart = g.chainNode0[c] === u;
          const uv = atStart ? g.chainFwd[c] >= 0 : g.chainBwd[c] >= 0;
          const vu = atStart ? g.chainBwd[c] >= 0 : g.chainFwd[c] >= 0;
          if (fwd ? uv : vu) { seen[v] = 1; st.push(v); }
        }
      }
      return seen;
    };
    const F = reach(true), B = reach(false);
    for (let u = 0; u < N; u++) if (inNode[u] && !(F[u] && B[u])) { inNode[u] = 0; changed = true; }
    for (let c = 0; c < T; c++) if (inChain[c] && !(inNode[g.chainNode0[c]] && inNode[g.chainNode1[c]])) { inChain[c] = 0; changed = true; }
    if (!alive()) return { total: 0, nodes: null };
    // (b) Sin los puentes del subgrafo que queda.
    const bridge = bridgesOf(inChain);
    for (let c = 0; c < T; c++) if (inChain[c] && bridge[c]) { inChain[c] = 0; changed = true; }
    // Componente del ancla sin los puentes.
    const comp = new Uint8Array(N); const st = [root]; comp[root] = 1;
    while (st.length) { const u = st.pop(); for (let p = incStart[u]; p < incStart[u + 1]; p++) { const c = incChain[p]; if (!inChain[c]) continue; const v = other(c, u); if (!comp[v]) { comp[v] = 1; st.push(v); } } }
    for (let u = 0; u < N; u++) if (inNode[u] && !comp[u]) { inNode[u] = 0; changed = true; }
    for (let c = 0; c < T; c++) if (inChain[c] && !(inNode[g.chainNode0[c]] && inNode[g.chainNode1[c]])) { inChain[c] = 0; changed = true; }
    if (!changed) break;
  }
  if (!alive()) return { total: 0, nodes: null };
  let total = 0;
  for (let c = 0; c < T; c++) if (inChain[c]) total += chainLen(c);
  return { total, nodes: inNode };
}

// ── Cota inferior: el ciclo más corto que pasa por el ancla ──
/** Largo del ciclo más corto que contiene el ancla (tramo del origen o nodo X), respetando sentidos. */
function minCycle(anchor) {
  const back = (from, to, chain) => {
    const ov = new TramoOverlay(g);
    ov.add({ chain, s0: 0, s1: chainLen(chain), dir: 1 });
    const r = astarMultiSource(g, [{ node: from }], [{ node: to }], W0, { lengthOnly: true, blocked: ov, privateAccess: { origin: false, dest: false } });
    return r ? r.sums.len : Infinity;
  };
  let best = Infinity;
  if (anchor.chain !== undefined) {
    const c = anchor.chain, a = g.chainNode0[c], b = g.chainNode1[c];
    if (g.chainFwd[c] >= 0) best = Math.min(best, chainLen(c) + (a === b ? 0 : back(b, a, c)));
    if (g.chainBwd[c] >= 0) best = Math.min(best, chainLen(c) + (a === b ? 0 : back(a, b, c)));
  } else {
    const X = anchor.nodes[0];
    for (let e = g.outStart[X]; e < g.outStart[X + 1]; e++) {
      const c = g.edgeChain[e];
      if (!isPublic(c)) continue;
      const v = g.edgeTo[e];
      best = Math.min(best, g.edgeLen[e] + (v === X ? 0 : back(v, X, c)));
    }
  }
  return best;
}

// ── Constructor de circuitos (independiente de la ILS) ──
let seed = 20261018;
const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
const OPTS = (ov) => ({ lengthOnly: true, blocked: ov, privateAccess: { origin: false, dest: false } });

/** Circuito ancla → w1 → … → wk → ancla, con piernas mínimas y tramos bloqueados entre piernas. */
function loopVia(anchor, ws) {
  const ov = new TramoOverlay(g);
  let from = [anchor.ep];
  const tramos = [];
  let len = 0;
  for (const target of [...ws.map((w) => [{ node: w }]), [anchor.ep]]) {
    const leg = astarMultiSource(g, from, target, W0, OPTS(ov));
    if (!leg) return null;
    ov.addRoute(leg);
    tramos.push(...leg.tramos);
    len += leg.sums.len;
    from = [leg.dest];
  }
  return { len, tramos };
}

function construct(anchor, Lmin, Lmax, Ltarget, nodes) {
  const pool = coreNodes.filter((u) => nodes[u]);
  const dist = (u) => haversine(anchor.lat, anchor.lon, g.nodeLat[u], g.nodeLon[u]);
  const pick = (lo, hi, n) => {
    const c = pool.filter((u) => { const d = dist(u); return d >= lo && d <= hi; });
    const out = [];
    for (let i = 0; i < n && c.length; i++) out.push(c.splice(Math.floor(rnd() * c.length), 1)[0]);
    return out;
  };
  let tries = 0;
  let closest = null;
  let best1 = null; // mejor circuito con 1 punto de giro: { largo, distancia en línea recta del punto }
  const test = (ws, method) => {
    tries++;
    const r = loopVia(anchor, ws);
    if (!r) return null;
    if (!closest || Math.abs(r.len - Ltarget) < Math.abs(closest.len - Ltarget)) closest = { len: r.len, method };
    if (ws.length === 1 && (!best1 || Math.abs(r.len - Ltarget) < Math.abs(best1.len - Ltarget))) best1 = { len: r.len, d: dist(ws[0]) };
    if (r.len >= Lmin && r.len <= Lmax && sinRepeticionViolations(r.tramos).length === 0) return { len: r.len, method, waypoints: ws.length };
    return null;
  };
  // 1 punto de giro: buckets de distancia en línea recta entre 0,12 y 0,5 del objetivo.
  for (let b = 0; b < 8; b++) {
    const lo = Ltarget * (0.12 + (0.38 * b) / 8), hi = Ltarget * (0.12 + (0.38 * (b + 1)) / 8);
    for (const w of pick(lo, hi, 5)) { const ok = test([w], '1 punto de giro'); if (ok) return { ...ok, tries, closest }; }
  }
  // 2 y 3 puntos de giro a 0,12–0,4 del objetivo.
  for (const k of [2, 3]) {
    for (let i = 0; i < 25; i++) {
      const ws = pick(Ltarget * 0.12, Ltarget * (k === 2 ? 0.4 : 0.3), k);
      if (ws.length < k) break;
      const ok = test(ws, `${k} puntos de giro`);
      if (ok) return { ...ok, tries, closest };
    }
  }
  // Adaptativa: recentra la distancia del punto de giro según el mejor largo obtenido.
  for (let i = 0; i < 60 && best1; i++) {
    const center = best1.d * (Ltarget / best1.len);
    const [w] = pick(center * 0.85, center * 1.15, 1);
    if (w === undefined) break;
    const ok = test([w], '1 punto de giro');
    if (ok) return { ...ok, tries, closest };
  }
  // Segunda vuelta, más amplia, antes de declarar el caso indeterminado.
  for (let i = 0; i < 150; i++) {
    const k = 1 + (i % 3);
    const ws = pick(Ltarget * 0.08, Ltarget * 0.5, k);
    if (ws.length < k) continue;
    const ok = test(ws, `${k} punto${k > 1 ? 's' : ''} de giro`);
    if (ok) return { ...ok, tries, closest };
  }
  return { len: null, tries, closest };
}

// ── Orígenes y ancla ──
const origins = new Map();
for (const { P, PAIRS } of Object.values(SETS)) for (const [a] of PAIRS) origins.set(a, P[a]);

function anchorOf(lat, lon) {
  const [cand] = snapCandidates(g, lat, lon, 1);
  if (!cand) return { error: 'sin snap' };
  const c = cand.chain;
  if (isPublic(c) && !publicBridge[c]) {
    return { ep: cand, lat: cand.lat, lon: cand.lon, nodes: [g.chainNode0[c], g.chainNode1[c]], chain: c, access: 0, kind: 'tramo del origen' };
  }
  // Tramo puente: acceso hasta el primer nodo del núcleo (todo camino al núcleo entra por él).
  const near = coreNodes.filter((u) => haversine(lat, lon, g.nodeLat[u], g.nodeLon[u]) <= 5000).map((u) => ({ node: u }));
  if (!near.length) return { error: 'sin núcleo a menos de 5 km' };
  const out = astarMultiSource(g, [cand], near, W0, { lengthOnly: true, privateAccess: { origin: true, dest: false } });
  if (!out) return { error: 'sin camino al núcleo' };
  const X = out.dest.node;
  const back = astarMultiSource(g, [{ node: X }], [cand], W0, { lengthOnly: true, privateAccess: { origin: false, dest: true } });
  if (!back) return { error: 'acceso de un solo sentido' };
  return { ep: { node: X }, lat: g.nodeLat[X], lon: g.nodeLon[X], nodes: [X], access: Math.max(out.sums.len, back.sums.len), kind: 'nodo X del núcleo' };
}

/** D14 ampliada (informativa): acceso hasta el núcleo principal si el ancla estricta no está en él. */
function extendedAnchorOf(lat, lon, strict) {
  if (!strict.error && strict.nodes.every((u) => block[u] === MAIN_BLOCK)) return null; // igual que la estricta
  const [cand] = snapCandidates(g, lat, lon, 1);
  if (!cand) return { error: 'sin snap' };
  const near = mainCoreNodes.filter((u) => haversine(lat, lon, g.nodeLat[u], g.nodeLon[u]) <= 60000).map((u) => ({ node: u }));
  const out = astarMultiSource(g, [cand], near, W0, { lengthOnly: true, privateAccess: { origin: true, dest: false } });
  if (!out) return { error: 'sin camino al núcleo principal' };
  const X = out.dest.node;
  const back = astarMultiSource(g, [{ node: X }], [cand], W0, { lengthOnly: true, privateAccess: { origin: false, dest: true } });
  if (!back) return { error: 'acceso de un solo sentido' };
  return { ep: { node: X }, lat: g.nodeLat[X], lon: g.nodeLon[X], nodes: [X], access: Math.max(out.sums.len, back.sums.len), kind: 'nodo X del núcleo principal' };
}

/** Clasifica un ancla para una longitud objetivo. */
function classify(anchor, Lkm) {
  const row = {};
  if (anchor.error) return { status: 'imposible', reason: anchor.error };
  row.anchor = anchor.kind;
  row.accessKm = +(anchor.access / 1000).toFixed(2);
  const L = Lkm * 1000;
  const Lmin = (1 - BAND) * L - 2 * anchor.access;
  const Lmax = (1 + BAND) * L - 2 * anchor.access;
  if (Lmax <= 0) return { ...row, status: 'imposible', reason: 'el acceso supera la banda' };
  const bound = structuralBound(anchor, Lmax / 2);
  row.upperKm = +(bound.total / 1000).toFixed(1);
  if (bound.total < Lmin) return { ...row, status: 'imposible', reason: `red disponible ${row.upperKm} km < ${(Lmin / 1000).toFixed(1)} km` };
  const cyc = minCycle(anchor);
  row.minCycleKm = Number.isFinite(cyc) ? +(cyc / 1000).toFixed(1) : null;
  if (cyc > Lmax) return { ...row, status: 'imposible', reason: `ciclo más corto por el origen ${row.minCycleKm ?? '∞'} km > ${(Lmax / 1000).toFixed(1)} km` };
  // Objetivo del circuito en X dentro de la banda (con un acceso largo, L − 2·acceso puede quedar negativo).
  const target = Math.min(Lmax, Math.max(L - 2 * anchor.access, Math.max(0, Lmin), Lmax / 2));
  const c = construct(anchor, Math.max(0, Lmin), Lmax, target, bound.nodes);
  row.tries = c.tries;
  row.closestKm = c.closest ? +((c.closest.len + 2 * anchor.access) / 1000).toFixed(1) : null;
  if (c.len !== null) return { ...row, status: 'factible', foundKm: +((c.len + 2 * anchor.access) / 1000).toFixed(1), method: c.method };
  return { ...row, status: 'indeterminado' };
}
const describe = (r) => (r.foundKm ? 'circuito ' + r.foundKm + ' km (' + r.method + ')' : r.reason || 'más cercano ' + r.closestKm + ' km');

// ── Medición ──
const t0 = Date.now();
const rows = [];
for (const [name, [lat, lon]] of origins) {
  const anchor = anchorOf(lat, lon);
  const ext = extendedAnchorOf(lat, lon, anchor);
  for (const Lkm of LENGTHS_KM) {
    const r = { origin: name, zone: zoneOf(name), L: Lkm, ...classify(anchor, Lkm) };
    if (ext) r.extended = classify(ext, Lkm);
    rows.push(r);
    console.log(`${name.padEnd(13)} ${r.zone.padEnd(13)} ${String(Lkm).padStart(3)} km  ${r.status.padEnd(13)} ${describe(r)} | red disponible ${r.upperKm ?? '—'} km, ciclo mínimo ${r.minCycleKm ?? '—'} km, acceso ${r.accessKm ?? '—'} km${r.extended ? ` | D14 ampliada: ${r.extended.status} (${describe(r.extended)}, acceso ${r.extended.accessKm ?? '—'} km)` : ''}`);
  }
}

// ── Informe ──
const lines = [];
const log = (s) => { lines.push(s); console.log(s); };
log(`\n## Techo estructural — ${new Date().toISOString()} — snapshot ${file.f} — ${origins.size} orígenes × ${LENGTHS_KM.length} longitudes, banda ±${100 * BAND}% — ${((Date.now() - t0) / 1000).toFixed(0)} s`);
const count = (f) => ({ imposible: rows.filter((r) => f(r) && r.status === 'imposible').length, factible: rows.filter((r) => f(r) && r.status === 'factible').length, indeterminado: rows.filter((r) => f(r) && r.status === 'indeterminado').length });
const fmt = (c) => `${String(c.imposible).padStart(3)} imposibles · ${String(c.factible).padStart(3)} factibles · ${String(c.indeterminado).padStart(3)} indeterminados`;
log('\nzona (orígenes)        longitud   resultado');
const summary = {};
for (const z of [...Object.keys(ZONES)]) {
  const n = new Set(rows.filter((r) => r.zone === z).map((r) => r.origin)).size;
  for (const Lkm of LENGTHS_KM) {
    const c = count((r) => r.zone === z && r.L === Lkm);
    (summary[z] = summary[z] || {})[Lkm] = c;
    log(`${(z + ' (' + n + ')').padEnd(22)} ${String(Lkm).padStart(4)} km   ${fmt(c)}`);
  }
}
for (const Lkm of LENGTHS_KM) log(`${'todas'.padEnd(22)} ${String(Lkm).padStart(4)} km   ${fmt(count((r) => r.L === Lkm))}`);
log(`${'total'.padEnd(22)} ${''.padStart(4)}      ${fmt(count(() => true))}`);
// Mismo resumen con la D14 ampliada (informativa).
const st = (r) => (r.extended ? r.extended.status : r.status);
const countExt = (f) => ({ imposible: rows.filter((r) => f(r) && st(r) === 'imposible').length, factible: rows.filter((r) => f(r) && st(r) === 'factible').length, indeterminado: rows.filter((r) => f(r) && st(r) === 'indeterminado').length });
log('');
log('Con la D14 ampliada (informativa: acceso hasta el núcleo principal)');
const summaryExt = {};
for (const z of Object.keys(ZONES)) for (const Lkm of LENGTHS_KM) {
  const c = countExt((r) => r.zone === z && r.L === Lkm);
  (summaryExt[z] = summaryExt[z] || {})[Lkm] = c;
  log(`${z.padEnd(22)} ${String(Lkm).padStart(4)} km   ${fmt(c)}`);
}
log(`${'total'.padEnd(22)} ${''.padStart(4)}      ${fmt(countExt(() => true))}`);
log('\n## Detalle');
for (const r of rows) log(`${r.zone.padEnd(13)} ${r.origin.padEnd(13)} ${String(r.L).padStart(3)} km  ${r.status.padEnd(13)} ${describe(r)} | red disponible ${r.upperKm ?? '—'} km | ciclo mínimo ${r.minCycleKm ?? '—'} km | acceso ${r.accessKm ?? '—'} km`);
const ext = rows.filter((r) => r.extended);
if (ext.length) {
  log('');
  log('## D14 ampliada (informativa): orígenes cuyo bloque no es el núcleo principal');
  for (const r of ext) log(`${r.zone.padEnd(13)} ${r.origin.padEnd(13)} ${String(r.L).padStart(3)} km  estricta: ${r.status.padEnd(13)} → ampliada: ${r.extended.status.padEnd(13)} ${describe(r.extended)} | acceso ${r.extended.accessKm ?? '—'} km`);
}
if (OUT_DIR) {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.writeFileSync(path.join(OUT_DIR, 'techo.json'), JSON.stringify({ date: new Date().toISOString(), snapshot: file.f, lengthsKm: LENGTHS_KM, band: BAND, zones: ZONES, summary, summaryExtendedD14: summaryExt, rows }, null, 1));
  fs.writeFileSync(path.join(OUT_DIR, 'report.txt'), lines.join('\n') + '\n');
  console.log(`→ ${OUT_DIR}/{techo.json, report.txt}`);
}
