import { HighwayType, SmoothnessType, SurfaceType } from './types';

/**
 * Grafo compilado y COMPACTADO (desde F0.3): arrays tipados en CSR. Es lo
 * único que ve el motor. Lo produce `src/graph-compiler/compile.ts` y se
 * serializa tal cual en el snapshot (`snapshot.ts`).
 *
 * - Nodos: solo los de unión (grado ≠ 2, cambio de sentido o de acceso
 *   privado). Índices 0..N-1, ordenados por osmId (búsqueda binaria).
 * - Tramos (chains): secuencia de segmentos crudos entre dos nodos de unión
 *   (la unidad del RNF-SinRepetición). Cada tramo tiene su geometría.
 * - Aristas: una por tramo y sentido permitido. Llevan las SUMAS de las
 *   features del costo (largo × feature), así el costo de un tramo es exacto.
 * - Geometría: todos los puntos crudos de cada tramo, con sumas prefijas para
 *   cortar un tramo en cualquier punto (nodos fantasma del snap) de forma exacta.
 */
export interface CompiledGraph {
  meta: CompiledMeta;

  // ── Nodos de unión (N) ──
  /** osmId del nodo (o ID sustituto si hay `rawLabels`), ascendente. */
  nodeOsmId: Float64Array;
  /**
   * Solo si algún ID no es numérico (fixtures de tests): etiquetas de los nodos
   * crudos, ordenadas; nodeOsmId y geoOsmId guardan el índice en este arreglo.
   */
  rawLabels?: string[];
  nodeLat: Float64Array;
  nodeLon: Float64Array;
  /** 1 si el nodo está en la componente fuertemente conexa mayor (snap, D15). */
  nodeInMainScc: Uint8Array;
  /** Grado no dirigido: tramos incidentes (un tramo-lazo cuenta 2). */
  nodeDegree: Int32Array;

  // ── Aristas dirigidas (M), CSR por origen ──
  outStart: Int32Array; // N+1
  edgeFrom: Int32Array;
  edgeTo: Int32Array;
  /** Tramo (chain) de la arista; las dos aristas de un tramo comparten tramo (`tramoOf`). */
  edgeChain: Int32Array;
  /** 0 = recorre el tramo en su sentido de geometría (g0→gk); 1 = al revés. */
  edgeDir: Uint8Array;
  edgeLen: Float64Array; // metros (suma de segmentos)
  // Sumas Σ largo × feature sobre los segmentos del tramo (ver cost.ts).
  edgeSumStraight: Float64Array;
  edgeSumRough: Float64Array;
  edgeSumGrade: Float64Array;
  edgeSumMinor: Float64Array;
  edgeFlags: Uint8Array; // bits EDGE_FLAG_*
  /** Aristas entrantes de v: inEdge[inStart[v] .. inStart[v+1]-1]. */
  inStart: Int32Array; // N+1
  inEdge: Int32Array;

  // ── Tramos (T) ──
  /** Puntos de geometría del tramo t: chainStart[t] .. chainStart[t+1]-1 (≥ 2). */
  chainStart: Int32Array; // T+1
  /** Arista en sentido de geometría (g0→gk) o -1 si ese sentido no está permitido. */
  chainFwd: Int32Array;
  /** Arista en sentido contrario (gk→g0) o -1. */
  chainBwd: Int32Array;
  /** Nodo de unión en cada extremo del tramo. */
  chainNode0: Int32Array;
  chainNode1: Int32Array;
  /** 1 si el tramo es un puente del grafo no dirigido (excepción del acceso, D14). */
  chainIsBridge: Uint8Array;
  chainFlags: Uint8Array;

  // ── Geometría (P puntos; el segmento j va del punto j al j+1 del mismo tramo) ──
  geoOsmId: Float64Array;
  geoLat: Float64Array;
  geoLon: Float64Array;
  /** Sumas prefijas desde el inicio del tramo (0 en su primer punto). */
  geoCumLen: Float64Array;
  geoCumStraight: Float64Array;
  geoCumRough: Float64Array;
  geoCumGrade: Float64Array;
  geoCumMinor: Float64Array;
  // Atributos del segmento que empieza en cada punto (el último punto del tramo no se usa).
  /** Sinuosidad normalizada [0,1] del segmento. */
  segCurv: Float32Array;
  /** Densidad de giro del segmento (°/km). */
  segCurvDeg: Float32Array;
  /** Desnivel positivo/negativo en el sentido de la geometría. */
  segGain: Float32Array;
  segLoss: Float32Array;
  segHighway: Uint8Array;
  segSurface: Uint8Array;
  /** Procedencia de la superficie: índice en SURFACE_SOURCES (declarada, tracktype, vecindad, tipo); 255 = sin dato. */
  segSurfaceSource: Uint8Array;
  segWay: Float64Array;

  // ── Calzadas gemelas (D13), CSR por arista dirigida ──
  twinStart: Int32Array; // M+1
  twinEdge: Int32Array;
  /** Fracción del recorrido de la arista que corre junto a la gemela. */
  twinFrac: Float32Array;
}

export interface CompiledMeta {
  source: string;
  dataVersion: number;
  compilerVersion: string;
  hasElevation: boolean;
  builtAt: string;
  nodeCount: number;
  edgeCount: number;
  chainCount: number;
  geoCount: number;
  /** Nodos crudos de los que se partió (antes de compactar). */
  rawNodeCount: number;
  sccCount: number;
  mainSccSize: number;
  /** Tramos públicos marcados como privados por estar encerrados en un área privada (D16). */
  enclaveChains: number;
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

/** osmId → número comparable con nodeOsmId/geoOsmId (NaN si no existe). */
function numericId(g: CompiledGraph, osmId: string | number): number {
  if (!g.rawLabels) return typeof osmId === 'number' ? osmId : Number(osmId);
  let m = labelIndex.get(g);
  if (!m) {
    m = new Map(g.rawLabels.map((l, i) => [l, i]));
    labelIndex.set(g, m);
  }
  return m.get(String(osmId)) ?? NaN;
}

function idString(g: CompiledGraph, v: number): string {
  return g.rawLabels ? g.rawLabels[v] : String(v);
}

function binarySearch(ids: Float64Array, target: number): number {
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

/** Índice del nodo de unión con ese osmId, o -1. */
export function nodeIndex(g: CompiledGraph, osmId: string | number): number {
  const t = numericId(g, osmId);
  return Number.isNaN(t) ? -1 : binarySearch(g.nodeOsmId, t);
}

export function nodeOsmIdString(g: CompiledGraph, i: number): string {
  return idString(g, g.nodeOsmId[i]);
}

/** osmId de un punto de geometría. */
export function geoOsmIdString(g: CompiledGraph, p: number): string {
  return idString(g, g.geoOsmId[p]);
}

export function isDestinationOnlyEdge(g: CompiledGraph, e: number): boolean {
  return (g.edgeFlags[e] & EDGE_FLAG_DESTINATION_ONLY) !== 0;
}

/** Tramo al que pertenece un punto de geometría (búsqueda binaria en chainStart). */
export function chainOfPoint(g: CompiledGraph, p: number): number {
  let lo = 0;
  let hi = g.meta.chainCount - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (g.chainStart[mid] <= p) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

/** Puntos de geometría ordenados por osmId (para ubicar un nodo crudo); se calcula una vez. */
const pointsSorted = new WeakMap<CompiledGraph, Int32Array>();
function pointsByOsmId(g: CompiledGraph): Int32Array {
  let s = pointsSorted.get(g);
  if (!s) {
    s = Int32Array.from({ length: g.meta.geoCount }, (_, i) => i);
    s.sort((a, b) => g.geoOsmId[a] - g.geoOsmId[b] || a - b);
    pointsSorted.set(g, s);
  }
  return s;
}

/** Un punto de geometría (el primero) con ese osmId crudo, o -1. */
export function pointOfRawNode(g: CompiledGraph, osmId: string | number): number {
  const target = numericId(g, osmId);
  if (Number.isNaN(target)) return -1;
  const order = pointsByOsmId(g);
  let lo = 0;
  let hi = order.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const v = g.geoOsmId[order[mid]];
    if (v === target) {
      let k = mid;
      while (k > 0 && g.geoOsmId[order[k - 1]] === target) k--;
      return order[k];
    }
    if (v < target) lo = mid + 1;
    else hi = mid - 1;
  }
  return -1;
}
