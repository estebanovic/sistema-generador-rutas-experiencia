import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CompiledGraph, geoOsmIdString, nodeIndex } from '../dijkstra/compiled-graph';
import { costFromFeatures, costFromSums, edgeFeatures } from '../dijkstra/cost';
import { dijkstra, endpointOfRawNode } from '../dijkstra/dijkstra';
import { PROFILES } from '../routes/profiles';
import { EdgeSpec, diamante, loadFixture, randomPairs, synthetic, toGraph } from '../../test/fixtures/graph-fixtures';
import { compileGraph } from './compile';
import { readSnapshot, snapshotFileName, writeSnapshot } from './snapshot';

/** Etiquetas de la geometría de cada tramo, para afirmar la compactación. */
function tramos(g: CompiledGraph): string[] {
  const out: string[] = [];
  for (let c = 0; c < g.meta.chainCount; c++) {
    const ids: string[] = [];
    for (let p = g.chainStart[c]; p < g.chainStart[c + 1]; p++) ids.push(geoOsmIdString(g, p));
    out.push(ids.join('-'));
  }
  return out.sort();
}
const nodos = (g: CompiledGraph) => Array.from({ length: g.meta.nodeCount }, (_, i) => g.rawLabels![g.nodeOsmId[i]]).sort();

describe('compactación', () => {
  it('diamante: todos sus nodos tienen grado 2, así que es un solo tramo-lazo', () => {
    const g = toGraph(diamante());
    expect(g.meta.nodeCount).toBe(1);
    expect(g.meta.chainCount).toBe(1);
    expect(g.meta.rawNodeCount).toBe(4);
  });

  it('un cruce en T: tres tramos que salen de la unión', () => {
    const g = toGraph(
      synthetic({ A: [0, 0], B: [0, 0.001], C: [0, 0.002], D: [0.001, 0.001], E: [0.002, 0.001] }, [
        { from: 'A', to: 'B', length: 100 },
        { from: 'B', to: 'C', length: 100 },
        { from: 'B', to: 'D', length: 100 },
        { from: 'D', to: 'E', length: 100 },
      ]),
    );
    expect(nodos(g)).toEqual(['A', 'B', 'C', 'E']);
    expect(g.meta.chainCount).toBe(3);
    expect(g.meta.edgeCount).toBe(6); // tres tramos × dos sentidos
  });

  const linea = (extra: Partial<EdgeSpec>[]): ReturnType<typeof toGraph> =>
    toGraph(
      synthetic({ A: [0, 0], B: [0, 0.001], C: [0, 0.002], D: [0, 0.003] }, [
        { from: 'A', to: 'B', length: 100, ...extra[0] },
        { from: 'B', to: 'C', length: 100, ...extra[1] },
        { from: 'C', to: 'D', length: 100, ...extra[2] },
      ]),
    );

  it('una línea uniforme es un solo tramo', () => {
    expect(tramos(linea([{}, {}, {}]))).toEqual(['A-B-C-D']);
  });

  it('se corta donde cambia el sentido de circulación', () => {
    const g = linea([{}, { oneway: true }, {}]);
    expect(nodos(g)).toEqual(['A', 'B', 'C', 'D']);
  });

  it('se corta donde cambia el acceso privado', () => {
    const g = linea([{}, {}, { destinationOnly: true }]);
    expect(tramos(g)).toEqual(['A-B-C', 'C-D']);
  });

  it('vías paralelas entre los mismos nodos son tramos distintos', () => {
    const g = toGraph(
      synthetic({ A: [0, 0], B: [0, 0.001] }, [
        { from: 'A', to: 'B', length: 100 },
        { from: 'A', to: 'B', length: 120 },
      ]),
    );
    expect(g.meta.chainCount).toBe(2);
    expect(nodos(g)).toEqual(['A', 'B']);
  });

  it('un ciclo puro conserva un nodo de unión', () => {
    const g = toGraph(
      synthetic({ A: [0, 0], B: [0, 0.001], C: [0.001, 0] }, [
        { from: 'A', to: 'B', length: 100 },
        { from: 'B', to: 'C', length: 100 },
        { from: 'C', to: 'A', length: 100 },
      ]),
    );
    expect(g.meta.nodeCount).toBe(1);
    expect(g.meta.chainCount).toBe(1);
  });

  it('tramoOf: las dos aristas de un tramo (ida y vuelta) comparten tramo y son inversas', () => {
    const g = toGraph(loadFixture('farellones'));
    for (let c = 0; c < g.meta.chainCount; c++) {
      const f = g.chainFwd[c];
      const b = g.chainBwd[c];
      if (f >= 0) expect([g.edgeChain[f], g.edgeDir[f]]).toEqual([c, 0]);
      if (b >= 0) expect([g.edgeChain[b], g.edgeDir[b]]).toEqual([c, 1]);
      if (f >= 0 && b >= 0) {
        expect(g.edgeFrom[f]).toBe(g.edgeTo[b]);
        expect(g.edgeTo[f]).toBe(g.edgeFrom[b]);
      }
    }
  });

  it('el costo de un tramo compactado es la suma de sus segmentos', () => {
    const plain = synthetic({ A: [0, 0], B: [0, 0.001], C: [0, 0.002], D: [0, 0.003] }, [
      { from: 'A', to: 'B', length: 130, curviness: 0.9, surface: 'gravel', highwayType: 'track' },
      { from: 'B', to: 'C', length: 70, curviness: 0.2, surface: 'asphalt', highwayType: 'tertiary' },
      { from: 'C', to: 'D', length: 210, curviness: 0.5, surface: 'dirt', highwayType: 'unclassified' },
    ]);
    const g = toGraph(plain);
    for (const [, w] of Object.entries(PROFILES)) {
      const segmentos = plain.edges
        .filter((e) => e.fromOsmId < e.toOsmId)
        .reduce((s, e) => {
          return s + costFromFeatures(e.distanceMeters, edgeFeatures(e), w);
        }, 0);
      const e = g.chainFwd[0] >= 0 ? g.chainFwd[0] : g.chainBwd[0];
      const tramo = costFromSums(g.edgeLen[e], g.edgeSumStraight[e], g.edgeSumUnpaved[e], g.edgeSumMinor[e], w);
      expect(Math.abs(tramo - segmentos) / segmentos).toBeLessThan(1e-12);
    }
  });
});

describe('componentes fuertemente conexas (D15)', () => {
  it('marca la componente mayor; una calle de un sentido sin retorno queda fuera', () => {
    // A–B–C–D de doble sentido; C→E de un sentido (E no sale); F–G es una isla.
    const g = toGraph(
      synthetic(
        { A: [0, 0], B: [0, 0.001], C: [0, 0.002], D: [0, 0.003], E: [0, 0.004], F: [1, 1], G: [1, 1.001] },
        [
          { from: 'A', to: 'B', length: 100 },
          { from: 'B', to: 'C', length: 100 },
          { from: 'C', to: 'D', length: 100 },
          { from: 'C', to: 'E', length: 100, oneway: true },
          { from: 'F', to: 'G', length: 100 },
        ],
      ),
    );
    const enMayor = (id: string) => g.nodeInMainScc[nodeIndex(g, id)] === 1;
    // B quedó dentro del tramo A–B–C; las uniones son A, C, D, E, F, G.
    expect(['A', 'C', 'D'].every(enMayor)).toBe(true);
    expect(enMayor('E')).toBe(false);
    expect(enMayor('F')).toBe(false);
    expect(g.meta.mainSccSize).toBe(3);
    expect(g.meta.sccCount).toBe(3); // {A,C,D}, {E}, {F,G}
  });
});

describe('enclaves (D16)', () => {
  // Red pública S–A–B–T (ciclo con X para que no todo sea un tramo). Portón
  // privado A–P; detrás, calles "públicas" P–Q–R sin otra salida: enclave.
  const g = toGraph(
    synthetic(
      { S: [0, 0], A: [0, 0.001], B: [0, 0.002], T: [0, 0.003], X: [0.001, 0.0015], P: [-0.001, 0.001], Q: [-0.002, 0.001], R: [-0.002, 0.002] },
      [
        { from: 'S', to: 'A', length: 100 },
        { from: 'A', to: 'B', length: 100 },
        { from: 'B', to: 'T', length: 100 },
        { from: 'A', to: 'X', length: 150 },
        { from: 'X', to: 'B', length: 150 },
        { from: 'A', to: 'P', length: 100, destinationOnly: true },
        { from: 'P', to: 'Q', length: 100 },
        { from: 'Q', to: 'R', length: 100 },
        { from: 'R', to: 'P', length: 120 },
      ],
    ),
  );
  const privado = (a: string, b: string) => {
    for (let c = 0; c < g.meta.chainCount; c++) {
      const ids = new Set<string>();
      for (let p = g.chainStart[c]; p < g.chainStart[c + 1]; p++) ids.add(geoOsmIdString(g, p));
      if (ids.has(a) && ids.has(b)) return (g.chainFlags[c] & 1) === 1;
    }
    throw new Error(`sin tramo ${a}-${b}`);
  };

  it('las calles públicas detrás de un portón privado pasan a ser privadas', () => {
    expect(privado('Q', 'R')).toBe(true);
    expect(g.meta.enclaveChains).toBeGreaterThan(0);
  });

  it('la red pública principal no se toca', () => {
    expect(privado('S', 'A')).toBe(false);
    expect(privado('A', 'X')).toBe(false);
  });

  it('desde dentro del enclave se puede salir, y de paso no se usa', () => {
    const r = dijkstra(g, endpointOfRawNode(g, 'Q')!, endpointOfRawNode(g, 'T')!, PROFILES['moto-curvas']);
    expect(r).not.toBeNull();
    expect(r!.path[0]).toBe('Q');
  });
});

describe('puentes (excepción del acceso, D14)', () => {
  // Ciclo A–B–C–A; de C sale un acceso C–D–E (D queda dentro del tramo) hacia un
  // "condominio" en árbol E–F, E–G. Además X–Y unidos por dos vías paralelas.
  const g = toGraph(
    synthetic(
      { A: [0, 0], B: [0, 0.001], C: [0.001, 0], D: [0.002, 0], E: [0.003, 0], F: [0.004, 0], G: [0.003, 0.001], X: [1, 1], Y: [1, 1.001] },
      [
        { from: 'A', to: 'B', length: 100 },
        { from: 'B', to: 'C', length: 100 },
        { from: 'C', to: 'A', length: 100 },
        { from: 'C', to: 'D', length: 100 },
        { from: 'D', to: 'E', length: 100 },
        { from: 'E', to: 'F', length: 100 },
        { from: 'E', to: 'G', length: 100 },
        { from: 'X', to: 'Y', length: 100 },
        { from: 'X', to: 'Y', length: 110 },
      ],
    ),
  );
  const puentes = () => {
    const out: string[] = [];
    for (let c = 0; c < g.meta.chainCount; c++) {
      if (!g.chainIsBridge[c]) continue;
      const ids: string[] = [];
      for (let p = g.chainStart[c]; p < g.chainStart[c + 1]; p++) ids.push(geoOsmIdString(g, p));
      out.push([ids[0], ids[ids.length - 1]].sort().join('-'));
    }
    return out.sort();
  };

  it('el acceso y las calles del árbol son puentes; el ciclo y las paralelas no', () => {
    expect(puentes()).toEqual(['C-E', 'E-F', 'E-G']);
  });

  it('grado no dirigido por nodo de unión', () => {
    expect(g.nodeDegree[nodeIndex(g, 'C')]).toBe(2 + 1); // el ciclo cuenta 2 (A–B–C–A es un lazo desde C) + el acceso
    expect(g.nodeDegree[nodeIndex(g, 'E')]).toBe(3);
  });
});

describe('calzadas gemelas (D13)', () => {
  // Dos calzadas de un sentido, en sentidos opuestos, a ~30 m (0,00027° de latitud).
  const coords: Record<string, [number, number]> = {
    N1: [0, 0], N2: [0, 0.009], S1: [0.00027, 0.009], S2: [0.00027, 0],
    L1: [0.0009, 0], L2: [0.0009, 0.009], // otra calle con el mismo nombre, a ~100 m
    D1: [-0.00027, 0], D2: [-0.00027, 0.009], // calle con otro nombre a ~30 m, sentido opuesto
  };
  const plain = synthetic(coords, [
    { from: 'N1', to: 'N2', length: 1000, oneway: true, way: '1' },
    { from: 'S1', to: 'S2', length: 1000, oneway: true, way: '2' },
    { from: 'L2', to: 'L1', length: 1000, oneway: true, way: '3' },
    { from: 'D2', to: 'D1', length: 1000, oneway: true, way: '4' },
  ]);
  const g = compileGraph({
    nodes: plain.nodes,
    edges: plain.edges,
    source: 'test',
    dataVersion: 0,
    wayLabels: new Map([
      ['1', { name: 'Avenida X' }],
      ['2', { name: 'avenida x ' }],
      ['3', { name: 'Avenida X' }],
      ['4', { name: 'Avenida Y' }],
    ]),
  });
  const edgeOfWay = (way: number) => {
    for (let e = 0; e < g.meta.edgeCount; e++) if (g.segWay[g.chainStart[g.edgeChain[e]]] === way) return e;
    throw new Error(`sin arista para el way ${way}`);
  };
  const gemelas = (e: number) => Array.from(g.twinEdge.slice(g.twinStart[e], g.twinStart[e + 1]));

  it('las dos calzadas del mismo nombre, opuestas y a 30 m, son gemelas entre sí', () => {
    expect(gemelas(edgeOfWay(1))).toEqual([edgeOfWay(2)]);
    expect(gemelas(edgeOfWay(2))).toEqual([edgeOfWay(1)]);
    expect(g.twinFrac[g.twinStart[edgeOfWay(1)]]).toBeGreaterThan(0.9);
  });

  it('no son gemelas: a 100 m, con otro nombre', () => {
    expect(gemelas(edgeOfWay(3))).toEqual([]);
    expect(gemelas(edgeOfWay(4))).toEqual([]);
  });
});

describe('snapshot', () => {
  const plain = loadFixture('farellones');
  const g = toGraph(plain);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'grafo-'));
  const file = path.join(dir, snapshotFileName(g.meta));
  writeSnapshot(file, g);
  const h = readSnapshot(file);

  afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

  it('compilar → serializar → cargar da el mismo grafo', () => {
    expect(h.meta).toEqual(g.meta);
    for (const k of Object.keys(g) as (keyof CompiledGraph)[]) {
      if (k === 'meta') continue;
      const a = g[k] as ArrayLike<number> | string[] | undefined;
      const b = h[k] as ArrayLike<number> | string[] | undefined;
      expect(b && Array.from(b as ArrayLike<number>)).toEqual(a && Array.from(a as ArrayLike<number>));
    }
  });

  it('el motor da las mismas rutas sobre el grafo cargado del snapshot', () => {
    for (const [a, b] of randomPairs(plain, 20, 7)) {
      const r1 = dijkstra(g, endpointOfRawNode(g, a)!, endpointOfRawNode(g, b)!, PROFILES['moto-curvas']);
      const r2 = dijkstra(h, endpointOfRawNode(h, a)!, endpointOfRawNode(h, b)!, PROFILES['moto-curvas']);
      expect(r2?.totalCost).toBe(r1?.totalCost);
      expect(r2?.path).toEqual(r1?.path);
    }
  });

  it('rechaza un archivo que no es snapshot', () => {
    const otro = path.join(dir, 'otro.bin');
    fs.writeFileSync(otro, 'no soy un grafo');
    expect(() => readSnapshot(otro)).toThrow(/No es un snapshot/);
  });
});
