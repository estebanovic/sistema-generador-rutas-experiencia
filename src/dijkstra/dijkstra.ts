import { RouteResult } from './types';
import { RouteWeights, costFromFeatures } from './cost';
import {
  CompiledGraph,
  EDGE_FLAG_DESTINATION_ONLY,
  HIGHWAY_CODES,
  SURFACE_CODES,
  nodeOsmIdString,
} from './compiled-graph';

/** Resultado del motor: lo que ve la API más los índices internos del camino. */
export interface EngineRoute extends RouteResult {
  /** Índices de nodo del camino (origen → destino). */
  nodeIdx: number[];
  /** Índices de las aristas recorridas, exactamente las relajadas (nodeIdx.length - 1). */
  edgeIdx: number[];
}

export interface DijkstraOptions {
  // Nodos a "desincentivar" (multiplican el costo de entrar en ellos). Sirve
  // para que un tramo evite calles ya usadas y no se devuelva por el mismo lado.
  avoidNodes?: Set<number>;
  avoidPenalty?: number;
}

// ── Heap binario (mismo algoritmo y desempates que el motor anterior) ──

class MinHeap {
  private keys: number[] = [];
  private vals: number[] = [];

  get size(): number {
    return this.keys.length;
  }

  push(val: number, key: number): void {
    const K = this.keys;
    const V = this.vals;
    K.push(key);
    V.push(val);
    let i = K.length - 1;
    while (i > 0) {
      const parent = Math.floor((i - 1) / 2);
      if (K[parent] <= K[i]) break;
      // Intercambio con temporales (sin crear arreglos): mismo orden que antes.
      const tk = K[parent];
      K[parent] = K[i];
      K[i] = tk;
      const tv = V[parent];
      V[parent] = V[i];
      V[i] = tv;
      i = parent;
    }
  }

  /** Devuelve el valor de menor clave (-1 si está vacío). */
  pop(): number {
    const K = this.keys;
    const V = this.vals;
    if (K.length === 0) return -1;
    const top = V[0];
    const lastK = K.pop()!;
    const lastV = V.pop()!;
    if (K.length > 0) {
      K[0] = lastK;
      V[0] = lastV;
      const n = K.length;
      let i = 0;
      while (true) {
        let min = i;
        const l = 2 * i + 1;
        const r = 2 * i + 2;
        if (l < n && K[l] < K[min]) min = l;
        if (r < n && K[r] < K[min]) min = r;
        if (min === i) break;
        const tk = K[min];
        K[min] = K[i];
        K[i] = tk;
        const tv = V[min];
        V[min] = V[i];
        V[i] = tv;
        i = min;
      }
    }
    return top;
  }
}

// ── Estado por consulta reutilizable (sellos de época, sin limpiar arrays) ──

interface Workspace {
  stamp: number;
  dist: Float64Array;
  distStamp: Uint32Array;
  visitedStamp: Uint32Array;
  prevEdge: Int32Array;
}
const workspaces = new WeakMap<CompiledGraph, Workspace>();

function workspace(g: CompiledGraph): Workspace {
  let ws = workspaces.get(g);
  if (!ws) {
    const N = g.meta.nodeCount;
    ws = {
      stamp: 0,
      dist: new Float64Array(N),
      distStamp: new Uint32Array(N),
      visitedStamp: new Uint32Array(N),
      prevEdge: new Int32Array(N),
    };
    workspaces.set(g, ws);
  }
  ws.stamp++;
  return ws;
}

// ── Vías privadas (solo origen/destino, decisión D7) ──

function isPrivate(g: CompiledGraph, e: number): boolean {
  return (g.edgeFlags[e] & EDGE_FLAG_DESTINATION_ONLY) !== 0;
}

/** Nodo dentro de un área privada: todas sus aristas salientes son privadas. */
function insidePrivate(g: CompiledGraph, u: number): boolean {
  const a = g.outStart[u];
  const b = g.outStart[u + 1];
  if (a === b) return false;
  for (let e = a; e < b; e++) if (!isPrivate(g, e)) return false;
  return true;
}

const hasPrivateCache = new WeakMap<CompiledGraph, boolean>();
function hasPrivate(g: CompiledGraph): boolean {
  let v = hasPrivateCache.get(g);
  if (v === undefined) {
    v = g.edgeFlags.some((f) => (f & EDGE_FLAG_DESTINATION_ONLY) !== 0);
    hasPrivateCache.set(g, v);
  }
  return v;
}

/**
 * Qué aristas privadas puede usar esta consulta. Se recorre el área privada
 * del origen (y la del destino) solo por nodos INTERIORES —todas sus aristas
 * salientes privadas—; el recorrido se detiene en el portón (nodo que también
 * toca una vía pública). Una arista privada u→v es usable si u es interior del
 * área del origen (tramo inicial, incluida la salida al portón) o si v es
 * interior del área del destino (tramo final, incluida la entrada desde el
 * portón). Partir de una calle pública junto a un portón no habilita nada, y
 * dos áreas privadas que comparten un portón no se encadenan: una vía privada
 * nunca se usa como atajo de paso.
 */
function privateAllowance(g: CompiledGraph, starts: number[], ends: Set<number>) {
  if (!hasPrivate(g)) return null;
  const fromOrigin = new Set<number>();
  const queue = starts.filter((s) => insidePrivate(g, s));
  for (const s of queue) fromOrigin.add(s);
  while (queue.length) {
    const u = queue.pop()!;
    for (let e = g.outStart[u]; e < g.outStart[u + 1]; e++) {
      const v = g.edgeTo[e];
      if (isPrivate(g, e) && !fromOrigin.has(v) && insidePrivate(g, v)) {
        fromOrigin.add(v);
        queue.push(v);
      }
    }
  }
  const toDest = new Set<number>();
  const back = [...ends].filter((t) => insidePrivate(g, t));
  for (const t of back) toDest.add(t);
  while (back.length) {
    const v = back.pop()!;
    for (let p = g.inStart[v]; p < g.inStart[v + 1]; p++) {
      const e = g.inEdge[p];
      if (!isPrivate(g, e)) continue;
      const u = g.edgeFrom[e];
      if (!toDest.has(u) && insidePrivate(g, u)) {
        toDest.add(u);
        back.push(u);
      }
    }
  }
  return { fromOrigin, toDest };
}

// ── Dijkstra ──

export function dijkstra(
  g: CompiledGraph,
  start: number,
  end: number,
  weights: RouteWeights,
  options?: DijkstraOptions,
): EngineRoute | null {
  return dijkstraCore(g, [start], [end], weights, options);
}

/**
 * Variante multi-candidato: prueba varios nodos de inicio y de fin a la vez y
 * devuelve la mejor ruta (la de menor costo). Sirve para el "snap": en vez de
 * forzar el único nodo más cercano (que en autopistas divididas cae en la
 * calzada equivocada y obliga a rodeos absurdos), elige la combinación de nodos
 * cercanos que mejor conecta.
 */
export function dijkstraMultiSource(
  g: CompiledGraph,
  starts: number[],
  ends: number[],
  weights: RouteWeights,
  options?: DijkstraOptions,
): EngineRoute | null {
  return dijkstraCore(g, starts, ends, weights, options);
}

function dijkstraCore(
  g: CompiledGraph,
  startIdx: number[],
  endIdx: number[],
  weights: RouteWeights,
  options?: DijkstraOptions,
): EngineRoute | null {
  const N = g.meta.nodeCount;
  const valid = (i: number) => Number.isInteger(i) && i >= 0 && i < N;
  const starts = startIdx.filter(valid);
  const endSet = new Set(endIdx.filter(valid));
  if (starts.length === 0 || endSet.size === 0) return null;

  const avoidNodes = options?.avoidNodes;
  const avoidPenalty = options?.avoidPenalty ?? 6;
  const priv = privateAllowance(g, starts, endSet);

  const ws = workspace(g);
  const { stamp, dist, distStamp, visitedStamp, prevEdge } = ws;
  const heap = new MinHeap();
  const { outStart, edgeTo, edgeLen, edgeStraight, edgeRough, edgeGrade, edgeMinor, edgeFlags } = g;
  const fromOrigin = priv?.fromOrigin;
  const toDest = priv?.toDest;

  for (const s of starts) {
    dist[s] = 0;
    distStamp[s] = stamp;
    prevEdge[s] = -1;
    heap.push(s, 0);
  }

  // Dijkstra asienta los nodos en orden de costo creciente, así que el primer
  // destino candidato que se extrae es el de menor costo (la mejor combinación).
  let reachedEnd = -1;
  while (heap.size > 0) {
    const u = heap.pop();
    if (visitedStamp[u] === stamp) continue;
    visitedStamp[u] = stamp;
    if (endSet.has(u)) {
      reachedEnd = u;
      break;
    }

    const distU = distStamp[u] === stamp ? dist[u] : Infinity;
    for (let e = outStart[u]; e < outStart[u + 1]; e++) {
      const v = edgeTo[e];
      if (visitedStamp[v] === stamp) continue;
      if (
        (edgeFlags[e] & EDGE_FLAG_DESTINATION_ONLY) !== 0 &&
        !(fromOrigin && (fromOrigin.has(u) || toDest!.has(v)))
      ) {
        continue; // vía privada fuera del tramo inicial/final: no se usa de paso
      }
      let edgeCost = costFromFeatures(edgeLen[e], edgeStraight[e], edgeRough[e], edgeGrade[e], edgeMinor[e], weights);
      if (avoidNodes && avoidNodes.has(v)) edgeCost *= avoidPenalty;
      const cost = distU + edgeCost;
      if (cost < (distStamp[v] === stamp ? dist[v] : Infinity)) {
        dist[v] = cost;
        distStamp[v] = stamp;
        prevEdge[v] = e;
        heap.push(v, cost);
      }
    }
  }

  if (reachedEnd < 0) return null;

  // Reconstruir el camino por las aristas efectivamente relajadas.
  const edges: number[] = [];
  let cur = reachedEnd;
  while (prevEdge[cur] >= 0) {
    const e = prevEdge[cur];
    edges.push(e);
    cur = g.edgeFrom[e];
  }
  edges.reverse();
  const nodes = [cur, ...edges.map((e) => edgeTo[e])];
  return buildRouteResult(g, nodes, edges, dist[reachedEnd]);
}

/** Construye el resultado (coordenadas + estadísticas) a partir de las aristas recorridas. */
export function buildRouteResult(
  g: CompiledGraph,
  nodes: number[],
  edges: number[],
  totalCost: number,
): EngineRoute {
  let distanceMeters = 0;
  let elevationGain = 0;
  let elevationLoss = 0;
  let curvinessMeters = 0;
  const highwayBreakdown: Record<string, number> = {};
  const surfaceBreakdown: Record<string, number> = {};

  for (const e of edges) {
    const len = g.edgeLen[e];
    distanceMeters += len;
    elevationGain += g.edgeGain[e];
    elevationLoss += g.edgeLoss[e];
    curvinessMeters += g.edgeCurv[e] * len;
    const hw = HIGHWAY_CODES[g.edgeHighway[e]];
    const sf = SURFACE_CODES[g.edgeSurface[e]];
    highwayBreakdown[hw] = (highwayBreakdown[hw] ?? 0) + len;
    surfaceBreakdown[sf] = (surfaceBreakdown[sf] ?? 0) + len;
  }

  return {
    path: nodes.map((i) => nodeOsmIdString(g, i)),
    coordinates: nodes.map((i) => [g.nodeLat[i], g.nodeLon[i]] as [number, number]),
    totalCost,
    stats: {
      distanceMeters,
      elevationGainMeters: elevationGain,
      elevationLossMeters: elevationLoss,
      // Ponderada por largo (antes era un promedio simple por arista).
      curviness: distanceMeters > 0 ? curvinessMeters / distanceMeters : 0,
      highwayBreakdown,
      surfaceBreakdown,
    },
    nodeIdx: nodes,
    edgeIdx: edges,
  };
}
