import { Graph, GraphEdge, RouteResult } from './types';
import { RouteWeights, calculateEdgeCost } from './cost';

interface HeapItem {
  id: string;
  cost: number;
}

class MinHeap {
  private heap: HeapItem[] = [];

  push(item: HeapItem): void {
    this.heap.push(item);
    this.bubbleUp(this.heap.length - 1);
  }

  pop(): HeapItem | undefined {
    if (this.heap.length === 0) return undefined;
    const top = this.heap[0];
    const last = this.heap.pop()!;
    if (this.heap.length > 0) {
      this.heap[0] = last;
      this.sinkDown(0);
    }
    return top;
  }

  get size(): number {
    return this.heap.length;
  }

  private bubbleUp(i: number): void {
    while (i > 0) {
      const parent = Math.floor((i - 1) / 2);
      if (this.heap[parent].cost <= this.heap[i].cost) break;
      [this.heap[parent], this.heap[i]] = [this.heap[i], this.heap[parent]];
      i = parent;
    }
  }

  private sinkDown(i: number): void {
    const n = this.heap.length;
    while (true) {
      let min = i;
      const l = 2 * i + 1;
      const r = 2 * i + 2;
      if (l < n && this.heap[l].cost < this.heap[min].cost) min = l;
      if (r < n && this.heap[r].cost < this.heap[min].cost) min = r;
      if (min === i) break;
      [this.heap[min], this.heap[i]] = [this.heap[i], this.heap[min]];
      i = min;
    }
  }
}

// ── Vías privadas (solo origen/destino) ─────────────────────

/** Aristas privadas entrantes por nodo; se calcula una vez por grafo. null = no hay privadas. */
const privateIncoming = new WeakMap<Graph, Map<string, GraphEdge[]> | null>();

function incomingPrivate(graph: Graph): Map<string, GraphEdge[]> | null {
  if (privateIncoming.has(graph)) return privateIncoming.get(graph)!;
  let map: Map<string, GraphEdge[]> | null = null;
  for (const list of graph.adjacency.values()) {
    for (const e of list) {
      if (!e.destinationOnly) continue;
      map ??= new Map();
      const l = map.get(e.toOsmId);
      if (l) l.push(e);
      else map.set(e.toOsmId, [e]);
    }
  }
  privateIncoming.set(graph, map);
  return map;
}

/** Nodo dentro de un área privada: todas sus aristas salientes son privadas. */
function insidePrivate(graph: Graph, id: string): boolean {
  const out = graph.adjacency.get(id) ?? [];
  return out.length > 0 && out.every((e) => e.destinationOnly);
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
function privateAllowance(graph: Graph, starts: string[], ends: Set<string>) {
  const incoming = incomingPrivate(graph);
  if (!incoming) return null;
  const fromOrigin = new Set<string>();
  const queue = starts.filter((s) => insidePrivate(graph, s));
  for (const s of queue) fromOrigin.add(s);
  while (queue.length) {
    const u = queue.pop()!;
    for (const e of graph.adjacency.get(u) ?? []) {
      const v = e.toOsmId;
      if (e.destinationOnly && !fromOrigin.has(v) && insidePrivate(graph, v)) {
        fromOrigin.add(v);
        queue.push(v);
      }
    }
  }
  const toDest = new Set<string>();
  const back = [...ends].filter((t) => insidePrivate(graph, t));
  for (const t of back) toDest.add(t);
  while (back.length) {
    const v = back.pop()!;
    for (const e of incoming.get(v) ?? []) {
      const u = e.fromOsmId;
      if (!toDest.has(u) && insidePrivate(graph, u)) {
        toDest.add(u);
        back.push(u);
      }
    }
  }
  return { fromOrigin, toDest };
}

export interface DijkstraOptions {
  // Nodos a "desincentivar" (multiplican el costo de entrar en ellos). Sirve
  // para que un tramo evite calles ya usadas y no se devuelva por el mismo lado.
  avoidNodes?: Set<string>;
  avoidPenalty?: number;
}

export function dijkstra(
  graph: Graph,
  startId: string,
  endId: string,
  weights: RouteWeights,
  options?: DijkstraOptions,
): RouteResult | null {
  return dijkstraCore(graph, [startId], [endId], weights, options);
}

/**
 * Variante multi-candidato: prueba varios nodos de inicio y de fin a la vez y
 * devuelve la mejor ruta (la de menor costo). Sirve para el "snap": en vez de
 * forzar el único nodo más cercano (que en autopistas divididas cae en la
 * calzada equivocada y obliga a rodeos absurdos), elige la combinación de nodos
 * cercanos que mejor conecta.
 */
export function dijkstraMultiSource(
  graph: Graph,
  startIds: string[],
  endIds: string[],
  weights: RouteWeights,
  options?: DijkstraOptions,
): RouteResult | null {
  return dijkstraCore(graph, startIds, endIds, weights, options);
}

function dijkstraCore(
  graph: Graph,
  startIds: string[],
  endIds: string[],
  weights: RouteWeights,
  options?: DijkstraOptions,
): RouteResult | null {
  const starts = startIds.filter((id) => graph.nodes.has(id));
  const startSet = new Set(starts);
  const endSet = new Set(endIds.filter((id) => graph.nodes.has(id)));
  if (starts.length === 0 || endSet.size === 0) return null;

  const avoidNodes = options?.avoidNodes;
  const avoidPenalty = options?.avoidPenalty ?? 6;
  const priv = privateAllowance(graph, starts, endSet);

  const dist = new Map<string, number>();
  const prev = new Map<string, string>();
  const visited = new Set<string>();
  const heap = new MinHeap();

  for (const s of starts) {
    dist.set(s, 0);
    heap.push({ id: s, cost: 0 });
  }

  // Dijkstra asienta los nodos en orden de costo creciente, así que el primer
  // destino candidato que se extrae es el de menor costo (la mejor combinación).
  let reachedEnd: string | undefined;
  while (heap.size > 0) {
    const current = heap.pop();
    if (!current) break;
    const { id } = current;
    if (visited.has(id)) continue;
    visited.add(id);
    if (endSet.has(id)) {
      reachedEnd = id;
      break;
    }

    const distId = dist.get(id) ?? Infinity;
    for (const edge of graph.adjacency.get(id) ?? []) {
      if (visited.has(edge.toOsmId)) continue;
      if (
        edge.destinationOnly &&
        !(priv && (priv.fromOrigin.has(id) || priv.toDest.has(edge.toOsmId)))
      ) {
        continue; // vía privada fuera del tramo inicial/final: no se usa de paso
      }
      let edgeCost = calculateEdgeCost(edge, weights);
      if (avoidNodes && avoidNodes.has(edge.toOsmId)) edgeCost *= avoidPenalty;
      const cost = distId + edgeCost;
      if (cost < (dist.get(edge.toOsmId) ?? Infinity)) {
        dist.set(edge.toOsmId, cost);
        prev.set(edge.toOsmId, id);
        heap.push({ id: edge.toOsmId, cost });
      }
    }
  }

  if (reachedEnd === undefined) return null;

  // Reconstruir path desde el destino alcanzado hasta su nodo de inicio.
  const path: string[] = [];
  let cur: string | undefined = reachedEnd;
  while (cur !== undefined) {
    path.unshift(cur);
    if (startSet.has(cur)) break;
    cur = prev.get(cur);
  }
  if (!startSet.has(path[0])) return null;

  return buildRouteResult(graph, path, dist.get(reachedEnd) ?? 0);
}

/** Construye el RouteResult (coordenadas + stats) a partir de un path de osmIds. */
function buildRouteResult(
  graph: Graph,
  path: string[],
  totalCost: number,
): RouteResult {
  let distanceMeters = 0;
  let elevationGain = 0;
  let elevationLoss = 0;
  let curvinessSum = 0;
  let edgeCount = 0;
  const highwayBreakdown: Record<string, number> = {};
  const surfaceBreakdown: Record<string, number> = {};

  for (let i = 0; i < path.length - 1; i++) {
    const edges = graph.adjacency.get(path[i]) ?? [];
    // Si hay aristas paralelas, elegimos la más barata hacia el siguiente nodo.
    let chosen: GraphEdge | undefined;
    for (const e of edges) {
      if (e.toOsmId !== path[i + 1]) continue;
      if (!chosen || e.distanceMeters < chosen.distanceMeters) chosen = e;
    }
    if (chosen) {
      distanceMeters += chosen.distanceMeters;
      elevationGain += chosen.elevationGain;
      elevationLoss += chosen.elevationLoss;
      curvinessSum += chosen.curviness;
      edgeCount++;
      highwayBreakdown[chosen.highwayType] =
        (highwayBreakdown[chosen.highwayType] ?? 0) + chosen.distanceMeters;
      surfaceBreakdown[chosen.surface] =
        (surfaceBreakdown[chosen.surface] ?? 0) + chosen.distanceMeters;
    }
  }

  const coordinates: [number, number][] = path.map((id) => {
    const n = graph.nodes.get(id)!;
    return [n.lat, n.lon];
  });

  return {
    path,
    coordinates,
    totalCost,
    stats: {
      distanceMeters,
      elevationGainMeters: elevationGain,
      elevationLossMeters: elevationLoss,
      curviness: edgeCount > 0 ? curvinessSum / edgeCount : 0,
      highwayBreakdown,
      surfaceBreakdown,
    },
  };
}
