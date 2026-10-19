// Evaluación de la ILS (F5) contra el techo estructural.
// Uso: npm run build && node --max-old-space-size=6144 scripts/ils-eval.js <techo.json> [carpeta-resultados] [--perfiles moto-curvas,4x4,scenic] [--neutro]
//
// Corre la consulta completa de la API en proceso (snap + ILS con la banda
// ±15%) para los casos del techo (circuitos: 25 orígenes × 30/60/100 km;
// destino fijo: 48 pares × 1,5/2,5 la distancia mínima) y mide:
// - éxito en los casos FACTIBLES del techo: circuito (o ruta) dentro de la banda;
// - comportamiento en los IMPOSIBLES: nunca un circuito (ida y vuelta declarada o mensaje);
// - lo que pasa en los INDETERMINADOS;
// - tiempo por consulta (p50, p95, máx), violaciones del verificador y calidad
//   (costo medio por metro y criterio del perfil: % curvo, % sin pavimentar).
// Con --neutro corre además la misma ILS con todos los pesos en 0 en cada caso
// y compara el criterio priorizado de cada perfil (D1) contra esa referencia,
// por variante y por zona (la del origen):
// - moto-curvas: % de metros curvos (≥ 100 °/km);
// - 4x4: % sin pavimentar (ripio, tierra, arena declarados; lo desconocido no cuenta);
// - scenic: % curvo y pavimentado (asfalto, hormigón, adoquín declarados).
const fs = require('fs');
const path = require('path');
const DIST = path.join(__dirname, '..', 'dist');
const { COMPILER_VERSION } = require(path.join(DIST, 'graph-compiler', 'compile'));
const { readSnapshot } = require(path.join(DIST, 'graph-compiler', 'snapshot'));
const { snapCandidates } = require(path.join(DIST, 'dijkstra', 'snap'));
const { targetLengthRoute } = require(path.join(DIST, 'dijkstra', 'ils'));
const { sinRepeticionViolations } = require(path.join(DIST, 'dijkstra', 'no-repeat'));
const { PROFILES } = require(path.join(DIST, 'routes', 'profiles'));
const { SETS } = require('./baseline/pairs');

const args = process.argv.slice(2);
const pIdx = args.indexOf('--perfiles');
const profiles = pIdx >= 0 ? args.splice(pIdx, 2)[1].split(',') : Object.keys(PROFILES);
const nIdx = args.indexOf('--neutro');
const NEUTRAL = nIdx >= 0;
if (NEUTRAL) args.splice(nIdx, 1);
const W0 = { curvinessWeight: 0, surfaceWeight: 0 };
const [TECHO, OUT_DIR] = args;
if (!TECHO) {
  console.error('Uso: node scripts/ils-eval.js <techo.json> [carpeta-resultados] [--perfiles a,b]');
  process.exit(1);
}
const techo = JSON.parse(fs.readFileSync(TECHO, 'utf8'));

const dir = process.env.GRAPH_CACHE_DIR || path.join(__dirname, '..', 'data', 'graph-cache');
const re = new RegExp(`^graph-osm-v(\\d+)-${COMPILER_VERSION.replace(/\./g, '\\.')}\\.bin$`);
const file = fs.readdirSync(dir).map((f) => ({ f, m: re.exec(f) })).filter((x) => x.m).sort((a, b) => Number(b.m[1]) - Number(a.m[1]))[0];
const g = readSnapshot(path.join(dir, file.f));
const P = { ...SETS.referencia.P, ...SETS.oferta.P };
const zoneOf = (name) => Object.keys(techo.zones).find((z) => techo.zones[z].includes(name)) || 'sin zona';

// Criterios por perfil (D1), desde los tramos usados y los segmentos del grafo compilado.
const CURVY_DEG_PER_KM = 100;
const SURF = ['asphalt', 'concrete', 'gravel', 'dirt', 'sand', 'cobblestone', 'unknown'];
const PAVED = new Set(['asphalt', 'concrete', 'cobblestone']);
const UNPAVED = new Set(['gravel', 'dirt', 'sand']);
function criteria(route) {
  let len = 0, curvy = 0, unpaved = 0, curvyPaved = 0;
  for (const u of route.tramos) {
    for (let j = g.chainStart[u.chain]; j < g.chainStart[u.chain + 1] - 1; j++) {
      const l = Math.min(u.s1, g.geoCumLen[j + 1]) - Math.max(u.s0, g.geoCumLen[j]);
      if (l <= 0) continue;
      const sf = SURF[g.segSurface[j]];
      const isCurvy = g.segCurvDeg[j] >= CURVY_DEG_PER_KM;
      len += l;
      if (isCurvy) curvy += l;
      if (UNPAVED.has(sf)) unpaved += l;
      if (isCurvy && PAVED.has(sf)) curvyPaved += l;
    }
  }
  return len > 0 ? { curvy: curvy / len, unpaved: unpaved / len, curvyPaved: curvyPaved / len } : { curvy: 0, unpaved: 0, curvyPaved: 0 };
}
const CRITERION = { 'moto-curvas': 'curvy', '4x4': 'unpaved', scenic: 'curvyPaved' };

const unpavedShare = (st) => {
  const b = st.surfaceBreakdown || {};
  const tot = Object.values(b).reduce((s, x) => s + x, 0);
  return tot > 0 ? ((b.gravel || 0) + (b.dirt || 0) + (b.sand || 0)) / tot : 0;
};

const runs = [];
function run(variant, c, profile, origins, dests, targetMeters) {
  const t = performance.now();
  const r = targetLengthRoute(g, { origins, dests, weights: profile === 'neutro' ? W0 : PROFILES[profile], targetMeters });
  const ms = performance.now() - t;
  const row = { variant, profile, ceiling: c.status, ms: Math.round(ms) };
  if ('error' in r) return { ...row, kind: 'error', error: r.error };
  return {
    ...row,
    kind: r.kind,
    withinBand: r.withinBand,
    achievedKm: +(r.achievedMeters / 1000).toFixed(1),
    targetKm: targetMeters / 1000,
    accessKm: +(r.accessRepeatedMeters / 1000).toFixed(2),
    certain: r.certain,
    violations: sinRepeticionViolations(r.route.tramos, r.exemptions).length,
    costPerM: +(r.route.totalCost / r.achievedMeters).toFixed(3),
    curvy: +r.route.stats.curvyShare.toFixed(3),
    unpaved: +unpavedShare(r.route.stats).toFixed(3),
    crit: Object.fromEntries(Object.entries(criteria(r.route)).map(([k, v]) => [k, +v.toFixed(4)])),
    waypoints: r.waypoints,
    iterations: r.iterations,
    reason: r.reason,
  };
}

const t0 = Date.now();
const runProfiles = NEUTRAL ? [...profiles, 'neutro'] : profiles;
for (const c of techo.circuits) {
  const [lat, lon] = P[c.origin];
  const origins = snapCandidates(g, lat, lon);
  for (const profile of runProfiles) {
    const r = { origin: c.origin, zone: c.zone, L: c.L, ...run('circuito', c, profile, origins, [], c.L * 1000) };
    runs.push(r);
    console.log(`circuito ${c.origin.padEnd(13)} ${String(c.L).padStart(3)} km ${profile.padEnd(11)} techo ${c.status.padEnd(13)} → ${r.kind.padEnd(12)} ${r.achievedKm ?? '—'} km ${r.withinBand ? '' : 'FUERA '}${r.ms} ms viol ${r.violations ?? '—'}`);
  }
}
for (const c of techo.paths) {
  const [a, b] = c.pair.split('→');
  const origins = snapCandidates(g, P[a][0], P[a][1]);
  const dests = snapCandidates(g, P[b][0], P[b][1]);
  if (!c.targetKm) continue;
  for (const profile of runProfiles) {
    const r = { pair: c.pair, set: c.set, zone: zoneOf(a), factor: c.factor, ...run('destino', c, profile, origins, dests, c.targetKm * 1000) };
    runs.push(r);
    console.log(`destino  ${c.pair.padEnd(28)} ×${c.factor} ${profile.padEnd(11)} techo ${c.status.padEnd(13)} → ${r.kind.padEnd(6)} ${r.achievedKm ?? '—'} km ${r.withinBand ? '' : 'FUERA '}${r.ms} ms viol ${r.violations ?? '—'}`);
  }
}

// ── Informe ──
const lines = [];
const log = (s) => { lines.push(s); console.log(s); };
const q = (a, f) => { const s = [...a].sort((x, y) => x - y); return s.length ? s[Math.min(s.length - 1, Math.ceil(f * s.length) - 1)] : NaN; };
const mean = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : NaN);
const pct = (a, b) => (b ? `${a}/${b} (${((100 * a) / b).toFixed(0)}%)` : '—');
const success = (r) => (r.variant === 'circuito' ? r.kind === 'circuito' && r.withinBand : r.kind === 'ruta' && r.withinBand);
log('');
log(`## Evaluación de la ILS — ${new Date().toISOString()} — snapshot ${file.f} — perfiles ${profiles.join(', ')} — ${((Date.now() - t0) / 1000).toFixed(0)} s`);
const summary = {};
for (const variant of ['circuito', 'destino']) {
  const rs = runs.filter((r) => r.variant === variant && r.profile !== 'neutro');
  const fact = rs.filter((r) => r.ceiling === 'factible');
  const imp = rs.filter((r) => r.ceiling === 'imposible');
  const ind = rs.filter((r) => r.ceiling === 'indeterminado');
  const ms = rs.map((r) => r.ms);
  const s = {
    runs: rs.length,
    factibleSuccess: fact.filter(success).length,
    factible: fact.length,
    imposibleCircuits: imp.filter((r) => r.kind === 'circuito').length,
    imposible: imp.length,
    imposibleOutAndBack: imp.filter((r) => r.kind === 'ida-y-vuelta').length,
    indeterminadoSuccess: ind.filter(success).length,
    indeterminado: ind.length,
    violations: rs.reduce((x, r) => x + (r.violations || 0), 0),
    errors: rs.filter((r) => r.kind === 'error').length,
    msP50: Math.round(q(ms, 0.5)),
    msP95: Math.round(q(ms, 0.95)),
    msMax: Math.round(Math.max(...ms)),
    byProfile: {},
  };
  for (const p of profiles) {
    const pr = rs.filter((r) => r.profile === p);
    const pf = pr.filter((r) => r.ceiling === 'factible');
    const ok = pf.filter(success);
    s.byProfile[p] = {
      factibleSuccess: ok.length,
      factible: pf.length,
      msP95: Math.round(q(pr.map((r) => r.ms), 0.95)),
      costPerM: +mean(ok.map((r) => r.costPerM)).toFixed(2),
      curvy: +mean(ok.map((r) => r.curvy)).toFixed(3),
      unpaved: +mean(ok.map((r) => r.unpaved)).toFixed(3),
      lengthErrPct: +mean(ok.map((r) => (100 * Math.abs(r.achievedKm - r.targetKm)) / r.targetKm)).toFixed(1),
    };
  }
  summary[variant] = s;
  log('');
  log(`### ${variant === 'circuito' ? 'Circuitos' : 'Destino fijo'} (${s.runs} consultas)`);
  log(`- éxito en los casos factibles del techo (dentro de ±15%): ${pct(s.factibleSuccess, s.factible)}`);
  log(`- casos imposibles: ${s.imposible} consultas; circuitos entregados: ${s.imposibleCircuits}${variant === 'circuito' ? `; ida y vuelta declarada: ${s.imposibleOutAndBack}` : ''}`);
  log(`- casos indeterminados: ${pct(s.indeterminadoSuccess, s.indeterminado)} con ${variant === 'circuito' ? 'circuito' : 'ruta'} en la banda`);
  log(`- violaciones del verificador: ${s.violations}; errores: ${s.errors}`);
  log(`- tiempo por consulta: p50 ${s.msP50} ms, p95 ${s.msP95} ms, máx ${s.msMax} ms`);
  for (const [p, b] of Object.entries(s.byProfile)) {
    log(`  ${p.padEnd(12)} éxito ${pct(b.factibleSuccess, b.factible)} | p95 ${b.msP95} ms | costo/m ${b.costPerM} | curvo ${(100 * b.curvy).toFixed(0)}% | sin pavimentar ${(100 * b.unpaved).toFixed(0)}% | error de largo medio ${b.lengthErrPct}%`);
  }
  const fails = fact.filter((r) => !success(r));
  if (fails.length) {
    log(`- factibles sin éxito:`);
    for (const r of fails) log(`  ${(r.origin || r.pair).padEnd(28)} ${r.L ? r.L + ' km' : '×' + r.factor} ${r.profile.padEnd(11)} → ${r.kind} ${r.achievedKm ?? '—'} km${r.reason ? ' | ' + r.reason : ''}${r.error ? ' | ' + r.error : ''}`);
  }
}
// ── Calidad de experiencia frente a la misma ILS con los pesos en 0 ──
const quality = {};
if (NEUTRAL) {
  const caseKey = (r) => `${r.variant}|${r.origin || r.pair}|${r.L || r.factor}`;
  const neutral = new Map(runs.filter((r) => r.profile === 'neutro').map((r) => [caseKey(r), r]));
  const pctOf = (x) => (Number.isNaN(x) ? '—' : `${(100 * x).toFixed(0)}%`);
  log('');
  log('### Calidad de experiencia: criterio priorizado, ILS del perfil frente a la misma ILS con los pesos en 0');
  log('Casos pareados: los dos dentro de la banda con circuito (o ruta). Criterio: moto = % curvo (≥ 100 °/km); 4x4 = % sin pavimentar declarado; scenic = % curvo y pavimentado. Zona = la del origen.');
  for (const variant of ['circuito', 'destino']) {
    const ns = runs.filter((r) => r.variant === variant && r.profile === 'neutro');
    const v = (quality[variant] = { neutralSuccess: ns.filter(success).length, neutralRuns: ns.length, neutralMsP50: Math.round(q(ns.map((r) => r.ms), 0.5)), byProfile: {} });
    log('');
    log(`#### ${variant === 'circuito' ? 'Circuitos' : 'Destino fijo'} (neutro: ${v.neutralSuccess}/${v.neutralRuns} en la banda, p50 ${v.neutralMsP50} ms)`);
    log(`${'perfil'.padEnd(12)} ${'zona'.padEnd(14)} ${'n'.padStart(3)}  ${'perfil media (mediana)'.padEnd(22)}  ${'neutro media (mediana)'.padEnd(22)}  ${'dif. media'.padEnd(10)}  mejora / empeora`);
    for (const p of profiles) {
      const key = CRITERION[p];
      v.byProfile[p] = {};
      for (const zone of ['valle', 'precordillera', 'rural', 'todas']) {
        const pairs = runs
          .filter((r) => r.variant === variant && r.profile === p && (zone === 'todas' || r.zone === zone) && success(r))
          .map((r) => [r, neutral.get(caseKey(r))])
          .filter(([, n]) => n && success(n));
        const a = pairs.map(([r]) => r.crit[key]);
        const b = pairs.map(([, n]) => n.crit[key]);
        const d = pairs.map(([r, n]) => r.crit[key] - n.crit[key]);
        const s = {
          n: pairs.length,
          profileMean: +mean(a).toFixed(3),
          profileMedian: +q(a, 0.5).toFixed(3),
          neutralMean: +mean(b).toFixed(3),
          neutralMedian: +q(b, 0.5).toFixed(3),
          diffMean: +mean(d).toFixed(3),
          improved: d.filter((x) => x > 0.005).length,
          worse: d.filter((x) => x < -0.005).length,
        };
        v.byProfile[p][zone] = s;
        const diff = Number.isNaN(s.diffMean) ? '—' : `${s.diffMean >= 0 ? '+' : ''}${(100 * s.diffMean).toFixed(0)} pts`;
        log(`${p.padEnd(12)} ${zone.padEnd(14)} ${String(s.n).padStart(3)}  ${`${pctOf(s.profileMean)} (${pctOf(s.profileMedian)})`.padEnd(22)}  ${`${pctOf(s.neutralMean)} (${pctOf(s.neutralMedian)})`.padEnd(22)}  ${diff.padEnd(10)}  ${s.n ? `${s.improved} / ${s.worse}` : '—'}`);
      }
    }
  }
}

if (OUT_DIR) {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.writeFileSync(path.join(OUT_DIR, 'ils.json'), JSON.stringify({ date: new Date().toISOString(), snapshot: file.f, profiles, summary, quality, runs }, null, 1));
  fs.writeFileSync(path.join(OUT_DIR, 'report.txt'), lines.join('\n') + '\n');
  console.log(`→ ${OUT_DIR}/{ils.json, report.txt}`);
}
