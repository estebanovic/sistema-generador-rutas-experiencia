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
  return g;
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
 * salientes son privadas; el recorrido se detiene en el portón).
 */
function privateAllowance(g, s, t) {
  const inside = (u) => { const a = g.off[u], b = g.off[u + 1]; if (a === b) return false; for (let p = a; p < b; p++) if (!g.ePriv[g.outE[p]]) return false; return true; };
  if (!g.ePriv || !g.ePriv.some((x) => x)) return null;
  if (!g.privIn) { // aristas privadas entrantes por nodo (una vez)
    g.privIn = new Map();
    for (let k = 0; k < g.M; k++) if (g.ePriv[k]) { const v = g.eTo[k]; (g.privIn.get(v) || g.privIn.set(v, []).get(v)).push(k); }
  }
  const fromOrigin = new Set(), toDest = new Set();
  if (inside(s)) { const q = [s]; fromOrigin.add(s); while (q.length) { const u = q.pop(); for (let p = g.off[u]; p < g.off[u + 1]; p++) { const k = g.outE[p], v = g.eTo[k]; if (g.ePriv[k] && !fromOrigin.has(v) && inside(v)) { fromOrigin.add(v); q.push(v); } } } }
  if (inside(t)) { const q = [t]; toDest.add(t); while (q.length) { const v = q.pop(); for (const k of g.privIn.get(v) || []) { const u = g.eFrom[k]; if (!toDest.has(u) && inside(u)) { toDest.add(u); q.push(u); } } } }
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

module.exports = { HW, SURF, SURF_CAT, hav, loadRaw, wayPolylines, curvature, edgeDensity, forEachEdgeBetween, shortestLen };
