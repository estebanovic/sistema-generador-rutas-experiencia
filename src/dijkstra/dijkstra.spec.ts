import { dijkstra, dijkstraMultiSource } from './dijkstra';
import { RouteWeights, calculateEdgeCost } from './cost';
import { dijkstra as dijkstraLegacy } from './legacy/dijkstra.legacy';
import { PROFILES } from '../routes/profiles';
import {
  diamante,
  grilla,
  loadFixture,
  randomPairs,
  synthetic,
  toGraph,
  toLegacyGraph,
} from '../../test/fixtures/graph-fixtures';

const SOLO_DISTANCIA: RouteWeights = { distanceWeight: 1, curvinessWeight: 0, elevationWeight: 0, surfaceWeight: 0 };

/** Suma del costo de las aristas de un camino (la más corta entre paralelas). */
function costoDeCamino(g: ReturnType<typeof toGraph>, path: string[], w: RouteWeights): number {
  let total = 0;
  for (let i = 0; i < path.length - 1; i++) {
    const e = (g.adjacency.get(path[i]) ?? []).find((x) => x.toOsmId === path[i + 1])!;
    total += calculateEdgeCost(e, w);
  }
  return total;
}

describe('dijkstra (motor actual) — soluciones conocidas', () => {
  it('diamante: distancia pura elige el camino recto y corto', () => {
    const g = toGraph(diamante());
    const r = dijkstra(g, 'S', 'T', SOLO_DISTANCIA)!;
    expect(r.path).toEqual(['S', 'A', 'T']);
    expect(r.stats.distanceMeters).toBe(1000);
    expect(r.totalCost).toBeCloseTo(costoDeCamino(g, r.path, SOLO_DISTANCIA), 9);
  });

  it('diamante: moto-curvas elige el camino curvo aunque sea 30% más largo', () => {
    const g = toGraph(diamante());
    const r = dijkstra(g, 'S', 'T', PROFILES['moto-curvas'])!;
    expect(r.path).toEqual(['S', 'B', 'T']);
    expect(r.stats.distanceMeters).toBe(1300);
  });

  it('grilla 4×4: esquina a esquina recorre 6 cuadras (600 m)', () => {
    const g = toGraph(grilla(4));
    const r = dijkstra(g, '0,0', '3,3', SOLO_DISTANCIA)!;
    expect(r.stats.distanceMeters).toBe(600);
    expect(r.path).toHaveLength(7);
  });

  it('respeta el sentido único', () => {
    const g = toGraph(
      synthetic({ S: [0, 0], T: [0, 0.001] }, [{ from: 'S', to: 'T', length: 100, oneway: true }]),
    );
    expect(dijkstra(g, 'S', 'T', SOLO_DISTANCIA)).not.toBeNull();
    expect(dijkstra(g, 'T', 'S', SOLO_DISTANCIA)).toBeNull();
  });

  it('devuelve null si no hay camino (componentes separadas)', () => {
    const g = toGraph(
      synthetic({ A: [0, 0], B: [0, 0.001], C: [1, 1], D: [1, 1.001] }, [
        { from: 'A', to: 'B', length: 100 },
        { from: 'C', to: 'D', length: 100 },
      ]),
    );
    expect(dijkstra(g, 'A', 'D', SOLO_DISTANCIA)).toBeNull();
  });

  it('multi-candidato: elige el origen que da el menor costo', () => {
    const g = toGraph(
      synthetic({ S1: [0, 0], S2: [0, 0.004], T: [0, 0.005] }, [
        { from: 'S1', to: 'S2', length: 400 },
        { from: 'S2', to: 'T', length: 100 },
      ]),
    );
    const r = dijkstraMultiSource(g, ['S1', 'S2'], ['T'], SOLO_DISTANCIA)!;
    expect(r.path).toEqual(['S2', 'T']);
  });

  it('avoidNodes desvía el camino si hay alternativa razonable', () => {
    const g = toGraph(diamante());
    const r = dijkstra(g, 'S', 'T', SOLO_DISTANCIA, { avoidNodes: new Set(['A']) })!;
    expect(r.path).toEqual(['S', 'B', 'T']);
  });

  // Bug conocido (plan, §1.8): la relajación usa la arista paralela más BARATA,
  // pero la reconstrucción elige la más CORTA. Se corrige en F0.2; cuando se
  // corrija, este test empezará a pasar y Jest pedirá quitarle el `.failing`.
  it.failing('aristas paralelas: las estadísticas corresponden a la arista relajada (se corrige en F0.2)', () => {
    const g = toGraph(
      synthetic({ A: [0, 0], B: [0, 0.01] }, [
        { from: 'A', to: 'B', length: 1000, curviness: 1, oneway: true },
        { from: 'A', to: 'B', length: 900, curviness: 0, oneway: true },
      ]),
    );
    const r = dijkstra(g, 'A', 'B', PROFILES['moto-curvas'])!;
    // Con moto-curvas la arista curva (1000 m) es la más barata y es la relajada.
    expect(r.stats.distanceMeters).toBe(1000);
  });
});

describe('vías privadas: solo origen/destino, nunca de paso (D7)', () => {
  /**
   * Calle pública S—A—B—T (1000 + 3000 + 1000 m) con un atajo privado
   * A—P—B (300 + 300 m). Un condominio cuelga del portón A: casa H, H—K—A
   * (200 + 200 m, privado). Otro condominio cuelga de B: casa D, D—E—B.
   */
  const coords: Record<string, [number, number]> = {
    S: [0, 0], A: [0, 0.01], P: [0.002, 0.025], B: [0, 0.04], T: [0, 0.05],
    H: [0.004, 0.008], K: [0.002, 0.009], D: [0.004, 0.042], E: [0.002, 0.041],
  };
  const plain = synthetic(coords, [
    { from: 'S', to: 'A', length: 1000 },
    { from: 'A', to: 'B', length: 3000 },
    { from: 'B', to: 'T', length: 1000 },
    { from: 'A', to: 'P', length: 300 },
    { from: 'P', to: 'B', length: 300 },
    { from: 'H', to: 'K', length: 200 },
    { from: 'K', to: 'A', length: 200 },
    { from: 'D', to: 'E', length: 200 },
    { from: 'E', to: 'B', length: 200 },
  ]);
  const privados = new Set(['AP', 'PA', 'PB', 'BP', 'HK', 'KH', 'KA', 'AK', 'DE', 'ED', 'EB', 'BE']);
  for (const e of plain.edges) if (privados.has(e.fromOsmId + e.toOsmId)) e.destinationOnly = true;
  const g = toGraph(plain);

  it('no usa el atajo privado como paso entre calles públicas', () => {
    expect(dijkstra(g, 'S', 'T', SOLO_DISTANCIA)!.path).toEqual(['S', 'A', 'B', 'T']);
  });

  it('partir desde el portón (calle pública) no habilita el atajo', () => {
    expect(dijkstra(g, 'A', 'T', SOLO_DISTANCIA)!.path).toEqual(['A', 'B', 'T']);
  });

  it('sale de un condominio (origen adentro) y no encadena el atajo que comparte el portón', () => {
    expect(dijkstra(g, 'H', 'T', SOLO_DISTANCIA)!.path).toEqual(['H', 'K', 'A', 'B', 'T']);
  });

  it('llega a un condominio (destino adentro)', () => {
    expect(dijkstra(g, 'S', 'D', SOLO_DISTANCIA)!.path).toEqual(['S', 'A', 'B', 'E', 'D']);
  });

  it('de un condominio a otro: usa ambos accesos privados pero no el atajo', () => {
    expect(dijkstra(g, 'H', 'D', SOLO_DISTANCIA)!.path).toEqual(['H', 'K', 'A', 'B', 'E', 'D']);
  });

  it('sin marca de privado, el atajo sí se usa (control)', () => {
    const libre = toGraph(
      synthetic(coords, [
        { from: 'S', to: 'A', length: 1000 },
        { from: 'A', to: 'B', length: 3000 },
        { from: 'B', to: 'T', length: 1000 },
        { from: 'A', to: 'P', length: 300 },
        { from: 'P', to: 'B', length: 300 },
      ]),
    );
    expect(dijkstra(libre, 'S', 'T', SOLO_DISTANCIA)!.path).toEqual(['S', 'A', 'P', 'B', 'T']);
  });
});

describe('oráculo: el motor actual coincide con la copia congelada anterior a F0', () => {
  const pesos: [string, RouteWeights][] = [
    ['solo-distancia', SOLO_DISTANCIA],
    ['moto-curvas', PROFILES['moto-curvas']],
    ['4x4', PROFILES['4x4']],
    ['scenic', PROFILES.scenic],
  ];

  it.each(pesos)('sintéticos (%s)', (_nombre, w) => {
    for (const plain of [diamante(), grilla(5)]) {
      const g = toGraph(plain);
      const gl = toLegacyGraph(plain);
      for (const [a, b] of randomPairs(plain, 20, 1)) {
        const r = dijkstra(g, a, b, w);
        const rl = dijkstraLegacy(gl, a, b, w);
        expect(r?.totalCost).toBeCloseTo(rl!.totalCost, 9);
      }
    }
  });

  describe('subgrafo real de Farellones', () => {
    const plain = loadFixture('farellones');
    const g = toGraph(plain);
    const gl = toLegacyGraph(plain);
    const pares = randomPairs(plain, 40, 2026);

    it.each(pesos)('40 pares al azar con semilla fija (%s)', (_nombre, w) => {
      for (const [a, b] of pares) {
        const r = dijkstra(g, a, b, w);
        const rl = dijkstraLegacy(gl, a, b, w);
        if (rl === null) {
          expect(r).toBeNull();
          continue;
        }
        expect(r).not.toBeNull();
        const rel = Math.abs(r!.totalCost - rl.totalCost) / rl.totalCost;
        expect(rel).toBeLessThan(1e-9);
        expect(r!.path).toEqual(rl.path);
      }
    });
  });
});
