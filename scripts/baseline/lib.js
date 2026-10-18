// Utilidades de la línea base. Leen Mongo en modo solo lectura y NO usan el
// código del motor: las métricas deben ser comparables entre fases aunque el
// motor cambie por completo.
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

/** Carga nodos y aristas a arrays tipados + CSR de salida. */
async function loadRaw(uri = process.env.MONGO_URI || 'mongodb://localhost:27017/generador-rutas') {
  await mongoose.connect(uri);
  const db = mongoose.connection.db;
  const t0 = Date.now();
  const nd = await db.collection('nodes').find({}, { projection: { _id: 0, osmId: 1, lat: 1, lon: 1 } }).toArray();
  const ed = await db.collection('edges').find({}, { projection: { _id: 0, fromOsmId: 1, toOsmId: 1, distanceMeters: 1, curviness: 1, highwayType: 1, surface: 1, osmWayId: 1 } }).toArray();
  await mongoose.disconnect();
  const N = nd.length;
  const idx = new Map();
  const lat = new Float64Array(N), lon = new Float64Array(N);
  nd.forEach((n, i) => { idx.set(n.osmId, i); lat[i] = n.lat; lon[i] = n.lon; });
  const ok = ed.filter((e) => idx.has(e.fromOsmId) && idx.has(e.toOsmId));
  const M = ok.length;
  const eFrom = new Int32Array(M), eTo = new Int32Array(M), eLen = new Float64Array(M), eCurv = new Float32Array(M);
  const eHw = new Uint8Array(M), eSurf = new Uint8Array(M), eWay = new Float64Array(M);
  ok.forEach((e, k) => {
    eFrom[k] = idx.get(e.fromOsmId); eTo[k] = idx.get(e.toOsmId); eLen[k] = e.distanceMeters; eCurv[k] = e.curviness;
    const h = HW.indexOf(e.highwayType); eHw[k] = h < 0 ? 6 : h;
    const s = SURF.indexOf(e.surface); eSurf[k] = s < 0 ? 6 : s;
    eWay[k] = Number(e.osmWayId || 0);
  });
  const off = new Int32Array(N + 1);
  for (let k = 0; k < M; k++) off[eFrom[k] + 1]++;
  for (let i = 0; i < N; i++) off[i + 1] += off[i];
  const pos = off.slice(0, N); const outE = new Int32Array(M);
  for (let k = 0; k < M; k++) outE[pos[eFrom[k]]++] = k;
  return { N, M, idx, lat, lon, eFrom, eTo, eLen, eCurv, eHw, eSurf, eWay, off, outE, loadMs: Date.now() - t0 };
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
 * Sinuosidad propuesta (ver docs/PLAN_MOTOR.md §1.1): densidad de giro en °/km.
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
function shortestLen(g, s, t) {
  const dist = new Float64Array(g.N).fill(Infinity); const vis = new Uint8Array(g.N); const H = new Heap();
  dist[s] = 0; H.push(s, 0);
  while (H.size) {
    const u = H.pop(); if (vis[u]) continue; vis[u] = 1; if (u === t) return dist[t];
    for (let p = g.off[u]; p < g.off[u + 1]; p++) { const k = g.outE[p]; const v = g.eTo[k]; const nd = dist[u] + g.eLen[k]; if (nd < dist[v]) { dist[v] = nd; H.push(v, nd); } }
  }
  return Infinity;
}

module.exports = { HW, SURF, SURF_CAT, hav, loadRaw, wayPolylines, curvature, edgeDensity, forEachEdgeBetween, shortestLen };
