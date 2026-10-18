// Utilidades de la línea base. Leen Mongo en modo solo lectura y NO usan el
// código del motor: las métricas deben ser comparables entre fases aunque el
// motor cambie por completo.
//
// Fuente de datos (BASELINE_SOURCE):
// - `osm` (por defecto desde F0.1): almacén por way. La topología (segmentos,
//   sentidos, exclusiones D7) sale del compilador del backend
//   (dist/graph-compiler; requiere `npm run build`), para medir el desvío sobre
//   el mismo grafo que rutea. La superficie se toma del tag crudo con el mapeo
//   de abajo, para que la métrica no cambie cuando cambie la normalización.
// - `legacy`: colecciones anteriores a F0.1 (`nodes`/`edges`).
const path = require('path');
const mongoose = require('mongoose');

const R0 = 6371000;
const D2R = Math.PI / 180;
const HW = ['motorway', 'trunk', 'primary', 'secondary', 'tertiary', 'unclassified', 'residential', 'track', 'path', 'service'];
const SURF = ['asphalt', 'concrete', 'cobblestone', 'gravel', 'dirt', 'sand', 'unknown'];
const SURF_CAT = { asphalt: 'paved', concrete: 'paved', cobblestone: 'paved', gravel: 'unpaved', dirt: 'unpaved', sand: 'unpaved', unknown: 'unknown' };

function hav(lat1, lon1, lat2, lon2) {
  const dLat = (lat2 - lat1) * D2R, dLon = (lon2 - lon1) * D2R;
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * D2R) * Math.cos(lat2 * D2R) * Math.sin(dLon / 2) ** 2;
  return R0 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

/** Mapeo de `surface` crudo → categoría, congelado para la línea base (igual al parser anterior a F0). */
function surfaceOf(value) {
  if (!value) return 'unknown';
  if (SURF.includes(value)) return value;
  if (value.startsWith('paved') || value === 'paving_stones') return 'concrete';
  if (value === 'unpaved' || value === 'compacted' || value === 'fine_gravel') return 'gravel';
  if (value === 'ground' || value === 'earth' || value === 'mud') return 'dirt';
  return 'unknown';
}

async function loadLegacy(db) {
  const nd = await db.collection('nodes').find({}, { projection: { _id: 0, osmId: 1, lat: 1, lon: 1 } }).toArray();
  const ed = await db.collection('edges').find({}, { projection: { _id: 0, fromOsmId: 1, toOsmId: 1, distanceMeters: 1, curviness: 1, highwayType: 1, surface: 1, osmWayId: 1 } }).toArray();
  return { nd, ed };
}

async function loadOsm(db) {
  const { deriveGraph } = require(path.join(__dirname, '..', '..', 'dist', 'graph-compiler', 'derive'));
  const [ways, nodes] = await Promise.all([
    db.collection('osm_ways').find({}, { projection: { _id: 0, osmWayId: 1, nodeIds: 1, tags: 1 } }).toArray(),
    db.collection('osm_nodes').find({}, { projection: { _id: 0, osmId: 1, lat: 1, lon: 1 } }).toArray(),
  ]);
  const coords = new Map(nodes.map((n) => [n.osmId, n]));
  const rawSurface = new Map(ways.map((w) => [w.osmWayId, surfaceOf(w.tags && w.tags.surface)]));
  const derived = deriveGraph(ways, (id) => coords.get(id));
  const ed = derived.edges.map((e) => ({ ...e, surface: rawSurface.get(e.osmWayId) }));
  return { nd: derived.nodes, ed };
}

/** Carga nodos y aristas a arrays tipados + CSR de salida. */
async function loadRaw(uri = process.env.MONGO_URI || 'mongodb://localhost:27017/generador-rutas') {
  await mongoose.connect(uri);
  const db = mongoose.connection.db;
  const t0 = Date.now();
  const source = process.env.BASELINE_SOURCE === 'legacy' ? 'legacy' : 'osm';
  const { nd, ed } = source === 'legacy' ? await loadLegacy(db) : await loadOsm(db);
  await mongoose.disconnect();
  const N = nd.length;
  const idx = new Map();
  const lat = new Float64Array(N), lon = new Float64Array(N);
  nd.forEach((n, i) => { idx.set(n.osmId, i); lat[i] = n.lat; lon[i] = n.lon; });
  const ok = ed.filter((e) => idx.has(e.fromOsmId) && idx.has(e.toOsmId));
  const M = ok.length;
  const eFrom = new Int32Array(M), eTo = new Int32Array(M), eLen = new Float64Array(M), eCurv = new Float32Array(M);
  const eHw = new Uint8Array(M), eSurf = new Uint8Array(M), eWay = new Float64Array(M), ePriv = new Uint8Array(M);
  ok.forEach((e, k) => {
    eFrom[k] = idx.get(e.fromOsmId); eTo[k] = idx.get(e.toOsmId); eLen[k] = e.distanceMeters; eCurv[k] = e.curviness;
    // Tipos fuera de HW (living_street) cuentan como residential para las métricas.
    const h = HW.indexOf(e.highwayType); eHw[k] = h < 0 ? 6 : h;
    const s = SURF.indexOf(e.surface); eSurf[k] = s < 0 ? 6 : s;
    eWay[k] = Number(e.osmWayId || 0);
    ePriv[k] = e.destinationOnly ? 1 : 0;
  });
  const off = new Int32Array(N + 1);
  for (let k = 0; k < M; k++) off[eFrom[k] + 1]++;
  for (let i = 0; i < N; i++) off[i + 1] += off[i];
  const pos = off.slice(0, N); const outE = new Int32Array(M);
  for (let k = 0; k < M; k++) outE[pos[eFrom[k]]++] = k;
  const g = { N, M, idx, lat, lon, eFrom, eTo, eLen, eCurv, eHw, eSurf, eWay, ePriv, off, outE, source, loadMs: Date.now() - t0 };
  // Desde F0.4 el compilador entrega la sinuosidad nueva; la columna "métrica vieja"
  // se recalcula aquí con la fórmula congelada, para que siga siendo comparable.
  if (source === 'osm') g.eCurv = oldCurviness(g);
  if (source === 'osm') g.enclaveEdges = markEnclaves(g);
  return g;
}

/**
 * D16, igual que el compilador: las aristas públicas que no se pueden alcanzar
 * desde la red pública principal, o desde las que no se puede volver a ella sin
 * vías privadas, se tratan como parte del área privada vecina. La red principal
 * es la componente fuertemente conexa (solo aristas públicas) que contiene al
 * nodo más cercano a Plaza de Armas. Devuelve cuántas aristas se marcaron.
 */
function markEnclaves(g) {
  const inOff = new Int32Array(g.N + 1);
  for (let k = 0; k < g.M; k++) inOff[g.eTo[k] + 1]++;
  for (let i = 0; i < g.N; i++) inOff[i + 1] += inOff[i];
  const pos = inOff.slice(0, g.N); const inE = new Int32Array(g.M);
  for (let k = 0; k < g.M; k++) inE[pos[g.eTo[k]]++] = k;
  let seed = 0, bd = Infinity;
  for (let i = 0; i < g.N; i++) { const d = hav(-33.4378, -70.6505, g.lat[i], g.lon[i]); if (d < bd && g.off[i + 1] > g.off[i]) { bd = d; seed = i; } }
  const reach = (fwd, withPrivate) => {
    const seen = new Uint8Array(g.N); const q = [seed]; seen[seed] = 1;
    while (q.length) {
      const u = q.pop();
      const a = fwd ? g.off[u] : inOff[u], b = fwd ? g.off[u + 1] : inOff[u + 1];
      for (let p = a; p < b; p++) { const k = fwd ? g.outE[p] : inE[p]; if (g.ePriv[k] && !withPrivate) continue; const v = fwd ? g.eTo[k] : g.eFrom[k]; if (!seen[v]) { seen[v] = 1; q.push(v); } }
    }
    return seen;
  };
  const R = reach(true, false), coR = reach(false, false);
  const Rall = reach(true, true), coRall = reach(false, true);
  let n = 0;
  for (let k = 0; k < g.M; k++) {
    if (g.ePriv[k]) continue;
    const u = g.eFrom[k], v = g.eTo[k];
    // Conectada a la red (ida y vuelta usando también vías privadas) pero no solo por vías públicas.
    if (Rall[u] && coRall[v] && !(R[u] && coR[v])) { g.ePriv[k] = 1; n++; }
  }
  return n;
}

function forEachEdgeBetween(g, u, v, cb) {
  for (let p = g.off[u]; p < g.off[u + 1]; p++) { const k = g.outE[p]; if (g.eTo[k] === v) cb(k); }
  for (let p = g.off[v]; p < g.off[v + 1]; p++) { const k = g.outE[p]; if (g.eTo[k] === u) cb(k); }
}

/** Reconstruye la secuencia de nodos de cada way (puede dar >1 polilínea si hay restos obsoletos). */
function wayPolylines(g) {
  const byWay = new Map();
  for (let k = 0; k < g.M; k++) {
    const w = g.eWay[k]; const u = g.eFrom[k], v = g.eTo[k];
    let m = byWay.get(w); if (!m) { m = new Map(); byWay.set(w, m); }
    (m.get(u) || m.set(u, new Set()).get(u)).add(v);
    (m.get(v) || m.set(v, new Set()).get(v)).add(u);
  }
  const polys = [];
  for (const [w, m] of byWay) {
    const used = new Set(); const K = (a, b) => (a < b ? a + ',' + b : b + ',' + a);
    const starts = [...m.keys()].sort((a, b) => (m.get(a).size === 1 ? -1 : 0) - (m.get(b).size === 1 ? -1 : 0));
    for (const s of starts) {
      for (const n0 of m.get(s)) {
        if (used.has(K(s, n0))) continue;
        const seq = [s, n0]; used.add(K(s, n0)); let prev = s, cur = n0;
        while (true) {
          let nx = -1; for (const x of m.get(cur)) if (x !== prev && !used.has(K(cur, x))) { nx = x; break; }
          if (nx < 0) break; used.add(K(cur, nx)); seq.push(nx); prev = cur; cur = nx;
        }
        polys.push({ way: w, nodes: seq });
      }
    }
  }
  return { polys };
}

/**
 * Sinuosidad propuesta (ver el plan de desarrollo, §1.1): densidad de giro en °/km.
 * - rumbo en cada punto (paso `step`) = cuerda de largo W centrada (recortada en extremos)
 * - histéresis: solo se acumula giro cuando el rumbo se aparta >= theta de la referencia
 * - densidad de cada segmento = giros dentro de ±R de su punto medio / (2R)
 */
function curvature(lats, lons, { W = 100, theta = 5, step = 10, R = 150 } = {}) {
  const n = lats.length;
  const cos0 = Math.cos(lats[0] * D2R);
  const x = new Float64Array(n), y = new Float64Array(n), s = new Float64Array(n);
  for (let i = 0; i < n; i++) { x[i] = R0 * lons[i] * D2R * cos0; y[i] = R0 * lats[i] * D2R; if (i) s[i] = s[i - 1] + Math.hypot(x[i] - x[i - 1], y[i] - y[i - 1]); }
  const L = s[n - 1];
  const dens = new Float64Array(n - 1);
  if (!(L > 0)) return { dens, total: 0, L: 0 };
  const at = (q) => { let lo = 0, hi = n - 1; while (hi - lo > 1) { const m = (lo + hi) >> 1; if (s[m] <= q) lo = m; else hi = m; } const t = s[hi] > s[lo] ? (q - s[lo]) / (s[hi] - s[lo]) : 0; return [x[lo] + t * (x[hi] - x[lo]), y[lo] + t * (y[hi] - y[lo])]; };
  const evQ = [], evM = []; let ref = null; let total = 0; const half = W / 2;
  for (let q = 0; q <= L + 1e-9; q += step) {
    const a = Math.max(0, q - half), b = Math.min(L, q + half);
    if (b - a < step) continue;
    const pa = at(a), pb = at(b);
    const h = Math.atan2(pb[0] - pa[0], pb[1] - pa[1]) / D2R;
    if (ref === null) { ref = h; continue; }
    let d = h - ref; d = ((d + 540) % 360) - 180;
    if (Math.abs(d) >= theta) { evQ.push(q); evM.push(Math.abs(d)); total += Math.abs(d); ref = h; }
  }
  let lo = 0, hi = 0, sum = 0;
  for (let i = 0; i < n - 1; i++) {
    const m = (s[i] + s[i + 1]) / 2;
    while (hi < evQ.length && evQ[hi] <= m + R) { sum += evM[hi]; hi++; }
    while (lo < hi && evQ[lo] < m - R) { sum -= evM[lo]; lo++; }
    dens[i] = sum / ((2 * R) / 1000);
  }
  return { dens, total, L };
}

/** Densidad de giro por arista cruda (Float32Array de tamaño M), calculada por way. */
function edgeDensity(g, polys, params) {
  const out = new Float32Array(g.M);
  for (const p of polys) {
    const nodes = p.nodes; if (nodes.length < 2) continue;
    const { dens } = curvature(nodes.map((i) => g.lat[i]), nodes.map((i) => g.lon[i]), params);
    for (let i = 0; i < nodes.length - 1; i++) forEachEdgeBetween(g, nodes[i], nodes[i + 1], (k) => { out[k] = dens[i]; });
  }
  return out;
}

class Heap {
  constructor() { this.k = []; this.v = []; }
  get size() { return this.k.length; }
  push(v, k) { const K = this.k, V = this.v; let i = K.length; K.push(k); V.push(v); while (i > 0) { const p = (i - 1) >> 1; if (K[p] <= k) break; K[i] = K[p]; V[i] = V[p]; i = p; } K[i] = k; V[i] = v; }
  pop() { const K = this.k, V = this.v; const tv = V[0]; const lk = K.pop(), lv = V.pop(); const n = K.length; if (n > 0) { let i = 0; while (true) { const l = 2 * i + 1; if (l >= n) break; const r = l + 1; const m = (r < n && K[r] < K[l]) ? r : l; if (K[m] >= lk) break; K[i] = K[m]; V[i] = V[m]; i = m; } K[i] = lk; V[i] = lv; } return tv; }
}

/** Distancia mínima pura (metros) entre dos nodos del grafo crudo. */
/**
 * Vías privadas (D7): solo en el tramo inicial/final, igual que el motor. Una
 * arista privada u→v es usable si u es interior del área privada del origen o
 * v es interior del área privada del destino (interior = todas sus aristas
 * salientes son privadas; el recorrido se detiene en el portón). El nodo de
 * inicio y el de fin siempre abren su acceso: con los nodos fantasma (F0.3) la
 * ruta puede empezar a mitad de un tramo privado cuyo primer nodo es el portón.
 */
function privateAllowance(g, s, t) {
  const inside = (u) => { const a = g.off[u], b = g.off[u + 1]; if (a === b) return false; for (let p = a; p < b; p++) if (!g.ePriv[g.outE[p]]) return false; return true; };
  if (!g.ePriv || !g.ePriv.some((x) => x)) return null;
  if (!g.privIn) { // aristas privadas entrantes por nodo (una vez)
    g.privIn = new Map();
    for (let k = 0; k < g.M; k++) if (g.ePriv[k]) { const v = g.eTo[k]; (g.privIn.get(v) || g.privIn.set(v, []).get(v)).push(k); }
  }
  const fromOrigin = new Set(), toDest = new Set();
  { const q = [s]; fromOrigin.add(s); while (q.length) { const u = q.pop(); for (let p = g.off[u]; p < g.off[u + 1]; p++) { const k = g.outE[p], v = g.eTo[k]; if (g.ePriv[k] && !fromOrigin.has(v) && inside(v)) { fromOrigin.add(v); q.push(v); } } } }
  { const q = [t]; toDest.add(t); while (q.length) { const v = q.pop(); for (const k of g.privIn.get(v) || []) { const u = g.eFrom[k]; if (!toDest.has(u) && inside(u)) { toDest.add(u); q.push(u); } } } }
  return { fromOrigin, toDest };
}

/** Distancia mínima pura (metros) entre dos nodos, con la misma regla de vías privadas que el motor. */
function shortestLen(g, s, t) {
  const priv = privateAllowance(g, s, t);
  const dist = new Float64Array(g.N).fill(Infinity); const vis = new Uint8Array(g.N); const H = new Heap();
  dist[s] = 0; H.push(s, 0);
  while (H.size) {
    const u = H.pop(); if (vis[u]) continue; vis[u] = 1; if (u === t) return dist[t];
    for (let p = g.off[u]; p < g.off[u + 1]; p++) {
      const k = g.outE[p]; const v = g.eTo[k];
      if (g.ePriv && g.ePriv[k] && !(priv && (priv.fromOrigin.has(u) || priv.toDest.has(v)))) continue;
      const nd = dist[u] + g.eLen[k]; if (nd < dist[v]) { dist[v] = nd; H.push(v, nd); }
    }
  }
  return Infinity;
}

/** Sinuosidad anterior a F0.4 (giro de cada vértice / largo de un segmento, mapeado 10→0, 130→1 °/km), por way. */
function oldCurviness(g) {
  const out = new Float32Array(g.M);
  const bearing = (la1, lo1, la2, lo2) => { const p1 = la1 * D2R, p2 = la2 * D2R, dl = (lo2 - lo1) * D2R; const y = Math.sin(dl) * Math.cos(p2); const x = Math.cos(p1) * Math.sin(p2) - Math.sin(p1) * Math.cos(p2) * Math.cos(dl); return ((Math.atan2(y, x) / D2R) + 360) % 360; };
  const adiff = (a, b) => { const d = Math.abs(a - b) % 360; return d > 180 ? 360 - d : d; };
  for (const p of wayPolylines(g).polys) {
    const ns = p.nodes; const n = ns.length; if (n < 3) continue;
    const b = []; for (let i = 0; i < n - 1; i++) b.push(bearing(g.lat[ns[i]], g.lon[ns[i]], g.lat[ns[i + 1]], g.lon[ns[i + 1]]));
    for (let i = 0; i < n - 1; i++) {
      const t = i < n - 2 ? adiff(b[i], b[i + 1]) : adiff(b[i - 1], b[i]);
      const km = hav(g.lat[ns[i]], g.lon[ns[i]], g.lat[ns[i + 1]], g.lon[ns[i + 1]]) / 1000;
      const v = Math.min(1, Math.max(0, ((km > 0 ? t / km : 0) - 10) / 120));
      forEachEdgeBetween(g, ns[i], ns[i + 1], (k) => { out[k] = v; });
    }
  }
  return out;
}

/**
 * Dijkstra genérico sobre el grafo crudo con la regla de vías privadas del motor.
 * costOf(k) = costo de la arista k. Devuelve { len, crit } (metros totales y
 * metros con crit[k] = 1) o null si no hay camino.
 */
function routeWith(g, s, t, costOf, crit) {
  const priv = privateAllowance(g, s, t);
  if (!g._ws) g._ws = { dist: new Float64Array(g.N), stamp: new Uint32Array(g.N), vis: new Uint32Array(g.N), prev: new Int32Array(g.N), st: 0 };
  const W = g._ws; const st = ++W.st; const H = new Heap();
  W.dist[s] = 0; W.stamp[s] = st; W.prev[s] = -1; H.push(s, 0);
  while (H.size) {
    const u = H.pop(); if (W.vis[u] === st) continue; W.vis[u] = st; if (u === t) break;
    for (let p = g.off[u]; p < g.off[u + 1]; p++) {
      const k = g.outE[p]; const v = g.eTo[k]; if (W.vis[v] === st) continue;
      if (g.ePriv && g.ePriv[k] && !(priv && (priv.fromOrigin.has(u) || priv.toDest.has(v)))) continue;
      const nd = W.dist[u] + costOf(k);
      if (W.stamp[v] !== st || nd < W.dist[v]) { W.dist[v] = nd; W.stamp[v] = st; W.prev[v] = k; H.push(v, nd); }
    }
  }
  if (W.vis[t] !== st) return null;
  let len = 0, ok = 0;
  for (let u = t; W.prev[u] >= 0; u = g.eFrom[W.prev[u]]) { const k = W.prev[u]; len += g.eLen[k]; if (crit && crit[k]) ok += g.eLen[k]; }
  return { len, crit: ok };
}

/**
 * Envolvente de LARAC para un criterio: todas las rutas que minimizan
 * (metros que NO cumplen) + λ·largo para algún λ ≥ 0, desde la que más cumple
 * (λ→0) hasta la más corta (λ→∞). Se recorre exactamente buscando el λ donde
 * dos vértices empatan (búsqueda paramétrica), ~2 Dijkstra por vértice.
 * Devuelve los vértices { len, crit } ordenados por largo.
 */
function criterionHull(g, s, t, crit) {
  const pt = (r) => r && { len: r.len, crit: r.crit, nc: r.len - r.crit };
  const run = (lambda) => pt(routeWith(g, s, t, (k) => (crit[k] ? 0 : g.eLen[k]) + lambda * g.eLen[k], crit));
  // Extremos con desempate: el que menos no-criterio tiene (y, entre esos, el más corto), y el más corto.
  const A = run(1e-6);
  if (!A) return null;
  const B = pt(routeWith(g, s, t, (k) => g.eLen[k] * (1 + (crit[k] ? 0 : 1e-6)), crit));
  const out = [A];
  const walk = (a, b) => {
    if (a.len - b.len < 1e-6) return;
    const lambda = (b.nc - a.nc) / (a.len - b.len);
    if (!(lambda > 0)) return;
    const c = run(lambda);
    if (c.nc + lambda * c.len < a.nc + lambda * a.len - 1e-6) { walk(a, c); out.push(c); walk(c, b); }
  };
  walk(A, B);
  if (B.len < A.len - 1e-6) out.push(B);
  return out.sort((x, y) => x.len - y.len);
}

/**
 * Máximo alcanzable del criterio (D2): la mayor fracción de metros que cumplen
 * el criterio entre los vértices de la envolvente de LARAC con largo ≤ budget ×
 * distancia mínima. Es una cota factible (puede quedar bajo el óptimo real por
 * la brecha de dualidad). `hull` permite reutilizar la envolvente entre presupuestos.
 */
function maxCriterion(g, s, t, crit, budget, hull = criterionHull(g, s, t, crit)) {
  if (!hull) return null;
  const shortest = hull[0].len;
  let share = 0;
  for (const h of hull) if (h.len <= budget * shortest + 1e-6 && h.len > 0) share = Math.max(share, h.crit / h.len);
  return { share, shortest };
}

module.exports = { HW, SURF, SURF_CAT, hav, loadRaw, wayPolylines, curvature, edgeDensity, forEachEdgeBetween, shortestLen, routeWith, criterionHull, maxCriterion };
