import { EngineRoute, dijkstra, dijkstraMultiSource } from './dijkstra';
import { RouteWeights, costFromFeatures } from './cost';
import { CompiledGraph, nodeIndex } from './compiled-graph';
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

/** El motor trabaja con índices; los tests usan los IDs de los fixtures. */
function ruta(g: CompiledGraph, a: string, b: string, w: RouteWeights, evitar?: string[]): EngineRoute | null {
  const avoidNodes = evitar ? new Set(evitar.map((x) => nodeIndex(g, x))) : undefined;
  return dijkstra(g, nodeIndex(g, a), nodeIndex(g, b), w, avoidNodes ? { avoidNodes } : undefined);
}

/** Suma del costo de las aristas recorridas. */
function costoDeCamino(g: CompiledGraph, r: EngineRoute, w: RouteWeights): number {
  let total = 0;
  for (const e of r.edgeIdx) {
    total += costFromFeatures(g.edgeLen[e], g.edgeStraight[e], g.edgeRough[e], g.edgeGrade[e], g.edgeMinor[e], w);
  }
  return total;
}

describe('dijkstra (motor actual) — soluciones conocidas', () => {
  it('diamante: distancia pura elige el camino recto y corto', () => {
    const g = toGraph(diamante());
    const r = ruta(g, 'S', 'T', SOLO_DISTANCIA)!;
    expect(r.path).toEqual(['S', 'A', 'T']);
    expect(r.stats.distanceMeters).toBe(1000);
    expect(r.totalCost).toBeCloseTo(costoDeCamino(g, r, SOLO_DISTANCIA), 9);
    // El camino de aristas encadena con el de nodos.
    expect(r.edgeIdx.map((e) => g.edgeFrom[e])).toEqual(r.nodeIdx.slice(0, -1));
    expect(r.edgeIdx.map((e) => g.edgeTo[e])).toEqual(r.nodeIdx.slice(1));
  });

  it('diamante: moto-curvas elige el camino curvo aunque sea 30% más largo', () => {
    const g = toGraph(diamante());
    const r = ruta(g, 'S', 'T', PROFILES['moto-curvas'])!;
    expect(r.path).toEqual(['S', 'B', 'T']);
    expect(r.stats.distanceMeters).toBe(1300);
  });

  it('grilla 4×4: esquina a esquina recorre 6 cuadras (600 m)', () => {
    const g = toGraph(grilla(4));
    const r = ruta(g, '0,0', '3,3', SOLO_DISTANCIA)!;
    expect(r.stats.distanceMeters).toBe(600);
    expect(r.path).toHaveLength(7);
  });

  it('respeta el sentido único', () => {
    const g = toGraph(
      synthetic({ S: [0, 0], T: [0, 0.001] }, [{ from: 'S', to: 'T', length: 100, oneway: true }]),
    );
    expect(ruta(g, 'S', 'T', SOLO_DISTANCIA)).not.toBeNull();
    expect(ruta(g, 'T', 'S', SOLO_DISTANCIA)).toBeNull();
  });

  it('devuelve null si no hay camino (componentes separadas)', () => {
    const g = toGraph(
      synthetic({ A: [0, 0], B: [0, 0.001], C: [1, 1], D: [1, 1.001] }, [
        { from: 'A', to: 'B', length: 100 },
        { from: 'C', to: 'D', length: 100 },
      ]),
    );
    expect(ruta(g, 'A', 'D', SOLO_DISTANCIA)).toBeNull();
  });

  it('multi-candidato: elige el origen que da el menor costo', () => {
    const g = toGraph(
      synthetic({ S1: [0, 0], S2: [0, 0.004], T: [0, 0.005] }, [
        { from: 'S1', to: 'S2', length: 400 },
        { from: 'S2', to: 'T', length: 100 },
      ]),
    );
    const ix = (id: string) => nodeIndex(g, id);
    const r = dijkstraMultiSource(g, [ix('S1'), ix('S2')], [ix('T')], SOLO_DISTANCIA)!;
    expect(r.path).toEqual(['S2', 'T']);
  });

  it('avoidNodes desvía el camino si hay alternativa razonable', () => {
    const g = toGraph(diamante());
    const r = ruta(g, 'S', 'T', SOLO_DISTANCIA, ['A'])!;
    expect(r.path).toEqual(['S', 'B', 'T']);
  });

  // Bug corregido en F0.2 (plan, §1.8): antes la relajación usaba la arista
  // paralela más BARATA y la reconstrucción la más CORTA. Ahora el camino guarda
  // la arista relajada.
  it('aristas paralelas: las estadísticas corresponden a la arista relajada', () => {
    const g = toGraph(
      synthetic({ A: [0, 0], B: [0, 0.01] }, [
        { from: 'A', to: 'B', length: 1000, curviness: 1, oneway: true },
        { from: 'A', to: 'B', length: 900, curviness: 0, oneway: true },
      ]),
    );
    const r = ruta(g, 'A', 'B', PROFILES['moto-curvas'])!;
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
    expect(ruta(g, 'S', 'T', SOLO_DISTANCIA)!.path).toEqual(['S', 'A', 'B', 'T']);
  });

  it('partir desde el portón (calle pública) no habilita el atajo', () => {
    expect(ruta(g, 'A', 'T', SOLO_DISTANCIA)!.path).toEqual(['A', 'B', 'T']);
  });

  it('sale de un condominio (origen adentro) y no encadena el atajo que comparte el portón', () => {
    expect(ruta(g, 'H', 'T', SOLO_DISTANCIA)!.path).toEqual(['H', 'K', 'A', 'B', 'T']);
  });

  it('llega a un condominio (destino adentro)', () => {
    expect(ruta(g, 'S', 'D', SOLO_DISTANCIA)!.path).toEqual(['S', 'A', 'B', 'E', 'D']);
  });

  it('de un condominio a otro: usa ambos accesos privados pero no el atajo', () => {
    expect(ruta(g, 'H', 'D', SOLO_DISTANCIA)!.path).toEqual(['H', 'K', 'A', 'B', 'E', 'D']);
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
    expect(ruta(libre, 'S', 'T', SOLO_DISTANCIA)!.path).toEqual(['S', 'A', 'P', 'B', 'T']);
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
        const r = ruta(g, a, b, w);
        const rl = dijkstraLegacy(gl, a, b, w);
        expect(r?.totalCost).toBeCloseTo(rl!.totalCost, 9);
        expect(r?.path).toEqual(rl!.path);
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
        const r = ruta(g, a, b, w);
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
