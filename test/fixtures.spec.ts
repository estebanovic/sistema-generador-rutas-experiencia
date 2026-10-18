import {
  CAMINO_A_FARELLONES_WAY_IDS,
  diamante,
  grilla,
  loadFixture,
  randomPairs,
  synthetic,
  toGraph,
} from './fixtures/graph-fixtures';

describe('fixtures', () => {
  describe('farellones (subgrafo real)', () => {
    const f = loadFixture('farellones');

    it('tiene nodos y aristas', () => {
      expect(f.nodes.length).toBeGreaterThan(5000);
      expect(f.edges.length).toBeGreaterThan(10000);
    });

    it('toda arista apunta a nodos presentes y tiene largo positivo', () => {
      const ids = new Set(f.nodes.map((n) => n.osmId));
      for (const e of f.edges) {
        expect(ids.has(e.fromOsmId)).toBe(true);
        expect(ids.has(e.toOsmId)).toBe(true);
        expect(e.distanceMeters).toBeGreaterThan(0);
      }
    });

    it('incluye al menos 20 km del Camino a Farellones (G-21)', () => {
      const ways = new Set(CAMINO_A_FARELLONES_WAY_IDS);
      // Cada tramo de doble sentido aparece dos veces (ida y vuelta).
      const km = f.edges.filter((e) => ways.has(e.osmWayId ?? '')).reduce((s, e) => s + e.distanceMeters, 0) / 2000;
      expect(km).toBeGreaterThan(20);
    });
  });

  describe('sintéticos', () => {
    it('doble sentido genera ida y vuelta; oneway solo ida', () => {
      const g = synthetic({ A: [0, 0], B: [0, 0.001] }, [
        { from: 'A', to: 'B', length: 100 },
        { from: 'B', to: 'A', length: 80, oneway: true },
      ]);
      expect(g.edges.filter((e) => e.fromOsmId === 'A' && e.toOsmId === 'B')).toHaveLength(1);
      expect(g.edges.filter((e) => e.fromOsmId === 'B' && e.toOsmId === 'A')).toHaveLength(2);
    });

    it('diamante y grilla tienen la forma esperada', () => {
      expect(toGraph(diamante()).meta.rawNodeCount).toBe(4);
      const gr = grilla(3);
      expect(gr.nodes).toHaveLength(9);
      expect(gr.edges).toHaveLength(2 * 12);
    });

    it('randomPairs es determinista', () => {
      const g = grilla(4);
      expect(randomPairs(g, 10, 7)).toEqual(randomPairs(g, 10, 7));
    });
  });
});
