// Bench del motor (F1): tiempo de cálculo en proceso, sin HTTP ni Mongo.
// Uso: npm run build && npm run bench -- [--reps N] [--out archivo.json]
//
// Carga el snapshot del grafo para el COMPILER_VERSION actual (data/graph-cache
// o GRAPH_CACHE_DIR; lo escribe el servidor al arrancar) y corre las consultas
// de la línea base (los dos conjuntos de pares × 3 perfiles), como la API:
// snap multi-candidato + Dijkstra; también con los pesos en 0. Informa por perfil p50/p95/máx del tiempo
// y los nodos asentados (la medida que debe bajar con A*, F3).
const fs = require('fs');
const path = require('path');
const DIST = path.join(__dirname, '..', 'dist');
const { COMPILER_VERSION } = require(path.join(DIST, 'graph-compiler', 'compile'));
const { readSnapshot } = require(path.join(DIST, 'graph-compiler', 'snapshot'));
const { snapCandidates, spatialIndex } = require(path.join(DIST, 'dijkstra', 'snap'));
const { dijkstraMultiSource } = require(path.join(DIST, 'dijkstra', 'dijkstra'));
// Los tres perfiles más los pesos en 0 (ruta más corta), que F3 usa como referencia para A*.
const PROFILES = { 'pesos-en-0': { curvinessWeight: 0, surfaceWeight: 0 }, ...require(path.join(DIST, 'routes', 'profiles')).PROFILES };
const { SETS } = require('./baseline/pairs');

const args = process.argv.slice(2);
const opt = (name, def) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : def; };
const REPS = Number(opt('--reps', 5));
const OUT = opt('--out', null);

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

const t0 = performance.now();
const g = readSnapshot(path.join(dir, file.f));
const tLoad = performance.now() - t0;
const t1 = performance.now();
spatialIndex(g);
const tIndex = performance.now() - t1;

const queries = [];
for (const [set, { P, PAIRS }] of Object.entries(SETS)) {
  for (const [a, b] of PAIRS) for (const profile of Object.keys(PROFILES)) queries.push({ set, name: `${a}→${b}`, profile, o: P[a], d: P[b] });
}

const run = (q) => {
  const stats = { settled: 0 };
  const s = performance.now();
  const sc = snapCandidates(g, q.o[0], q.o[1]);
  const ec = snapCandidates(g, q.d[0], q.d[1]);
  const r = sc.length && ec.length ? dijkstraMultiSource(g, sc, ec, PROFILES[q.profile], { stats }) : null;
  return { ms: performance.now() - s, settled: stats.settled, ok: !!r };
};

for (const q of queries) run(q); // calentamiento (JIT)
const samples = Object.fromEntries(Object.keys(PROFILES).map((p) => [p, { ms: [], settled: [], fail: 0 }]));
for (let rep = 0; rep < REPS; rep++) {
  for (const q of queries) {
    const m = run(q);
    const s = samples[q.profile];
    s.ms.push(m.ms);
    if (rep === 0) { s.settled.push(m.settled); if (!m.ok) s.fail++; }
  }
}

const q = (a, f) => { const s = [...a].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.ceil(f * s.length) - 1)]; };
const mean = (a) => a.reduce((x, y) => x + y, 0) / a.length;
const out = {
  date: new Date().toISOString(), snapshot: file.f, node: process.version, reps: REPS, queries: queries.length,
  loadMs: Math.round(tLoad), spatialIndexMs: Math.round(tIndex), profiles: {},
};
console.log(`snapshot ${file.f}: carga ${out.loadMs} ms, índice espacial ${out.spatialIndexMs} ms; ${queries.length} consultas × ${REPS} repeticiones`);
console.log('perfil        p50 ms   p95 ms   máx ms   asentados (media / p95)   sin ruta');
const all = [];
for (const [p, s] of Object.entries(samples)) {
  all.push(...s.ms);
  out.profiles[p] = { p50: +q(s.ms, 0.5).toFixed(2), p95: +q(s.ms, 0.95).toFixed(2), max: +Math.max(...s.ms).toFixed(2), settledMean: Math.round(mean(s.settled)), settledP95: q(s.settled, 0.95), fail: s.fail };
  const o = out.profiles[p];
  console.log(`${p.padEnd(12)} ${String(o.p50).padStart(7)} ${String(o.p95).padStart(8)} ${String(o.max).padStart(8)}   ${String(o.settledMean).padStart(9)} / ${String(o.settledP95).padEnd(12)} ${o.fail}`);
}
out.all = { p50: +q(all, 0.5).toFixed(2), p95: +q(all, 0.95).toFixed(2), max: +Math.max(...all).toFixed(2) };
console.log(`todas        ${String(out.all.p50).padStart(7)} ${String(out.all.p95).padStart(8)} ${String(out.all.max).padStart(8)}`);
if (OUT) { fs.writeFileSync(OUT, JSON.stringify(out, null, 2)); console.log(`→ ${OUT}`); }
