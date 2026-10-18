import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CompiledGraph, nodeIndex } from '../dijkstra/compiled-graph';
import { dijkstra } from '../dijkstra/dijkstra';
import { PROFILES } from '../routes/profiles';
import { loadFixture, randomPairs, synthetic, toGraph } from '../../test/fixtures/graph-fixtures';
import { compileGraph } from './compile';
import { readSnapshot, snapshotFileName, writeSnapshot } from './snapshot';

describe('compileGraph', () => {
  const plain = synthetic({ A: [0, 0], B: [0, 0.001], C: [0, 0.002] }, [
    { from: 'A', to: 'B', length: 100 },
    { from: 'B', to: 'C', length: 120, curviness: 0.5 },
    { from: 'A', to: 'C', length: 300, oneway: true },
  ]);

  it('agrupa las aristas por origen conservando el orden de entrada', () => {
    const g = toGraph(plain);
    const a = nodeIndex(g, 'A');
    const salientes: number[] = [];
    for (let e = g.outStart[a]; e < g.outStart[a + 1]; e++) salientes.push(g.edgeLen[e]);
    // A→B (100) se declaró antes que A→C (300).
    expect(salientes).toEqual([100, 300]);
  });

  it('la CSR de entrada contiene exactamente las aristas que llegan a cada nodo', () => {
    const g = toGraph(plain);
    for (let v = 0; v < g.meta.nodeCount; v++) {
      const entrantes: number[] = [];
      for (let p = g.inStart[v]; p < g.inStart[v + 1]; p++) entrantes.push(g.inEdge[p]);
      const esperadas: number[] = [];
      for (let e = 0; e < g.meta.edgeCount; e++) if (g.edgeTo[e] === v) esperadas.push(e);
      expect(entrantes.sort()).toEqual(esperadas.sort());
    }
  });

  it('descarta aristas colgantes (extremo ausente)', () => {
    const g = compileGraph({
      nodes: plain.nodes,
      edges: [...plain.edges, { ...plain.edges[0], toOsmId: 'X' }],
      source: 'test',
      dataVersion: 0,
      hasElevation: false,
    });
    expect(g.meta.edgeCount).toBe(plain.edges.length);
  });

  it('IDs numéricos: nodos ordenados y búsqueda binaria', () => {
    const g = compileGraph({
      nodes: [
        { osmId: '30', lat: 0, lon: 0, elevation: 0 },
        { osmId: '5', lat: 0, lon: 0.001, elevation: 0 },
        { osmId: '12000000000', lat: 0, lon: 0.002, elevation: 0 },
      ],
      edges: [],
      source: 'test',
      dataVersion: 0,
      hasElevation: false,
    });
    expect([...g.nodeOsmId]).toEqual([5, 30, 12000000000]);
    expect(g.nodeLabels).toBeUndefined();
    expect(nodeIndex(g, '12000000000')).toBe(2);
    expect(nodeIndex(g, '7')).toBe(-1);
  });
});

describe('componentes fuertemente conexas (D15)', () => {
  it('marca la componente mayor; una calle de un sentido sin retorno queda fuera', () => {
    // Núcleo de doble sentido A–B–C–D; E solo se alcanza (C→E, un sentido) pero no sale.
    // F–G es una isla de doble sentido.
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
    expect(['A', 'B', 'C', 'D'].every(enMayor)).toBe(true);
    expect(enMayor('E')).toBe(false);
    expect(enMayor('F')).toBe(false);
    expect(g.meta.mainSccSize).toBe(4);
    expect(g.meta.sccCount).toBe(3); // {A,B,C,D}, {E}, {F,G}
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
      const r1 = dijkstra(g, nodeIndex(g, a), nodeIndex(g, b), PROFILES['moto-curvas']);
      const r2 = dijkstra(h, nodeIndex(h, a), nodeIndex(h, b), PROFILES['moto-curvas']);
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
