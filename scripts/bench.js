// Bench del motor: tiempo de cálculo en proceso, sin HTTP ni Mongo.
// Uso: npm run build && npm run bench -- [--reps N] [--random N] [--out archivo.json]
//
// Carga el snapshot del grafo para el COMPILER_VERSION actual (data/graph-cache
// o GRAPH_CACHE_DIR; lo escribe el servidor al arrancar) y corre:
// - las consultas de la línea base (los dos conjuntos de pares × 3 perfiles y
//   los pesos en 0), como la API: snap multi-candidato + búsqueda;
// - con --random N, además N pares al azar de nodos de la red conectada a
//   2–60 km (semilla fija), con los mismos pesos.
// Cada consulta corre con A* (el motor de la API desde F3) y con Dijkstra (el
// oráculo). Informa p50/p95/máx del tiempo, los nodos asentados, cuántas veces
// menos nodos asienta A* y la mayor diferencia de costo entre ambos (debe ser 0).
const fs = require('fs');
const path = require('path');
const DIST = path.join(__dirname, '..', 'dist');
const { COMPILER_VERSION } = require(path.join(DIST, 'graph-compiler', 'compile'));
const { readSnapshot } = require(path.join(DIST, 'graph-compiler', 'snapshot'));
const { haversine } = require(path.join(DIST, 'graph-compiler', 'geo'));
const { snapCandidates, spatialIndex } = require(path.join(DIST, 'dijkstra', 'snap'));
const { dijkstraMultiSource } = require(path.join(DIST, 'dijkstra', 'dijkstra'));
const { astarMultiSource } = require(path.join(DIST, 'dijkstra', 'astar'));
// Los tres perfiles más los pesos en 0 (ruta más corta), que F3 usa como referencia para A*.
const PROFILES = { 'pesos-en-0': { curvinessWeight: 0, surfaceWeight: 0 }, ...require(path.join(DIST, 'routes', 'profiles')).PROFILES };
const { SETS } = require('./baseline/pairs');
const ENGINES = { astar: astarMultiSource, dijkstra: dijkstraMultiSource };

const args = process.argv.slice(2);
const opt = (name, def) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : def; };
const REPS = Number(opt('--reps', 5));
const RANDOM = Number(opt('--random', 0));
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

// ── Consultas ──
const queries = [];
for (const [, { P, PAIRS }] of Object.entries(SETS)) {
  for (const [a, b] of PAIRS) {
    for (const profile of Object.keys(PROFILES)) queries.push({ group: 'línea base', name: `${a}→${b}`, profile, o: P[a], d: P[b] });
  }
}
if (RANDOM > 0) {
  let seed = 20261018;
  const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
  const main = [];
  for (let n = 0; n < g.meta.nodeCount; n++) if (g.nodeInMainScc[n]) main.push(n);
  let made = 0;
  while (made < RANDOM) {
    const a = main[Math.floor(rnd() * main.length)];
    const b = main[Math.floor(rnd() * main.length)];
    const d = haversine(g.nodeLat[a], g.nodeLon[a], g.nodeLat[b], g.nodeLon[b]);
    if (d < 2000 || d > 60000) continue;
    made++;
    for (const profile of Object.keys(PROFILES)) queries.push({ group: 'al azar', name: `${a}→${b}`, profile, sc: [{ node: a }], ec: [{ node: b }] });
  }
}

// Las consultas de la línea base incluyen el snap (como la API); las al azar parten de nodos.
const run = (engine, q) => {
  const stats = { settled: 0 };
  const s = performance.now();
  const sc = q.o ? snapCandidates(g, q.o[0], q.o[1]) : q.sc;
  const ec = q.d ? snapCandidates(g, q.d[0], q.d[1]) : q.ec;
  const r = sc.length && ec.length ? ENGINES[engine](g, sc, ec, PROFILES[q.profile], { stats }) : null;
  return { ms: performance.now() - s, settled: stats.settled, cost: r ? r.totalCost : null };
};

for (const q of queries) for (const e of Object.keys(ENGINES)) run(e, q); // calentamiento (JIT)
const res = queries.map(() => ({}));
for (const e of Object.keys(ENGINES)) {
  queries.forEach((q, i) => {
    const first = run(e, q);
    const ms = [first.ms];
    for (let rep = 1; rep < REPS; rep++) ms.push(run(e, q).ms);
    res[i][e] = { ms, settled: first.settled, cost: first.cost };
  });
}

// ── Informe ──
const quant = (a, f) => { const s = [...a].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.max(0, Math.ceil(f * s.length) - 1))]; };
const mean = (a) => a.reduce((x, y) => x + y, 0) / a.length;
const r2 = (x) => +x.toFixed(2);
const out = {
  date: new Date().toISOString(), snapshot: file.f, node: process.version, reps: REPS, random: RANDOM, queries: queries.length,
  loadMs: Math.round(tLoad), spatialIndexMs: Math.round(tIndex), groups: {},
};
console.log(`snapshot ${file.f}: carga ${out.loadMs} ms, índice espacial ${out.spatialIndexMs} ms; ${queries.length} consultas × ${REPS} repeticiones × 2 motores`);
for (const group of [...new Set(queries.map((q) => q.group))]) {
  out.groups[group] = {};
  console.log(`\n## ${group}`);
  console.log('perfil        motor     media ms   p50 ms   p95 ms   máx ms   asentados (media / p95)   asentados D/A (total; mediana)   Δcosto máx   sin ruta');
  for (const profile of Object.keys(PROFILES)) {
    const idx = queries.map((q, i) => (q.group === group && q.profile === profile ? i : -1)).filter((i) => i >= 0);
    const row = {};
    for (const e of Object.keys(ENGINES)) {
      const ms = idx.flatMap((i) => res[i][e].ms);
      const st = idx.map((i) => res[i][e].settled);
      row[e] = { mean: r2(mean(ms)), p50: r2(quant(ms, 0.5)), p95: r2(quant(ms, 0.95)), max: r2(Math.max(...ms)), settledMean: Math.round(mean(st)), settledP95: quant(st, 0.95), fail: idx.filter((i) => res[i][e].cost === null).length };
    }
    const sumD = idx.reduce((s, i) => s + res[i].dijkstra.settled, 0);
    const sumA = idx.reduce((s, i) => s + res[i].astar.settled, 0);
    const ratios = idx.map((i) => res[i].dijkstra.settled / Math.max(1, res[i].astar.settled));
    let dmax = 0;
    let mismatch = 0;
    for (const i of idx) {
      const a = res[i].astar.cost, d = res[i].dijkstra.cost;
      if ((a === null) !== (d === null)) { mismatch++; continue; }
      if (a === null) continue;
      const rel = Math.abs(a - d) / d;
      dmax = Math.max(dmax, rel);
      if (rel > 1e-9) mismatch++;
    }
    row.settledRatioTotal = r2(sumD / Math.max(1, sumA));
    row.settledRatioMedian = r2(quant(ratios, 0.5));
    row.maxRelCostDiff = dmax;
    row.costMismatches = mismatch;
    out.groups[group][profile] = row;
    for (const e of Object.keys(ENGINES)) {
      const o = row[e];
      const extra = e === 'astar' ? `   ${String(row.settledRatioTotal).padStart(6)} ; ${String(row.settledRatioMedian).padEnd(22)}   ${dmax.toExponential(1).padStart(9)}` : ''.padEnd(48);
      console.log(`${(e === 'astar' ? profile : '').padEnd(13)} ${e.padEnd(9)} ${String(o.mean).padStart(8)} ${String(o.p50).padStart(7)} ${String(o.p95).padStart(8)} ${String(o.max).padStart(8)}   ${String(o.settledMean).padStart(9)} / ${String(o.settledP95).padEnd(12)}${extra}   ${o.fail}`);
    }
  }
}
if (OUT) { fs.writeFileSync(OUT, JSON.stringify(out, null, 2)); console.log(`→ ${OUT}`); }
