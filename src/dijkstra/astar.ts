import { RouteWeights } from './cost';
import { CompiledGraph } from './compiled-graph';
import { DijkstraOptions, Endpoint, EngineRoute, Heuristic, NodeFilter, searchMultiSource } from './dijkstra';
import { EARTH_RADIUS_M, unitVector } from '../graph-compiler/geo';

/**
 * A* unidireccional (F3) sobre la misma búsqueda que Dijkstra, con la
 * heurística h(v) = s · máx(0, cuerda(v, c) − r), donde c es el centro de los
 * puntos de destino q y r el radio que los contiene. Por la desigualdad
 * triangular es ≤ s · min_q cuerda(v, q), con una sola distancia por nodo
 * (los candidatos del snap están a menos de 1 km entre sí, así que r es chico).
 *
 * - **Admisible:** el costo nunca es menor que el largo (costo ≥ L, F2) y el
 *   largo de cualquier camino es ≥ la suma de las cuerdas de sus segmentos
 *   × s, que por la desigualdad triangular es ≥ s · cuerda(v, q). `s` es el
 *   mínimo de largo / cuerda por segmento que mide el compilador
 *   (`meta.minLenOverChord`); con datos de OSM es 1.
 * - **Consistente:** para una arista u→v, h(u) ≤ s·cuerda(u, v) + h(v) ≤
 *   costo(u→v) + h(v) (el máx con 0 lo conserva); por eso basta cerrar cada
 *   nodo una vez.
 * - **Destinos a mitad de tramo (nodos fantasma):** q son los dos extremos
 *   reales del segmento donde cae el destino, no el punto interpolado. Todo
 *   camino al fantasma pasa por uno de ellos, y así la cota no depende de la
 *   interpolación lineal de la latitud y la longitud.
 * - La cuerda es ≤ la haversine y se calcula con vectores unitarios
 *   precalculados, sin trigonometría por relajación (menos un margen de 1 µm
 *   por la cancelación numérica en distancias de centímetros).
 */

/** Margen relativo contra el redondeo de punto flotante (la cota sigue siendo inferior). */
const SLACK = 1 - 1e-9;
/**
 * Margen absoluto (1 µm): la cuerda por diferencia de vectores unitarios tiene
 * un error de ~1e-9 m por cancelación, que pesa cerca del destino.
 */
const ABS_SLACK_M = 1e-6;

interface Geometry {
  /** Vectores unitarios de los nodos de unión: x, y, z intercalados. */
  node: Float64Array;
  /** Factor s ≤ 1 que hace admisible la cuerda (ver arriba). */
  scale: number;
}
const geometries = new WeakMap<CompiledGraph, Geometry>();

function geometry(g: CompiledGraph): Geometry {
  let geo = geometries.get(g);
  if (!geo) {
    const N = g.meta.nodeCount;
    const node = new Float64Array(3 * N);
    for (let i = 0; i < N; i++) {
      const [x, y, z] = unitVector(g.nodeLat[i], g.nodeLon[i]);
      node[3 * i] = x;
      node[3 * i + 1] = y;
      node[3 * i + 2] = z;
    }
    const s = g.meta.minLenOverChord ?? 1;
    geo = { node, scale: Math.max(0, Math.min(1, s)) * SLACK };
    geometries.set(g, geo);
  }
  return geo;
}

/** Puntos reales (lat, lon) que acotan cada extremo: el nodo, o los dos extremos del segmento del fantasma. */
function endpointPoints(g: CompiledGraph, eps: Endpoint[]): [number, number][] {
  const pts: [number, number][] = [];
  for (const d of eps) {
    if ('node' in d) pts.push([g.nodeLat[d.node], g.nodeLon[d.node]]);
    else {
      pts.push([g.geoLat[d.point], g.geoLon[d.point]]);
      pts.push([g.geoLat[d.point + 1], g.geoLon[d.point + 1]]);
    }
  }
  return pts;
}

/**
 * Cota inferior del largo desde un nodo hasta el más cercano de estos
 * extremos (en cualquier sentido): s · máx(0, cuerda(v, c) − r), con c el
 * centro (en R³, no necesariamente sobre la esfera) y r el radio de sus puntos
 * reales. `null` si no hay extremos.
 */
function lengthBound(g: CompiledGraph, eps: Endpoint[]): ((v: number) => number) | null {
  const { node, scale } = geometry(g);
  const q = endpointPoints(g, eps).map(([la, lo]) => unitVector(la, lo));
  if (q.length === 0) return null;
  let cx = 0;
  let cy = 0;
  let cz = 0;
  for (const [x, y, z] of q) {
    cx += x / q.length;
    cy += y / q.length;
    cz += z / q.length;
  }
  let r = 0;
  for (const [x, y, z] of q) r = Math.max(r, Math.sqrt((x - cx) ** 2 + (y - cy) ** 2 + (z - cz) ** 2));
  const k = scale * EARTH_RADIUS_M;
  const offset = k * r + ABS_SLACK_M;
  return (v: number) => {
    const d = Math.sqrt((node[3 * v] - cx) ** 2 + (node[3 * v + 1] - cy) ** 2 + (node[3 * v + 2] - cz) ** 2);
    const h = k * d - offset;
    return h > 0 ? h : 0;
  };
}

/**
 * Heurística de A* para estos destinos. `factor` es el costo mínimo por metro
 * de la búsqueda: 1 para el costo del perfil (costo ≥ L) y para el largo puro,
 * 1 + λ para LARAC (costo + λ·L ≥ (1 + λ)·L, F4).
 */
export function chordHeuristic(g: CompiledGraph, dests: Endpoint[], factor = 1): Heuristic {
  const bound = lengthBound(g, dests);
  if (!bound) return () => 0;
  return factor === 1 ? bound : (v: number) => factor * bound(v);
}

/**
 * Poda elíptica exacta (F4): un nodo v solo puede estar en una ruta de largo
 * ≤ maxLen si cota(origen → v) + cota(v → destino) ≤ maxLen. Las cotas son las
 * de la heurística (cuerda escalada por el invariante L ≥ s·cuerda del
 * compilador), así que nunca se descarta un nodo de una ruta factible.
 */
export function ellipseFilter(g: CompiledGraph, origins: Endpoint[], dests: Endpoint[], maxLen: number): NodeFilter {
  const fromO = lengthBound(g, origins);
  const toD = lengthBound(g, dests);
  if (!fromO || !toD) return () => true;
  return (v: number) => fromO(v) + toD(v) <= maxLen;
}

/** A* multi-candidato: misma firma y mismo resultado (costo) que `dijkstraMultiSource`. */
export function astarMultiSource(
  g: CompiledGraph,
  origins: Endpoint[],
  dests: Endpoint[],
  weights: RouteWeights,
  options?: DijkstraOptions,
  filter: NodeFilter | null = null,
): EngineRoute | null {
  const factor = options?.lengthOnly ? 1 : 1 + (options?.lambda ?? 0);
  return searchMultiSource(g, origins, dests, weights, options, chordHeuristic(g, dests, factor), filter);
}

export function astar(
  g: CompiledGraph,
  start: Endpoint,
  end: Endpoint,
  weights: RouteWeights,
  options?: DijkstraOptions,
): EngineRoute | null {
  return astarMultiSource(g, [start], [end], weights, options);
}
