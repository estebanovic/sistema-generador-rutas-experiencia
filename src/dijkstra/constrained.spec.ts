import { astarMultiSource } from './astar';
import { constrainedRoute } from './constrained';
import { RouteWeights } from './cost';
import { CompiledGraph } from './compiled-graph';
import { Endpoint, SearchStats, endpointOfRawNode } from './dijkstra';
import { assertSinRepeticion } from './no-repeat';
import { PROFILES } from '../routes/profiles';
import { loadFixture, randomPairs, synthetic, toGraph } from '../../test/fixtures/graph-fixtures';

const plain = loadFixture('farellones');
const g = toGraph(plain);
const ep = (gr: CompiledGraph, id: string): Endpoint => endpointOfRawNode(gr, id)!;
const PRESUPUESTOS = [1.0, 1.1, 1.3, 1.5, 2.0];
const PESOS: [string, RouteWeights][] = Object.entries(PROFILES);
const pares = randomPairs(plain, 150, 404);

describe('LARAC (F4): presupuesto de desvío', () => {
  it('factibilidad: el largo nunca supera el presupuesto y no se repiten tramos', () => {
    for (const [, w] of PESOS) {
      for (const B of PRESUPUESTOS) {
        for (const [a, b] of pares) {
          const res = constrainedRoute(g, [ep(g, a)], [ep(g, b)], w, B);
          if (!res) continue;
          const { route, detour } = res;
          expect(route.sums.len).toBeLessThanOrEqual(B * detour.shortestMeters * (1 + 1e-9) + 1e-9);
          expect(detour.detourRatio).toBeLessThanOrEqual(B + 1e-9);
          expect(detour.lowerBound).toBeLessThanOrEqual(route.totalCost * (1 + 1e-9));
          assertSinRepeticion(route);
        }
      }
    }
  });

  it('presupuesto que no ata: devuelve la ruta óptima sin restricción (λ = 0, sin brecha)', () => {
    let noAta = 0;
    for (const [, w] of PESOS) {
      for (const [a, b] of pares) {
        const libre = astarMultiSource(g, [ep(g, a)], [ep(g, b)], w);
        const res = constrainedRoute(g, [ep(g, a)], [ep(g, b)], w, 2.0);
        if (!libre || !res) continue;
        if (libre.sums.len > 2.0 * res.detour.shortestMeters) continue;
        noAta++;
        expect(res.detour.binding).toBe(false);
        expect(res.detour.lambda).toBe(0);
        expect(res.detour.gap).toBe(0);
        expect(res.route.totalCost).toBeCloseTo(libre.totalCost, 6);
        expect(res.route.path).toEqual(libre.path);
      }
    }
    expect(noAta).toBeGreaterThan(100);
  });

  it('presupuesto 1,0: devuelve una ruta de largo mínimo', () => {
    for (const [, w] of PESOS) {
      for (const [a, b] of pares) {
        const res = constrainedRoute(g, [ep(g, a)], [ep(g, b)], w, 1.0);
        if (res) expect(res.route.sums.len).toBeLessThanOrEqual(res.detour.shortestMeters * (1 + 1e-9) + 1e-9);
      }
    }
  });

  describe('grafo sintético con brecha de dualidad conocida', () => {
    // Tres caminos S→T, con w_c = 4 (costo = L·(1 + 4·rectitud)):
    //   A: 3000 m curvos           → costo 3000 (barato y largo)
    //   B: 1000 m rectos           → costo 5000 (el más corto)
    //   C: 600 m rectos + 1800 curvos → largo 2400, costo 4800
    // Con presupuesto ×2,5 (2500 m), el óptimo es C, pero C queda sobre la
    // envolvente A–B: LARAC encuentra λ = 1, donde A y B empatan en 6000 (C da
    // 7200), y devuelve B con cota 3000 + 1·(3000 − 2500) = 3500.
    const sint = toGraph(
      synthetic({ S: [0, 0], T: [0, 0.005], Ax: [0.005, 0.0025], Bx: [-0.001, 0.0025], Cx: [0.001, 0.001] }, [
        { from: 'S', to: 'Ax', length: 1500, curviness: 1, way: 'a' },
        { from: 'Ax', to: 'T', length: 1500, curviness: 1, way: 'a' },
        { from: 'S', to: 'Bx', length: 500, curviness: 0, way: 'b' },
        { from: 'Bx', to: 'T', length: 500, curviness: 0, way: 'b' },
        { from: 'S', to: 'Cx', length: 600, curviness: 0, way: 'c' },
        { from: 'Cx', to: 'T', length: 1800, curviness: 1, way: 'c' },
      ]),
    );
    const w: RouteWeights = { curvinessWeight: 4, surfaceWeight: 0 };

    it.each(['astar', 'dijkstra'] as const)('devuelve B con λ = 1 y brecha 30%, y lo informa (%s)', (engine) => {
      const res = constrainedRoute(sint, [ep(sint, 'S')], [ep(sint, 'T')], w, 2.5, { engine })!;
      expect(res.route.path).toEqual(['S', 'Bx', 'T']);
      expect(res.route.totalCost).toBeCloseTo(5000, 6);
      expect(res.detour.lambda).toBeCloseTo(1, 9);
      expect(res.detour.lowerBound).toBeCloseTo(3500, 6);
      expect(res.detour.gap).toBeCloseTo(0.3, 9);
      expect(res.detour.binding).toBe(true);
    });

    it('si el presupuesto alcanza para A, devuelve A sin brecha', () => {
      const res = constrainedRoute(sint, [ep(sint, 'S')], [ep(sint, 'T')], w, 3.0)!;
      expect(res.route.path).toEqual(['S', 'Ax', 'T']);
      expect(res.detour.gap).toBe(0);
      expect(res.detour.binding).toBe(false);
    });
  });

  // En Farellones (red de montaña con pocas alternativas) el desvío sin
  // restricción no pasa de ×1,05: el presupuesto solo ata por debajo de eso.
  it('la poda elíptica no cambia el resultado y asienta menos nodos', () => {
    const conPoda: SearchStats = { settled: 0 };
    const sinPoda: SearchStats = { settled: 0 };
    let atan = 0;
    for (const [, w] of PESOS) {
      for (const B of [1.0, 1.005, 1.02]) {
        for (const [a, b] of pares) {
          const r1 = constrainedRoute(g, [ep(g, a)], [ep(g, b)], w, B, { stats: conPoda });
          const r2 = constrainedRoute(g, [ep(g, a)], [ep(g, b)], w, B, { prune: false, stats: sinPoda });
          expect(r1 === null).toBe(r2 === null);
          if (!r1 || !r2) continue;
          if (r1.detour.binding) atan++;
          expect(r1.route.totalCost).toBeCloseTo(r2.route.totalCost, 6);
          expect(r1.route.sums.len).toBeCloseTo(r2.route.sums.len, 6);
        }
      }
    }
    expect(atan).toBeGreaterThan(20);
    expect(conPoda.settled).toBeLessThan(sinPoda.settled);
  });

  it('A* y Dijkstra dan el mismo resultado con presupuesto', () => {
    for (const [, w] of PESOS) {
      for (const [a, b] of pares.slice(0, 60)) {
        const ra = constrainedRoute(g, [ep(g, a)], [ep(g, b)], w, 1.005);
        const rd = constrainedRoute(g, [ep(g, a)], [ep(g, b)], w, 1.005, { engine: 'dijkstra' });
        expect(ra === null).toBe(rd === null);
        if (ra && rd) {
          expect(ra.route.totalCost).toBeCloseTo(rd.route.totalCost, 6);
          expect(ra.detour.lambda).toBeCloseTo(rd.detour.lambda, 9);
        }
      }
    }
  });
});
