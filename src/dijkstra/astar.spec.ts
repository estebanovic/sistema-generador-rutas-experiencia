import { astarMultiSource, chordHeuristic } from './astar';
import { RouteWeights, costFromSums } from './cost';
import { CompiledGraph } from './compiled-graph';
import { Endpoint, Position, SearchStats, dijkstraMultiSource, endpointOfRawNode } from './dijkstra';
import { assertSinRepeticion } from './no-repeat';
import { routeVia } from './via';
import { PROFILES } from '../routes/profiles';
import { diamante, loadFixture, randomPairs, toGraph } from '../../test/fixtures/graph-fixtures';

const PESOS: [string, RouteWeights][] = [
  ['pesos en 0', { curvinessWeight: 0, surfaceWeight: 0 }],
  ...Object.entries(PROFILES),
];

const plain = loadFixture('farellones');
const g = toGraph(plain);
const ep = (gr: CompiledGraph, id: string): Endpoint => endpointOfRawNode(gr, id)!;

/** Generador determinista (LCG). */
function azar(seed: number) {
  return () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
}

/** Posición al azar sobre un segmento cualquiera (nodo fantasma). */
function posicionAzar(gr: CompiledGraph, rnd: () => number): Position {
  const c = Math.floor(rnd() * gr.meta.chainCount);
  const a = gr.chainStart[c];
  const n = gr.chainStart[c + 1] - 1 - a; // segmentos del tramo
  return { chain: c, point: a + Math.floor(rnd() * n), t: 0.05 + 0.9 * rnd() };
}

describe('A* (F3): mismo costo que Dijkstra (oráculo)', () => {
  it('el subgrafo real cumple L ≥ cuerda (sin escalar la heurística)', () => {
    expect(g.meta.segmentsShorterThanChord).toBe(0);
    expect(g.meta.minLenOverChord).toBeGreaterThanOrEqual(1 - 1e-9);
  });

  it.each(PESOS)('1.000 pares al azar sobre Farellones (%s), con menos nodos asentados', (_n, w) => {
    const sa: SearchStats = { settled: 0 };
    const sd: SearchStats = { settled: 0 };
    for (const [a, b] of randomPairs(plain, 1000, 31)) {
      const ra = astarMultiSource(g, [ep(g, a)], [ep(g, b)], w, { stats: sa });
      const rd = dijkstraMultiSource(g, [ep(g, a)], [ep(g, b)], w, { stats: sd });
      expect(ra === null).toBe(rd === null);
      if (!ra || !rd) continue;
      expect(Math.abs(ra.totalCost - rd.totalCost)).toBeLessThanOrEqual(1e-9 * rd.totalCost);
      assertSinRepeticion(ra);
    }
    expect(sa.settled).toBeLessThan(sd.settled);
  });

  it('varios orígenes y destinos, incluidos nodos fantasma: elige la misma mejor combinación', () => {
    const rnd = azar(5);
    for (let i = 0; i < 200; i++) {
      const origins = [posicionAzar(g, rnd), posicionAzar(g, rnd), posicionAzar(g, rnd)];
      const dests = [posicionAzar(g, rnd), posicionAzar(g, rnd), posicionAzar(g, rnd)];
      for (const [, w] of PESOS) {
        const ra = astarMultiSource(g, origins, dests, w);
        const rd = dijkstraMultiSource(g, origins, dests, w);
        expect(ra === null).toBe(rd === null);
        if (ra && rd) expect(Math.abs(ra.totalCost - rd.totalCost)).toBeLessThanOrEqual(1e-9 * rd.totalCost);
      }
    }
  });

  it('fixture con largos menores que la cuerda: la heurística se escala y el costo sigue exacto', () => {
    const d = toGraph(diamante()); // largos explícitos, más cortos que la distancia entre coordenadas
    expect(d.meta.minLenOverChord).toBeLessThan(1);
    for (const [, w] of PESOS) {
      for (const [a, b] of [['S', 'T'], ['T', 'S'], ['A', 'B'], ['B', 'S']]) {
        const ra = astarMultiSource(d, [ep(d, a)], [ep(d, b)], w)!;
        const rd = dijkstraMultiSource(d, [ep(d, a)], [ep(d, b)], w)!;
        expect(ra.totalCost).toBeCloseTo(rd.totalCost, 9);
      }
    }
  });

  it('con tramos bloqueados y vías privadas (routeVia) da el mismo costo que Dijkstra', () => {
    const pares = randomPairs(plain, 40, 77);
    for (let i = 0; i + 1 < pares.length; i++) {
      const pts = [pares[i][0], pares[i][1], pares[i + 1][0]].map((id) => [ep(g, id)]);
      const ra = routeVia(g, pts, PROFILES['moto-curvas'], undefined, astarMultiSource);
      const rd = routeVia(g, pts, PROFILES['moto-curvas'], undefined, dijkstraMultiSource);
      expect(ra === null).toBe(rd === null);
      if (ra && rd) {
        expect(Math.abs(ra.totalCost - rd.totalCost)).toBeLessThanOrEqual(1e-9 * rd.totalCost);
        assertSinRepeticion(ra);
      }
    }
  });
});

describe('A* (F3): heurística', () => {
  it('admisible: nunca supera el costo real hasta el destino (muestra de 300 nodos)', () => {
    const rnd = azar(11);
    for (let i = 0; i < 300; i++) {
      const v = Math.floor(rnd() * g.meta.nodeCount);
      const dest = [posicionAzar(g, rnd)];
      const h = chordHeuristic(g, dest)(v);
      for (const [, w] of PESOS) {
        const r = dijkstraMultiSource(g, [{ node: v }], dest, w);
        if (r) expect(h).toBeLessThanOrEqual(r.totalCost + 1e-6);
      }
    }
  });

  it('consistente: h(u) ≤ costo(u→v) + h(v) en todas las aristas', () => {
    const rnd = azar(13);
    for (let k = 0; k < 5; k++) {
      const h = chordHeuristic(g, [posicionAzar(g, rnd), { node: Math.floor(rnd() * g.meta.nodeCount) }]);
      let violaciones = 0;
      for (const [, w] of PESOS) {
        for (let e = 0; e < g.meta.edgeCount; e++) {
          const c = costFromSums(g.edgeLen[e], g.edgeSumStraight[e], g.edgeSumUnpaved[e], g.edgeSumMinor[e], w);
          if (h(g.edgeFrom[e]) > c + h(g.edgeTo[e]) + 1e-6) violaciones++;
        }
      }
      expect(violaciones).toBe(0);
    }
  });

  it('es 0 en el destino y crece con la distancia', () => {
    const t = Math.floor(g.meta.nodeCount / 2);
    const h = chordHeuristic(g, [{ node: t }]);
    expect(h(t)).toBe(0);
    let lejos = 0;
    for (let v = 0; v < g.meta.nodeCount; v++) lejos = Math.max(lejos, h(v));
    expect(lejos).toBeGreaterThan(1000);
  });
});
