import { HighwayType, SmoothnessType, SurfaceType } from './types';

/**
 * Grafo compilado: arrays tipados en formato CSR (Compressed Sparse Row). Es lo
 * único que ve el motor. Lo produce `src/graph-compiler/compile.ts` y se
 * serializa tal cual en el snapshot (`snapshot.ts`).
 *
 * Nodos: índices 0..N-1, ordenados por osmId numérico (búsqueda binaria).
 * Aristas: índices 0..M-1, agrupadas por nodo de origen; dentro de cada nodo,
 * en el orden en que las produjo la derivación (así el motor recorre los
 * vecinos en el mismo orden que antes y desempata igual).
 */
export interface CompiledGraph {
  meta: CompiledMeta;

  nodeOsmId: Float64Array; // N, ascendente
  /** Solo si algún ID no es numérico (fixtures de tests): etiquetas por índice, en orden. */
  nodeLabels?: string[];
  nodeLat: Float64Array; // N
  nodeLon: Float64Array; // N
  /** 1 si el nodo está en la componente fuertemente conexa mayor (snap, D15). */
  nodeInMainScc: Uint8Array; // N

  /** Aristas salientes de u: outStart[u] .. outStart[u+1]-1. */
  outStart: Int32Array; // N+1
  edgeFrom: Int32Array; // M
  edgeTo: Int32Array; // M
  edgeLen: Float64Array; // M, metros (== haversine de los extremos)

  // Features del costo (ver cost.ts), precalculadas al compilar.
  edgeStraight: Float64Array; // M
  edgeRough: Float64Array; // M
  edgeGrade: Float64Array; // M
  edgeMinor: Float64Array; // M

  // Atributos para estadísticas de la ruta.
  edgeCurv: Float32Array; // M
  edgeGain: Float32Array; // M
  edgeLoss: Float32Array; // M
  edgeHighway: Uint8Array; // M, índice en HIGHWAY_CODES
  edgeSurface: Uint8Array; // M, índice en SURFACE_CODES
  edgeFlags: Uint8Array; // M, bits EDGE_FLAG_*
  edgeWay: Float64Array; // M, osmWayId (0 si no hay)

  /** Aristas entrantes de v: inEdge[inStart[v] .. inStart[v+1]-1] (índices de arista). */
  inStart: Int32Array; // N+1
  inEdge: Int32Array; // M
}

export interface CompiledMeta {
  source: string;
  dataVersion: number;
  compilerVersion: string;
  hasElevation: boolean;
  builtAt: string;
  nodeCount: number;
  edgeCount: number;
  sccCount: number;
  mainSccSize: number;
}

export const EDGE_FLAG_DESTINATION_ONLY = 1;

export const HIGHWAY_CODES: readonly HighwayType[] = [
  'motorway', 'trunk', 'primary', 'secondary', 'tertiary', 'unclassified',
  'residential', 'track', 'path', 'service', 'living_street',
];
export const SURFACE_CODES: readonly SurfaceType[] = [
  'asphalt', 'concrete', 'gravel', 'dirt', 'sand', 'cobblestone', 'unknown',
];
export const SMOOTHNESS_CODES: readonly SmoothnessType[] = [
  'excellent', 'good', 'intermediate', 'bad', 'very_bad', 'impassable',
];

const labelIndex = new WeakMap<CompiledGraph, Map<string, number>>();

/** Índice del nodo con ese osmId, o -1. Búsqueda binaria sobre nodeOsmId. */
export function nodeIndex(g: CompiledGraph, osmId: string | number): number {
  if (g.nodeLabels) {
    let m = labelIndex.get(g);
    if (!m) {
      m = new Map(g.nodeLabels.map((l, i) => [l, i]));
      labelIndex.set(g, m);
    }
    return m.get(String(osmId)) ?? -1;
  }
  const target = typeof osmId === 'number' ? osmId : Number(osmId);
  const ids = g.nodeOsmId;
  let lo = 0;
  let hi = ids.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const v = ids[mid];
    if (v === target) return mid;
    if (v < target) lo = mid + 1;
    else hi = mid - 1;
  }
  return -1;
}

export function nodeOsmIdString(g: CompiledGraph, i: number): string {
  return g.nodeLabels ? g.nodeLabels[i] : String(g.nodeOsmId[i]);
}

export function isDestinationOnlyEdge(g: CompiledGraph, e: number): boolean {
  return (g.edgeFlags[e] & EDGE_FLAG_DESTINATION_ONLY) !== 0;
}
