import { Endpoint, EngineRoute, Position, dijkstra, dijkstraMultiSource, endpointOfRawNode } from './dijkstra';
import { RouteWeights } from './cost';
import { CompiledGraph, geoOsmIdString, nodeIndex } from './compiled-graph';
import { assertSinRepeticion } from './no-repeat';
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

/** Extremo para un ID de los fixtures (nodo de unión o posición dentro de un tramo). */
function ep(g: CompiledGraph, id: string): Endpoint {
  const e = endpointOfRawNode(g, id);
  if (!e) throw new Error(`nodo ${id} no está en el grafo`);
  return e;
}

/** Ruta entre dos IDs de fixture; verifica siempre el RNF-SinRepetición. */
function ruta(g: CompiledGraph, a: string, b: string, w: RouteWeights, evitar?: string[]): EngineRoute | null {
  const avoidNodes = evitar ? new Set(evitar.map((x) => nodeIndex(g, x))) : undefined;
  const r = dijkstra(g, ep(g, a), ep(g, b), w, avoidNodes ? { avoidNodes } : undefined);
  if (r) assertSinRepeticion(r);
  return r;
}

describe('dijkstra (motor compactado) — soluciones conocidas', () => {
  it('diamante: distancia pura elige el camino recto y corto', () => {
    const plain = diamante();
    const g = toGraph(plain);
    const r = ruta(g, 'S', 'T', SOLO_DISTANCIA)!;
    expect(r.path).toEqual(['S', 'A', 'T']);
    expect(r.stats.distanceMeters).toBe(1000);
    // Mismo costo que el motor anterior a F0 (suma arista por arista).
    expect(r.totalCost).toBeCloseTo(dijkstraLegacy(toLegacyGraph(plain), 'S', 'T', SOLO_DISTANCIA)!.totalCost, 9);
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
    const g = toGraph(synthetic({ S: [0, 0], T: [0, 0.001] }, [{ from: 'S', to: 'T', length: 100, oneway: true }]));
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
    const r = dijkstraMultiSource(g, [ep(g, 'S1'), ep(g, 'S2')], [ep(g, 'T')], SOLO_DISTANCIA)!;
    expect(r.path).toEqual(['S2', 'T']);
  });

  it('avoidNodes desvía el camino si hay alternativa razonable', () => {
    // S—X—T corto (X es una unión: tiene un ramal X—Y); S—B—T un poco más largo.
    const g = toGraph(
      synthetic({ S: [0, 0], X: [0.001, 0.005], Y: [0.003, 0.005], B: [-0.001, 0.005], T: [0, 0.01] }, [
        { from: 'S', to: 'X', length: 500 },
        { from: 'X', to: 'T', length: 500 },
        { from: 'X', to: 'Y', length: 100 },
        { from: 'S', to: 'B', length: 550 },
        { from: 'B', to: 'T', length: 550 },
      ]),
    );
    expect(ruta(g, 'S', 'T', SOLO_DISTANCIA)!.path).toEqual(['S', 'X', 'T']);
    expect(ruta(g, 'S', 'T', SOLO_DISTANCIA, ['X'])!.path).toEqual(['S', 'B', 'T']);
  });

  // Bug corregido en F0.2 (plan, §1.8): las estadísticas corresponden a la
  // arista relajada, no a la más corta entre paralelas.
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

describe('nodos fantasma (snap a mitad de un tramo)', () => {
  // Calle recta de doble sentido S—T de 1000 m; vuelta de un sentido T→U→S de 3000 m.
  const g = toGraph(
    synthetic({ S: [0, 0], T: [0, 0.009], U: [0.01, 0.0045] }, [
      { from: 'S', to: 'T', length: 1000 },
    ]),
  );
  const unSentido = toGraph(
    synthetic({ S: [0, 0], T: [0, 0.009], U: [0.01, 0.0045] }, [
      { from: 'S', to: 'T', length: 1000, oneway: true },
      { from: 'T', to: 'U', length: 1500, oneway: true },
      { from: 'U', to: 'S', length: 1500, oneway: true },
    ]),
  );
  /** Posición a una fracción `t` del segmento S→T, esté como esté orientado en su tramo. */
  const pos = (gr: CompiledGraph, t: number): Position => {
    for (let c = 0; c < gr.meta.chainCount; c++) {
      for (let p = gr.chainStart[c]; p < gr.chainStart[c + 1] - 1; p++) {
        const a = geoOsmIdString(gr, p);
        const b = geoOsmIdString(gr, p + 1);
        if (a === 'S' && b === 'T') return { chain: c, point: p, t };
        if (a === 'T' && b === 'S') return { chain: c, point: p, t: 1 - t };
      }
    }
    throw new Error('segmento S—T no encontrado');
  };

  it('origen y destino en el mismo tramo: recorre solo el pedazo entre ambos', () => {
    const r = dijkstra(g, pos(g, 0.25), pos(g, 0.75), SOLO_DISTANCIA)!;
    expect(r.stats.distanceMeters).toBeCloseTo(500, 9);
    expect(r.totalCost).toBeCloseTo(500 * (0.15 + 0.6 + 0.3 * ((1.1 - 0.8) / 2.2)), 6);
    expect(r.coordinates).toHaveLength(2);
    assertSinRepeticion(r);
  });

  it('el pedazo hacia atrás también vale si el tramo es de doble sentido', () => {
    const r = dijkstra(g, pos(g, 0.75), pos(g, 0.25), SOLO_DISTANCIA)!;
    expect(r.stats.distanceMeters).toBeCloseTo(500, 9);
  });

  it('en un tramo de un sentido, ir "hacia atrás" obliga a dar la vuelta', () => {
    const r = dijkstra(unSentido, pos(unSentido, 0.75), pos(unSentido, 0.25), SOLO_DISTANCIA)!;
    // 250 m hasta T + 1500 + 1500 + 250 m desde S.
    expect(r.stats.distanceMeters).toBeCloseTo(3500, 9);
    expect(r.path).toEqual(['T', 'U', 'S']);
    // El tramo S→T se usa dos veces, pero en intervalos que no se superponen.
    expect(() => assertSinRepeticion(r)).not.toThrow();
  });

  it('origen a mitad de tramo hacia un nodo: costo exacto del pedazo', () => {
    const r = dijkstra(g, pos(g, 0.4), { node: nodeIndex(g, 'T') }, SOLO_DISTANCIA)!;
    expect(r.stats.distanceMeters).toBeCloseTo(600, 9);
    expect(r.path).toEqual(['T']);
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
  const g = toGraph(
    synthetic(coords, [
      { from: 'S', to: 'A', length: 1000 },
      { from: 'A', to: 'B', length: 3000 },
      { from: 'B', to: 'T', length: 1000 },
      { from: 'A', to: 'P', length: 300, destinationOnly: true },
      { from: 'P', to: 'B', length: 300, destinationOnly: true },
      { from: 'H', to: 'K', length: 200, destinationOnly: true },
      { from: 'K', to: 'A', length: 200, destinationOnly: true },
      { from: 'D', to: 'E', length: 200, destinationOnly: true },
      { from: 'E', to: 'B', length: 200, destinationOnly: true },
    ]),
  );

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

  it('origen a mitad de un pasaje privado (nodo fantasma) también puede salir', () => {
    expect(ruta(g, 'K', 'T', SOLO_DISTANCIA)!.path).toEqual(['K', 'A', 'B', 'T']);
  });

  it('una calle pública de un sentido que termina en un portón no habilita el área privada', () => {
    // O→J es pública y de un sentido (J no tiene salidas públicas); de J salen
    // vías privadas hacia T (atajo de 300 m). La única salida pública desde la
    // calle de O es volver por O—Z—T (3000 m).
    const g2 = toGraph(
      synthetic({ Z: [0, -0.01], O: [0, 0], M: [0, 0.001], J: [0, 0.002], Q: [0.001, 0.003], T: [0, 0.004] }, [
        { from: 'O', to: 'M', length: 100, oneway: true },
        { from: 'M', to: 'J', length: 100, oneway: true },
        { from: 'J', to: 'Q', length: 150, destinationOnly: true },
        { from: 'Q', to: 'T', length: 150, destinationOnly: true },
        { from: 'Z', to: 'O', length: 1000 },
        { from: 'Z', to: 'T', length: 2000 },
        { from: 'J', to: 'Z', length: 1500 },
      ]),
    );
    // Desde M (a mitad de la calle pública O→J) no se puede cruzar J→Q→T.
    const r = ruta(g2, 'M', 'T', SOLO_DISTANCIA)!;
    expect(r.path).not.toContain('Q');
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

describe('oráculo: el motor compactado da el mismo costo que la copia congelada anterior a F0', () => {
  const pesos: [string, RouteWeights][] = [
    ['solo-distancia', SOLO_DISTANCIA],
    ['moto-curvas', PROFILES['moto-curvas']],
    ['4x4', PROFILES['4x4']],
    ['scenic', PROFILES.scenic],
  ];

  // En la grilla hay muchos caminos de igual costo: se compara el costo, no el camino.
  it.each(pesos)('sintéticos (%s)', (_nombre, w) => {
    for (const plain of [diamante(), grilla(5)]) {
      const g = toGraph(plain);
      const gl = toLegacyGraph(plain);
      for (const [a, b] of randomPairs(plain, 20, 1)) {
        const r = ruta(g, a, b, w);
        const rl = dijkstraLegacy(gl, a, b, w);
        expect(r?.totalCost).toBeCloseTo(rl!.totalCost, 6);
      }
    }
  });

  describe('subgrafo real de Farellones (orígenes y destinos en nodos crudos)', () => {
    const plain = loadFixture('farellones');
    const g = toGraph(plain);
    const gl = toLegacyGraph(plain);
    const pares = randomPairs(plain, 40, 2026);

    it('compacta a menos del 25% de los nodos', () => {
      expect(g.meta.nodeCount / g.meta.rawNodeCount).toBeLessThan(0.25);
    });

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
