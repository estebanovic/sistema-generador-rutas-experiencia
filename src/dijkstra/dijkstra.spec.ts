import { Endpoint, EngineRoute, Position, dijkstra, dijkstraMultiSource, endpointOfRawNode } from './dijkstra';
import { MINOR_ROAD_PENALTY, RouteWeights, W_MAX, costFromSums, edgeFeatures } from './cost';
import { CompiledGraph, geoOsmIdString, nodeIndex } from './compiled-graph';
import { assertSinRepeticion } from './no-repeat';
import { TramoOverlay } from './overlay';
import { PROFILES } from '../routes/profiles';
import {
  PlainGraph,
  diamante,
  grilla,
  loadFixture,
  randomPairs,
  synthetic,
  toGraph,
} from '../../test/fixtures/graph-fixtures';

/** Pesos en 0: el costo es la distancia (más el recargo fijo de vías menores, D7). */
const SOLO_DISTANCIA: RouteWeights = { curvinessWeight: 0, surfaceWeight: 0 };

/** Extremo para un ID de los fixtures (nodo de unión o posición dentro de un tramo). */
function ep(g: CompiledGraph, id: string): Endpoint {
  const e = endpointOfRawNode(g, id);
  if (!e) throw new Error(`nodo ${id} no está en el grafo`);
  return e;
}

/** Ruta entre dos IDs de fixture; verifica siempre el RNF-SinRepetición. */
function ruta(g: CompiledGraph, a: string, b: string, w: RouteWeights, blocked?: TramoOverlay): EngineRoute | null {
  const r = dijkstra(g, ep(g, a), ep(g, b), w, blocked ? { blocked } : undefined);
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
    // Con los pesos en 0 el costo es la distancia.
    expect(r.totalCost).toBe(1000);
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

  it('un tramo bloqueado (overlay duro) desvía el camino si hay alternativa', () => {
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
    const corta = ruta(g, 'S', 'T', SOLO_DISTANCIA)!;
    expect(corta.path).toEqual(['S', 'X', 'T']);
    const usado = new TramoOverlay(g);
    usado.addRoute(corta);
    expect(ruta(g, 'S', 'T', SOLO_DISTANCIA, usado)!.path).toEqual(['S', 'B', 'T']);
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
    expect(r.totalCost).toBeCloseTo(500, 9);
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

// ── Función de costo (F2) ──
//
// Desde F2 el oráculo ya no es el motor anterior a F0 (otro costo), sino un
// Dijkstra de referencia por aristas crudas con el costo nuevo, más
// propiedades que debe cumplir cualquier costo L·(1 + Σ wᵢ·pᵢ).

/** Dijkstra de referencia sobre el grafo plano (aristas crudas, sin compactar), con el costo de cost.ts. */
function referencia(p: PlainGraph, a: string, b: string, w: RouteWeights): number | null {
  const adj = new Map<string, { to: string; cost: number }[]>();
  for (const e of p.edges) {
    const f = edgeFeatures(e);
    const L = e.distanceMeters;
    const cost = costFromSums(L, L * f.straightness, L * f.unpaved, L * f.minorRoad, w);
    const l = adj.get(e.fromOsmId);
    if (l) l.push({ to: e.toOsmId, cost });
    else adj.set(e.fromOsmId, [{ to: e.toOsmId, cost }]);
  }
  const dist = new Map<string, number>([[a, 0]]);
  const done = new Set<string>();
  const heap: [number, string][] = [[0, a]];
  const push = (x: [number, string]) => {
    heap.push(x);
    let i = heap.length - 1;
    while (i > 0) {
      const q = (i - 1) >> 1;
      if (heap[q][0] <= heap[i][0]) break;
      [heap[q], heap[i]] = [heap[i], heap[q]];
      i = q;
    }
  };
  const pop = (): [number, string] => {
    const top = heap[0];
    const last = heap.pop()!;
    if (heap.length > 0) {
      heap[0] = last;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1;
        const r = l + 1;
        let m = i;
        if (l < heap.length && heap[l][0] < heap[m][0]) m = l;
        if (r < heap.length && heap[r][0] < heap[m][0]) m = r;
        if (m === i) break;
        [heap[m], heap[i]] = [heap[i], heap[m]];
        i = m;
      }
    }
    return top;
  };
  while (heap.length) {
    const [d, u] = pop();
    if (done.has(u)) continue;
    done.add(u);
    if (u === b) return d;
    for (const { to, cost } of adj.get(u) ?? []) {
      if (d + cost < (dist.get(to) ?? Infinity)) {
        dist.set(to, d + cost);
        push([d + cost, to]);
      }
    }
  }
  return null;
}

/** Metros recorridos por la ruta y Σ largo × feature (rectitud, sin pavimentar), desde sus tramos. */
function totales(g: CompiledGraph, r: EngineRoute) {
  const at = (arr: Float64Array, c: number, s: number) => {
    let lo = g.chainStart[c];
    let hi = g.chainStart[c + 1] - 1;
    while (hi - lo > 1) {
      const m = (lo + hi) >> 1;
      if (g.geoCumLen[m] <= s) lo = m;
      else hi = m;
    }
    const L0 = g.geoCumLen[lo];
    const L1 = g.geoCumLen[hi];
    const t = L1 > L0 ? (s - L0) / (L1 - L0) : 0;
    return arr[lo] + t * (arr[hi] - arr[lo]);
  };
  let len = 0;
  let recto = 0;
  let sinPavimentar = 0;
  for (const u of r.tramos) {
    len += u.s1 - u.s0;
    recto += at(g.geoCumStraight, u.chain, u.s1) - at(g.geoCumStraight, u.chain, u.s0);
    sinPavimentar += at(g.geoCumUnpaved, u.chain, u.s1) - at(g.geoCumUnpaved, u.chain, u.s0);
  }
  return { len, recto, sinPavimentar, pavimentado: len - sinPavimentar };
}

/** Generador determinista (mulberry32). */
function azar(seed: number) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe('función de costo (F2): propiedades sobre el subgrafo real de Farellones', () => {
  const plain = loadFixture('farellones');
  const g = toGraph(plain);
  const pares = randomPairs(plain, 40, 2026);

  it('compacta a menos del 25% de los nodos', () => {
    expect(g.meta.nodeCount / g.meta.rawNodeCount).toBeLessThan(0.25);
  });

  it('costo ≥ L en todas las aristas, con pesos extremos y al azar', () => {
    const rnd = azar(7);
    const pesos: RouteWeights[] = [
      { curvinessWeight: 0, surfaceWeight: 0 },
      { curvinessWeight: W_MAX, surfaceWeight: W_MAX },
      { curvinessWeight: W_MAX, surfaceWeight: -W_MAX },
      ...Array.from({ length: 20 }, () => ({ curvinessWeight: rnd() * W_MAX, surfaceWeight: (2 * rnd() - 1) * W_MAX })),
    ];
    let violaciones = 0;
    for (const w of pesos) {
      for (let e = 0; e < g.meta.edgeCount; e++) {
        const c = costFromSums(g.edgeLen[e], g.edgeSumStraight[e], g.edgeSumUnpaved[e], g.edgeSumMinor[e], w);
        if (!(c >= g.edgeLen[e])) violaciones++;
      }
    }
    expect(violaciones).toBe(0);
  });

  it.each(Object.entries({ 'pesos en 0': SOLO_DISTANCIA, ...PROFILES }))(
    'mismo costo que el Dijkstra de referencia por aristas crudas (%s)',
    (_nombre, w) => {
      for (const [a, b] of pares) {
        const r = ruta(g, a, b, w);
        const ref = referencia(plain, a, b, w);
        if (ref === null) {
          expect(r).toBeNull();
          continue;
        }
        expect(Math.abs(r!.totalCost - ref) / ref).toBeLessThan(1e-9);
      }
    },
  );

  it('con los pesos en 0, el costo es el largo más, a lo sumo, el recargo de vías menores', () => {
    for (const [a, b] of pares) {
      const r = ruta(g, a, b, SOLO_DISTANCIA);
      if (!r) continue;
      const { len } = totales(g, r);
      expect(r.totalCost).toBeGreaterThanOrEqual(len - 1e-6);
      expect(r.totalCost).toBeLessThanOrEqual(len * (1 + MINOR_ROAD_PENALTY) + 1e-6);
    }
  });

  // Ruta óptima con costo A + w·B: si w crece, B no puede crecer (sumando las
  // dos desigualdades de optimalidad queda (w₂ − w₁)(B₂ − B₁) ≤ 0).
  it('monotonía: más peso a las curvas nunca agrega metros rectos', () => {
    for (const [a, b] of pares) {
      let antes = Infinity;
      for (const c of [0, 0.5, 1, 2, W_MAX]) {
        const r = ruta(g, a, b, { curvinessWeight: c, surfaceWeight: 0 });
        if (!r) break;
        const { recto } = totales(g, r);
        expect(recto).toBeLessThanOrEqual(antes + 1e-6);
        antes = recto;
      }
    }
  });

  it('monotonía: más peso positivo a la superficie nunca agrega metros sin pavimentar', () => {
    for (const [a, b] of pares) {
      let antes = Infinity;
      for (const s of [0, 0.5, 1, 2, W_MAX]) {
        const r = ruta(g, a, b, { curvinessWeight: 1, surfaceWeight: s });
        if (!r) break;
        const { sinPavimentar } = totales(g, r);
        expect(sinPavimentar).toBeLessThanOrEqual(antes + 1e-6);
        antes = sinPavimentar;
      }
    }
  });

  it('monotonía: más peso negativo a la superficie nunca agrega metros pavimentados', () => {
    for (const [a, b] of pares) {
      let antes = Infinity;
      for (const s of [0, -0.5, -1, -2, -W_MAX]) {
        const r = ruta(g, a, b, { curvinessWeight: 0, surfaceWeight: s });
        if (!r) break;
        const { pavimentado } = totales(g, r);
        expect(pavimentado).toBeLessThanOrEqual(antes + 1e-6);
        antes = pavimentado;
      }
    }
  });
});

describe('función de costo (F2): perfiles y vías menores', () => {
  type Attrs = Partial<{ curviness: number; surface: 'asphalt' | 'gravel'; highwayType: 'living_street' | 'service' }>;
  /** Dos caminos S→T: por A (1000 m) y por B (largo y atributos a elección). */
  const dos = (a: Attrs, b: Attrs, largoB: number) =>
    toGraph(
      synthetic({ S: [0, 0], A: [0.003, 0.0045], B: [-0.004, 0.0045], T: [0, 0.009] }, [
        { from: 'S', to: 'A', length: 500, ...a },
        { from: 'A', to: 'T', length: 500, ...a },
        { from: 'S', to: 'B', length: largoB / 2, ...b },
        { from: 'B', to: 'T', length: largoB / 2, ...b },
      ]),
    );

  it('4x4 toma el ripio aunque sea 30% más largo; con los pesos en 0, el pavimento', () => {
    const g = dos({}, { surface: 'gravel' }, 1300);
    expect(ruta(g, 'S', 'T', PROFILES['4x4'])!.path).toEqual(['S', 'B', 'T']);
    expect(ruta(g, 'S', 'T', SOLO_DISTANCIA)!.path).toEqual(['S', 'A', 'T']);
  });

  it('scenic prefiere la curva pavimentada a la curva de ripio; moto-curvas toma la más corta de las dos', () => {
    const g = dos({ curviness: 1, surface: 'gravel' }, { curviness: 1, surface: 'asphalt' }, 1100);
    expect(ruta(g, 'S', 'T', PROFILES.scenic)!.path).toEqual(['S', 'B', 'T']);
    expect(ruta(g, 'S', 'T', PROFILES['moto-curvas'])!.path).toEqual(['S', 'A', 'T']);
  });

  it.each(['living_street', 'service'] as const)('%s lleva un recargo fijo (D7): con los pesos en 0 cuesta 1,5 veces su largo', (hw) => {
    // 1000 m de vía menor cuestan 1500: gana un camino normal de 1400 m...
    const r = ruta(dos({ highwayType: hw }, {}, 1400), 'S', 'T', SOLO_DISTANCIA)!;
    expect(r.path).toEqual(['S', 'B', 'T']);
    expect(r.totalCost).toBeCloseTo(1400, 9);
    // ...pero no uno de 1600.
    const r2 = ruta(dos({ highwayType: hw }, {}, 1600), 'S', 'T', SOLO_DISTANCIA)!;
    expect(r2.path).toEqual(['S', 'A', 'T']);
    expect(r2.totalCost).toBeCloseTo(1000 * (1 + MINOR_ROAD_PENALTY), 9);
  });
});
