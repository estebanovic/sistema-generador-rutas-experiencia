// Fase A de la línea base: llama a la API real y guarda las rutas crudas.
// Uso: node scripts/baseline/run.js <carpeta-resultados> [url-api] [--set referencia|oferta]
// La carpeta se crea si no existe; deja raw.json.
const fs = require('fs');
const path = require('path');
const { SETS, PROFILES } = require('./pairs');

const args = process.argv.slice(2);
const setIdx = args.indexOf('--set');
const SET = setIdx >= 0 ? args.splice(setIdx, 2)[1] : 'referencia';
const OUT_DIR = args[0];
const API = args[1] || process.env.API_URL || 'http://localhost:3000';
if (!OUT_DIR || !SETS[SET]) {
  console.error('Uso: node scripts/baseline/run.js <carpeta-resultados> [url-api] [--set referencia|oferta]');
  process.exit(1);
}
const { P, PAIRS } = SETS[SET];

// Cuerpo de la petición. Si el contrato de la API cambia en una fase, adaptar
// SOLO esta función (y anotarlo en el README).
function requestBody(o, d, profile) {
  // Desde F0.6 la API no acepta tripLength (antes se enviaba 'direct').
  return { origin: { lat: o[0], lon: o[1] }, destination: { lat: d[0], lon: d[1] }, profile };
}

async function call(o, d, profile) {
  const t0 = performance.now();
  const res = await fetch(API + '/routes/calculate', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(requestBody(o, d, profile)),
  });
  const ms = performance.now() - t0;
  const json = await res.json();
  return { ok: res.ok, ms, json };
}

(async () => {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  // La primera llamada mide el arranque en frío (carga del grafo), si el
  // servidor recién arrancó.
  const [a0, b0] = PAIRS[0];
  const cold = await call(P[a0], P[b0], PROFILES[0]);
  console.log(`primera llamada (incluye carga del grafo si el servidor está frío): ${(cold.ms / 1000).toFixed(1)} s`);

  const out = { api: API, set: SET, date: new Date().toISOString(), coldMs: cold.ms, runs: [] };
  for (const [a, b] of PAIRS) {
    for (const profile of PROFILES) {
      const r = await call(P[a], P[b], profile);
      out.runs.push({
        pair: `${a}→${b}`, profile, ok: r.ok, ms: r.ms,
        error: r.ok ? undefined : r.json.message,
        path: r.ok ? r.json.path : undefined,
        distanceMeters: r.ok ? r.json.stats.distanceMeters : undefined,
      });
      console.log(`${a}→${b} ${profile}: ${r.ok ? (r.json.stats.distanceMeters / 1000).toFixed(1) + ' km' : 'ERROR ' + r.json.message} ${r.ms.toFixed(0)} ms`);
    }
  }
  fs.writeFileSync(path.join(OUT_DIR, 'raw.json'), JSON.stringify(out));
  console.log(`→ ${path.join(OUT_DIR, 'raw.json')}`);
})().catch((e) => { console.error(e); process.exit(1); });
