// Informe del grafo derivado del almacén por way (osm_ways/osm_nodes).
// Uso: npm run build && node --max-old-space-size=8192 scripts/graph-report.js [salida.json]
//
// - Conectividad: componentes fuertemente conexas (CFC), % de nodos en la mayor
//   y clasificación de las islas por causa probable.
// - Impacto de cada regla de exclusión (D7): qué parte de la red queda fuera de
//   la CFC mayor por culpa de esa regla.
// - Validaciones de F0.1: L == haversine, ways sin re-nodeo, ramales presentes.
// Usa el compilador compilado (dist/graph-compiler), así que mide exactamente lo
// que deriva el backend.
const fs = require('fs');
const mongoose = require('mongoose');
const { deriveGraph } = require('../dist/graph-compiler/derive');
const { ALL_EXCLUSION_RULES } = require('../dist/graph-compiler/normalize');
const { haversine } = require('../dist/graph-compiler/geo');

const OUT = process.argv[2];

async function load() {
  await mongoose.connect(process.env.MONGO_URI || 'mongodb://localhost:27017/generador-rutas');
  const db = mongoose.connection.db;
  const [ways, nodes, imports] = await Promise.all([
    db.collection('osm_ways').find({}, { projection: { _id: 0, osmWayId: 1, nodeIds: 1, tags: 1 } }).toArray(),
    db.collection('osm_nodes').find({}, { projection: { _id: 0, osmId: 1, lat: 1, lon: 1 } }).toArray(),
    db.collection('osm_imports').find({}, { projection: { _id: 0, bbox: 1 } }).toArray(),
  ]);
  await mongoose.disconnect();
  const coords = new Map(nodes.map((n) => [n.osmId, { lat: n.lat, lon: n.lon }]));
  return { ways, coords, imports };
}

/** Grafo derivado → índices enteros + CSR + CFC (Tarjan iterativo). */
function analyze(derived) {
  const idx = new Map();
  const lat = [], lon = [];
  for (const n of derived.nodes) { idx.set(n.osmId, lat.length); lat.push(n.lat); lon.push(n.lon); }
  const N = lat.length, M = derived.edges.length;
  const from = new Int32Array(M), to = new Int32Array(M), len = new Float64Array(M);
  derived.edges.forEach((e, k) => { from[k] = idx.get(e.fromOsmId); to[k] = idx.get(e.toOsmId); len[k] = e.distanceMeters; });
  const off = new Int32Array(N + 1);
  for (let k = 0; k < M; k++) off[from[k] + 1]++;
  for (let i = 0; i < N; i++) off[i + 1] += off[i];
  const pos = off.slice(0, N), adj = new Int32Array(M);
  for (let k = 0; k < M; k++) adj[pos[from[k]]++] = to[k];

  const order = new Int32Array(N).fill(-1), low = new Int32Array(N), onS = new Uint8Array(N), comp = new Int32Array(N).fill(-1);
  const stack = []; let counter = 0, nc = 0;
  const cs = [];
  for (let s = 0; s < N; s++) {
    if (order[s] >= 0) continue;
    order[s] = low[s] = counter++; stack.push(s); onS[s] = 1; cs.push(s, off[s]);
    while (cs.length) {
      const u = cs[cs.length - 2], p = cs[cs.length - 1];
      if (p < off[u + 1]) {
        cs[cs.length - 1] = p + 1;
        const v = adj[p];
        if (order[v] < 0) { order[v] = low[v] = counter++; stack.push(v); onS[v] = 1; cs.push(v, off[v]); }
        else if (onS[v] && order[v] < low[u]) low[u] = order[v];
      } else {
        cs.length -= 2;
        if (cs.length) { const w = cs[cs.length - 2]; if (low[u] < low[w]) low[w] = low[u]; }
        if (low[u] === order[u]) { let w; do { w = stack.pop(); onS[w] = 0; comp[w] = nc; } while (w !== u); nc++; }
      }
    }
  }
  const size = new Map();
  for (let i = 0; i < N; i++) size.set(comp[i], (size.get(comp[i]) || 0) + 1);
  let big = -1, bigSize = 0;
  for (const [c, s] of size) if (s > bigSize) { big = c; bigSize = s; }
  let km = 0, kmBig = 0;
  for (let k = 0; k < M; k++) { km += len[k]; if (comp[from[k]] === big && comp[to[k]] === big) kmBig += len[k]; }
  return { idx, lat, lon, N, M, from, to, len, comp, big, bigSize, nComp: nc, km: km / 2000, kmBig: kmBig / 2000 };
}

/** Agrupa nodos (índices de `a`) en grupos conectados en el grafo no dirigido. */
function clusters(a, nodeSet) {
  const nb = new Map();
  for (let k = 0; k < a.M; k++) {
    const u = a.from[k], v = a.to[k];
    if (!nodeSet.has(u) || !nodeSet.has(v)) continue;
    (nb.get(u) || nb.set(u, []).get(u)).push(v);
    (nb.get(v) || nb.set(v, []).get(v)).push(u);
  }
  const seen = new Set(), out = [];
  for (const s of nodeSet) {
    if (seen.has(s)) continue;
    const q = [s]; seen.add(s); const members = [];
    while (q.length) { const u = q.pop(); members.push(u); for (const v of nb.get(u) || []) if (!seen.has(v)) { seen.add(v); q.push(v); } }
    let la = 0, lo = 0; for (const m of members) { la += a.lat[m]; lo += a.lon[m]; }
    out.push({ nodes: members.length, centro: [+(la / members.length).toFixed(4), +(lo / members.length).toFixed(4)], members });
  }
  return out.sort((x, y) => y.nodes - x.nodes);
}

function kmOf(a, nodeSet) {
  let m = 0;
  for (let k = 0; k < a.M; k++) if (nodeSet.has(a.from[k]) && nodeSet.has(a.to[k])) m += a.len[k];
  return m / 2000;
}

(async () => {
  const t0 = Date.now();
  const { ways, coords, imports } = await load();
  const coordsOf = (id) => coords.get(id);
  const report = { fecha: new Date().toISOString(), ways: ways.length, nodosAlmacen: coords.size };

  // Extensión importada (unión de bboxes de los imports).
  const ext = imports.reduce((e, i) => ({
    south: Math.min(e.south, i.bbox.south), west: Math.min(e.west, i.bbox.west),
    north: Math.max(e.north, i.bbox.north), east: Math.max(e.east, i.bbox.east),
  }), { south: 90, west: 180, north: -90, east: -180 });
  report.extension = ext;

  // ── Grafo con todas las reglas ──
  const full = deriveGraph(ways, coordsOf);
  const A = analyze(full);
  report.grafo = {
    nodos: A.N, aristas: A.M, km: +A.km.toFixed(0), componentes: A.nComp,
    cfcMayorNodos: A.bigSize, cfcMayorPct: +(100 * A.bigSize / A.N).toFixed(2), cfcMayorKmPct: +(100 * A.kmBig / A.km).toFixed(2),
    excluidosPorRegla: Object.fromEntries(Object.entries(full.stats.excluded).map(([r, v]) => [r, { ways: v.ways, km: +v.km.toFixed(1) }])),
    referenciasANodosFaltantes: full.stats.missingNodeRefs,
    soloOrigenDestino: { ways: full.stats.destinationOnly.ways, km: +full.stats.destinationOnly.km.toFixed(1) },
  };

  // ── Validaciones F0.1 ──
  let menorHav = 0;
  for (const e of full.edges) {
    const p = coords.get(e.fromOsmId), q = coords.get(e.toOsmId);
    if (e.distanceMeters < haversine(p.lat, p.lon, q.lat, q.lon) - 1e-6) menorHav++;
  }
  let renodeados = 0;
  for (const w of ways) {
    const nb = new Map();
    for (let i = 0; i < w.nodeIds.length - 1; i++) {
      const a = w.nodeIds[i], b = w.nodeIds[i + 1];
      (nb.get(a) || nb.set(a, new Set()).get(a)).add(b);
      (nb.get(b) || nb.set(b, new Set()).get(b)).add(a);
    }
    for (const s of nb.values()) if (s.size > 2) { renodeados++; break; }
  }
  const porHighway = {};
  for (const w of ways) porHighway[w.tags.highway] = (porHighway[w.tags.highway] || 0) + 1;
  report.validaciones = { aristasLargoMenorQueHaversine: menorHav, waysQueSeAutoIntersectan: renodeados, waysPorHighway: porHighway };

  // ── Islas: causa probable ──
  const fuera = new Set();
  for (let i = 0; i < A.N; i++) if (A.comp[i] !== A.big) fuera.add(i);
  const borde = 0.01; // ~1 km del borde de la extensión importada
  const isl = clusters(A, fuera).map((c) => {
    const tocaBorde = c.members.some((m) => A.lat[m] < ext.south + borde || A.lat[m] > ext.north - borde || A.lon[m] < ext.west + borde || A.lon[m] > ext.east - borde);
    return { nodos: c.nodes, km: +kmOf(A, new Set(c.members)).toFixed(2), centro: c.centro, tocaBorde, members: c.members };
  });

  // ── Impacto de cada regla: nodos que salen de la CFC mayor por esa regla ──
  report.impactoReglas = {};
  const idsFuera = new Set([...fuera].map((i) => full.nodes[i].osmId));
  const recuperablesPorRegla = new Map();
  for (const rule of ALL_EXCLUSION_RULES) {
    const rules = new Set(ALL_EXCLUSION_RULES.filter((r) => r !== rule));
    const B = analyze(deriveGraph(ways, coordsOf, { rules }));
    // Nodos del grafo completo que están fuera de su CFC mayor pero dentro de la CFC mayor sin esta regla.
    const recuperados = new Set();
    for (const id of idsFuera) { const j = B.idx.get(id); if (j !== undefined && B.comp[j] === B.big) recuperados.add(A.idx.get(id)); }
    recuperablesPorRegla.set(rule, recuperados);
    const grupos = clusters(A, recuperados).slice(0, 5).map((c) => ({ nodos: c.nodes, km: +kmOf(A, new Set(c.members)).toFixed(2), centro: c.centro }));
    report.impactoReglas[rule] = {
      kmExcluidos: +(full.stats.excluded[rule]?.km ?? 0).toFixed(1),
      nodosQueQuedanAisladosPorLaRegla: recuperados.size,
      pctDeLaRed: +(100 * recuperados.size / A.N).toFixed(3),
      kmAislados: +kmOf(A, recuperados).toFixed(2),
      gruposMayores: grupos,
    };
  }

  // Clasificación de las islas.
  const causa = (c) => {
    for (const [rule, set] of recuperablesPorRegla) if (c.members.some((m) => set.has(m))) return `regla:${rule}`;
    if (c.tocaBorde) return 'borde-de-importacion';
    if (c.nodos <= 3) return 'fragmento-de-sentido-unico';
    return 'desconexion-en-osm';
  };
  const resumen = {};
  for (const c of isl) { const k = causa(c); resumen[k] = resumen[k] || { islas: 0, nodos: 0, km: 0 }; resumen[k].islas++; resumen[k].nodos += c.nodos; resumen[k].km += c.km; }
  for (const v of Object.values(resumen)) v.km = +v.km.toFixed(1);
  report.islas = {
    total: isl.length, nodosFuera: fuera.size, porCausa: resumen,
    mayores: isl.slice(0, 10).map((c) => ({ nodos: c.nodos, km: c.km, centro: c.centro, causa: causa(c) })),
  };
  report.duracionSeg = Math.round((Date.now() - t0) / 1000);

  const txt = JSON.stringify(report, null, 2);
  console.log(txt);
  if (OUT) fs.writeFileSync(OUT, txt);
})().catch((e) => { console.error(e); process.exit(1); });
