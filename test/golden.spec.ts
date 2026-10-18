/**
 * Rutas doradas (F1): las rutas de la línea base (33 pares de referencia + 15
 * de oferta, × 3 perfiles) sobre el grafo real compilado, congeladas como
 * snapshot de Jest. Cualquier cambio que altere una ruta hace fallar el test;
 * si el cambio es intencional, el snapshot se actualiza de forma explícita:
 *
 *   npx jest test/golden -u
 *
 * La consulta es la misma que hace la API (snap multi-candidato + A* con el
 * perfil, desde F3). Cada ruta se compara además con Dijkstra (oráculo): el
 * costo tiene que ser el mismo. Necesita el snapshot del grafo para el COMPILER_VERSION actual en
 * data/graph-cache (o GRAPH_CACHE_DIR), que escribe el servidor al arrancar; si
 * no está, el test se salta con un aviso. La versión de datos (dataVersion)
 * queda en el snapshot de Jest: otra importación cambia las rutas.
 */
import { createHash } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { astarMultiSource } from '../src/dijkstra/astar';
import { CompiledGraph } from '../src/dijkstra/compiled-graph';
import { dijkstraMultiSource } from '../src/dijkstra/dijkstra';
import { assertSinRepeticion } from '../src/dijkstra/no-repeat';
import { snapCandidates } from '../src/dijkstra/snap';
import { COMPILER_VERSION } from '../src/graph-compiler/compile';
import { readSnapshot } from '../src/graph-compiler/snapshot';
import { PROFILES } from '../src/routes/profiles';

// Mismos pares que la línea base (scripts/baseline/pairs.js, fijos entre fases).
// eslint-disable-next-line @typescript-eslint/no-require-imports
const pairs = require('../scripts/baseline/pairs') as {
  SETS: Record<string, { P: Record<string, [number, number]>; PAIRS: [string, string][] }>;
  PROFILES: (keyof typeof PROFILES)[];
};

function snapshotFile(): string | null {
  const dir = process.env.GRAPH_CACHE_DIR ?? path.join(__dirname, '..', 'data', 'graph-cache');
  if (!fs.existsSync(dir)) return null;
  const re = new RegExp(`^graph-osm-v(\\d+)-${COMPILER_VERSION.replace(/\./g, '\\.')}\\.bin$`);
  const found = fs
    .readdirSync(dir)
    .map((f) => ({ f, m: re.exec(f) }))
    .filter((x) => x.m)
    .sort((a, b) => Number(b.m![1]) - Number(a.m![1]));
  return found.length ? path.join(dir, found[0].f) : null;
}

const file = snapshotFile();
if (!file) {
  console.warn(`Rutas doradas: no hay snapshot del grafo para el compilador ${COMPILER_VERSION}; se saltan (arrancá el servidor una vez para generarlo).`);
}

(file ? describe : describe.skip)('rutas doradas (grafo real, pares de la línea base)', () => {
  // En beforeAll: describe.skip igual ejecuta este cuerpo para registrar los tests.
  let g: CompiledGraph;
  beforeAll(() => {
    g = readSnapshot(file!);
  });

  it('el compilador verifica L ≥ cuerda en todos los segmentos (A* admisible sin escalar)', () => {
    expect(g.meta.segmentsShorterThanChord).toBe(0);
    expect(g.meta.minLenOverChord).toBeGreaterThanOrEqual(1 - 1e-9);
  });

  it.each(Object.keys(pairs.SETS))('conjunto %s', (set) => {
    const { P, PAIRS } = pairs.SETS[set];
    const rutas: Record<string, unknown> = {};
    for (const [a, b] of PAIRS) {
      const sc = snapCandidates(g, P[a][0], P[a][1]);
      const ec = snapCandidates(g, P[b][0], P[b][1]);
      for (const perfil of pairs.PROFILES) {
        const r = astarMultiSource(g, sc, ec, PROFILES[perfil]);
        const oraculo = dijkstraMultiSource(g, sc, ec, PROFILES[perfil]);
        const clave = `${a}→${b} ${perfil}`;
        expect(r === null).toBe(oraculo === null);
        if (!r) {
          rutas[clave] = null;
          continue;
        }
        expect(Math.abs(r.totalCost - oraculo!.totalCost) / oraculo!.totalCost).toBeLessThan(1e-9);
        assertSinRepeticion(r);
        rutas[clave] = {
          metros: Math.round(r.stats.distanceMeters * 10) / 10,
          costo: Math.round(r.totalCost * 10) / 10,
          nodos: r.path.length,
          camino: createHash('sha1').update(r.path.join(',')).digest('hex').slice(0, 12),
        };
      }
    }
    expect({ datos: g.meta.dataVersion, compilador: g.meta.compilerVersion, rutas }).toMatchSnapshot();
  });
});
