// Fase B de la línea base: métricas sobre las rutas crudas, independientes del motor.
// Uso: node --max-old-space-size=8192 scripts/baseline/metrics.js <carpeta-resultados>
// Lee raw.json y deja summary.json, metrics.json (por par) y report.txt.
const fs = require('fs');
const path = require('path');
const L = require('./lib');
const { PROFILES } = require('./pairs');

const DIR = process.argv[2];
if (!DIR) {
  console.error('Uso: node scripts/baseline/metrics.js <carpeta-resultados>');
  process.exit(1);
}
const raw = JSON.parse(fs.readFileSync(path.join(DIR, 'raw.json'), 'utf8'));

// Parámetros de las métricas (ver el plan de desarrollo, §1.1, §1.3 y decisión D1).
const CURVY = 100; // °/km — umbral de "tramo curvo"
const CURV_PARAMS = { W: 100, theta: 5, step: 10, R: 150 };
const TYPE_RULE = { motorway: 'paved', trunk: 'paved', primary: 'paved', secondary: 'paved', tertiary: 'paved', residential: 'paved', service: 'paved', unclassified: 'unpaved', track: 'unpaved', path: 'unpaved' };

const lines = [];
const log = (s) => { lines.push(s); console.log(s); };

(async () => {
  const g = await L.loadRaw();
  const { polys } = L.wayPolylines(g);
  const dens = L.edgeDensity(g, polys, CURV_PARAMS);

  // Superficie inferida: vecindad del mismo tipo → cualquier tipo → regla por tipo.
  const wayInfo = new Map();
  for (let k = 0; k < g.M; k++) {
    const w = g.eWay[k]; let o = wayInfo.get(w);
    if (!o) { o = { hw: g.eHw[k], cat: L.SURF_CAT[L.SURF[g.eSurf[k]]], nodes: new Set(), len: 0 }; wayInfo.set(w, o); }
    o.len += g.eLen[k] / 2; o.nodes.add(g.eFrom[k]); o.nodes.add(g.eTo[k]);
  }
  const nodeWays = new Map();
  for (const [w, o] of wayInfo) for (const n of o.nodes) (nodeWays.get(n) || nodeWays.set(n, []).get(n)).push(w);
  const inferred = new Map();
  for (const [w, o] of wayInfo) {
    if (o.cat !== 'unknown') continue;
    const v = { paved: 0, unpaved: 0 }, vs = { paved: 0, unpaved: 0 };
    for (const n of o.nodes) for (const w2 of nodeWays.get(n)) {
      if (w2 === w) continue; const o2 = wayInfo.get(w2); if (o2.cat === 'unknown') continue;
      v[o2.cat] += o2.len; if (o2.hw === o.hw) vs[o2.cat] += o2.len;
    }
    const use = vs.paved + vs.unpaved > 0 ? vs : v;
    inferred.set(w, use.paved + use.unpaved > 0 ? (use.paved >= use.unpaved ? 'paved' : 'unpaved') : TYPE_RULE[L.HW[o.hw]]);
  }
  const catOf = (k) => {
    const c = L.SURF_CAT[L.SURF[g.eSurf[k]]];
    return c !== 'unknown' ? { cat: c, declared: true } : { cat: inferred.get(g.eWay[k]) ?? 'unknown', declared: false };
  };

  // Arista usada entre dos nodos consecutivos: la más corta (como buildRouteResult).
  const edgeOf = (u, v) => { let best = -1; for (let p = g.off[u]; p < g.off[u + 1]; p++) { const k = g.outE[p]; if (g.eTo[k] === v && (best < 0 || g.eLen[k] < g.eLen[best])) best = k; } return best; };

  const routes = {};
  for (const r of raw.runs) {
    if (!r.ok) continue;
    const ids = r.path.map((id) => g.idx.get(id));
    if (ids.some((i) => i === undefined)) { log(`  aviso: ${r.pair} ${r.profile} tiene nodos ausentes en la BD; se omite`); continue; }
    let len = 0, curvyNew = 0, curvyOld = 0, unpavedAll = 0, curvyPaved = 0, surfDecl = 0, repeatedM = 0;
    const segs = new Map();
    for (let i = 0; i < ids.length - 1; i++) {
      const k = edgeOf(ids[i], ids[i + 1]); if (k < 0) continue;
      const l = g.eLen[k]; len += l;
      const isCurvy = dens[k] >= CURVY; if (isCurvy) curvyNew += l; if (g.eCurv[k] >= 0.5) curvyOld += l;
      const s = catOf(k); if (s.declared) surfDecl += l; if (s.cat === 'unpaved') unpavedAll += l; if (s.cat === 'paved' && isCurvy) curvyPaved += l;
      // RNF-SinRepetición: un segmento físico (sin importar el sentido) no se repite.
      const a = ids[i], b = ids[i + 1]; const key = a < b ? a * g.N + b : b * g.N + a;
      if (segs.has(key)) repeatedM += l; else segs.set(key, l);
    }
    const shortest = L.shortestLen(g, ids[0], ids[ids.length - 1]);
    const m = {
      pair: r.pair, profile: r.profile, ms: r.ms, km: len / 1000, detour: len / shortest,
      pctCurvyNew: curvyNew / len, pctCurvyOld: curvyOld / len, pctUnpaved: unpavedAll / len, pctCurvyPaved: curvyPaved / len,
      pctSurfDeclared: surfDecl / len, repeatedMeters: repeatedM, segs,
    };
    m.criterion = r.profile === 'moto-curvas' ? m.pctCurvyNew : r.profile === '4x4' ? m.pctUnpaved : m.pctCurvyPaved;
    (routes[r.pair] = routes[r.pair] || {})[r.profile] = m;
  }

  // Solapamiento: metros compartidos / largo de la ruta más corta del par.
  const overlap = (A, B) => { let sh = 0; for (const [key, l] of A.segs) if (B.segs.has(key)) sh += l; return sh / (Math.min(A.km, B.km) * 1000); };
  const med = (a) => { const s = [...a].sort((x, y) => x - y); return s.length ? s[Math.floor((s.length - 1) / 2)] : NaN; };
  const mean = (a) => a.reduce((x, y) => x + y, 0) / a.length;
  const p95 = (a) => { const s = [...a].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.ceil(0.95 * s.length) - 1)]; };

  const agg = Object.fromEntries(PROFILES.map((p) => [p, { ms: [], crit: [], detour: [], old: [], n70: 0, n: 0, repeated: 0 }]));
  const ovl = { 'moto-curvas/4x4': [], 'moto-curvas/scenic': [], '4x4/scenic': [] };
  const rows = []; let identical = 0, pairsAll = 0, surfW = 0, surfD = 0;
  for (const [pair, byP] of Object.entries(routes)) {
    for (const p of PROFILES) {
      const m = byP[p]; if (!m) continue; const a = agg[p];
      a.ms.push(m.ms); a.crit.push(m.criterion); a.detour.push(m.detour); a.old.push(m.pctCurvyOld); a.n++;
      if (m.criterion >= 0.7) a.n70++; if (m.repeatedMeters > 0) a.repeated++;
      surfW += m.km; surfD += m.pctSurfDeclared * m.km;
    }
    const o = {};
    for (const k of Object.keys(ovl)) { const [x, y] = k.split('/'); if (byP[x] && byP[y]) { const v = overlap(byP[x], byP[y]); ovl[k].push(v); o[k] = v; } }
    if (Object.keys(o).length === 3) { pairsAll++; if (Object.values(o).every((v) => v > 0.999)) identical++; }
    rows.push({
      pair,
      ...Object.fromEntries(PROFILES.map((p) => [p, byP[p] ? {
        km: +byP[p].km.toFixed(2), ms: Math.round(byP[p].ms), criterion: +byP[p].criterion.toFixed(3), detour: +byP[p].detour.toFixed(3),
        pctCurvyNew: +byP[p].pctCurvyNew.toFixed(3), pctUnpaved: +byP[p].pctUnpaved.toFixed(3), pctCurvyPaved: +byP[p].pctCurvyPaved.toFixed(3),
        repeatedMeters: +byP[p].repeatedMeters.toFixed(1),
      } : null])),
      overlap: Object.fromEntries(Object.entries(o).map(([k, v]) => [k, +v.toFixed(3)])),
    });
  }

  const okRuns = raw.runs.filter((r) => r.ok).length;
  const summary = {
    date: raw.date, api: raw.api, coldMs: Math.round(raw.coldMs), routesOk: okRuns, routesTotal: raw.runs.length,
    params: { curvyThresholdDegPerKm: CURVY, curvature: CURV_PARAMS },
    profiles: Object.fromEntries(PROFILES.map((p) => { const a = agg[p]; return [p, {
      n: a.n, msP50: Math.round(med(a.ms)), msP95: Math.round(p95(a.ms)),
      criterionMean: +mean(a.crit).toFixed(3), criterionMedian: +med(a.crit).toFixed(3), routesAtLeast70: a.n70,
      detourMean: +mean(a.detour).toFixed(3), detourMax: +Math.max(...a.detour).toFixed(3),
      curvyOldMetricMean: +mean(a.old).toFixed(3), routesWithRepeatedSegments: a.repeated,
    }]; })),
    overlap: Object.fromEntries(Object.entries(ovl).map(([k, v]) => [k, { mean: +mean(v).toFixed(3), median: +med(v).toFixed(3) }])),
    pairsAllIdentical: `${identical}/${pairsAll}`,
    surfaceDeclaredOnRouteMeters: +(surfD / surfW).toFixed(3),
    errors: [...new Set(raw.runs.filter((r) => !r.ok).map((e) => `${e.pair}: ${e.error}`))],
  };

  log(`## línea base — ${raw.date} — API ${raw.api}`);
  log(`primera llamada ${(raw.coldMs / 1000).toFixed(1)} s | rutas OK ${okRuns}/${raw.runs.length}`);
  for (const p of PROFILES) {
    const s = summary.profiles[p];
    log(`${p}: n=${s.n} tiempo p50=${s.msP50} ms p95=${s.msP95} ms | criterio media=${(100 * s.criterionMean).toFixed(0)}% mediana=${(100 * s.criterionMedian).toFixed(0)}% rutas≥70%=${s.routesAtLeast70}/${s.n} | desvío media=${s.detourMean.toFixed(2)} máx=${s.detourMax.toFixed(2)} | rutas con tramos repetidos=${s.routesWithRepeatedSegments} | (curvas métrica vieja=${(100 * s.curvyOldMetricMean).toFixed(0)}%)`);
  }
  for (const [k, v] of Object.entries(summary.overlap)) log(`solapamiento ${k}: media=${(100 * v.mean).toFixed(0)}% mediana=${(100 * v.median).toFixed(0)}%`);
  log(`pares con las 3 rutas idénticas: ${summary.pairsAllIdentical}`);
  log(`superficie declarada en metros recorridos: ${(100 * summary.surfaceDeclaredOnRouteMeters).toFixed(1)}%`);
  if (summary.errors.length) log('errores:\n  ' + summary.errors.join('\n  '));
  log('\n## por par (km | ms | criterio | desvío)');
  for (const r of rows) {
    log(`${r.pair}: ` + PROFILES.map((p) => (r[p] ? `${p} ${r[p].km}km ${r[p].ms}ms ${(100 * r[p].criterion).toFixed(0)}% ×${r[p].detour.toFixed(2)}` : `${p} —`)).join(' | ') + ' | solap ' + JSON.stringify(r.overlap));
  }

  fs.writeFileSync(path.join(DIR, 'summary.json'), JSON.stringify(summary, null, 2));
  fs.writeFileSync(path.join(DIR, 'metrics.json'), JSON.stringify(rows, null, 1));
  fs.writeFileSync(path.join(DIR, 'report.txt'), lines.join('\n') + '\n');
  console.log(`→ ${DIR}/{summary.json, metrics.json, report.txt}`);
})().catch((e) => { console.error(e.stack); process.exit(1); });
