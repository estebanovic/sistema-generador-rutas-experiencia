import { RouteResult } from './types';
import { RouteWeights, costFromSums } from './cost';
import {
  CompiledGraph,
  EDGE_FLAG_DESTINATION_ONLY,
  HIGHWAY_CODES,
  SURFACE_CODES,
  chainOfPoint,
  geoOsmIdString,
  nodeIndex,
  pointOfRawNode,
} from './compiled-graph';

/**
 * Posición sobre un tramo: segmento `point → point+1` (índices de geometría
 * del tramo `chain`) y fracción `t` ∈ [0,1] a lo largo de ese segmento. Es el
 * "nodo fantasma" del snap: se puede partir/llegar a mitad de un tramo.
 */
export interface Position {
  chain: number;
  point: number;
  t: number;
}

/** Extremo de una ruta: un nodo de unión o una posición sobre un tramo. */
export type Endpoint = { node: number } | Position;

/** Uso de un tramo por una ruta, en metros desde el inicio de su geometría (RNF-SinRepetición). */
export interface TramoUse {
  chain: number;
  s0: number;
  s1: number;
  /** 1 = en el sentido de la geometría, -1 = al revés. */
  dir: 1 | -1;
}

/** Resultado del motor: lo que ve la API más los datos internos del camino. */
export interface EngineRoute extends RouteResult {
  /** Nodos de unión recorridos (vacío si la ruta no sale del tramo de origen). */
  nodeIdx: number[];
  /** Aristas compactas recorridas completas (sin los pedazos de los extremos). */
  edgeIdx: number[];
  /** Tramos usados, con los pedazos parciales de los extremos. */
  tramos: TramoUse[];
  /** Origen y destino elegidos entre los candidatos. */
  origin?: Endpoint;
  dest?: Endpoint;
}

export interface DijkstraOptions {
  // Nodos (de unión) a "desincentivar": multiplican el costo de entrar en ellos.
  // Sirve para que un tramo evite calles ya usadas y no se devuelva por el mismo lado.
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

  topKey(): number {
    return this.keys[0];
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

// ── Sumas a lo largo de un tramo ──

interface Sums {
  len: number;
  st: number;
  ro: number;
  gr: number;
  mi: number;
}

const chainLast = (g: CompiledGraph, c: number) => g.chainStart[c + 1] - 1;
const startPos = (g: CompiledGraph, c: number): Position => ({ chain: c, point: g.chainStart[c], t: 0 });
const endPos = (g: CompiledGraph, c: number): Position => ({ chain: c, point: chainLast(g, c) - 1, t: 1 });
const isAtStart = (g: CompiledGraph, p: Position) => p.point === g.chainStart[p.chain] && p.t === 0;
const isAtEnd = (g: CompiledGraph, p: Position) => p.point === chainLast(g, p.chain) - 1 && p.t === 1;

function interp(arr: Float64Array, p: Position): number {
  if (p.t === 0) return arr[p.point];
  if (p.t === 1) return arr[p.point + 1];
  return arr[p.point] + p.t * (arr[p.point + 1] - arr[p.point]);
}

/** Sumas desde el inicio del tramo hasta la posición (lineales dentro de cada segmento). */
function sumsAt(g: CompiledGraph, p: Position): Sums {
  return {
    len: interp(g.geoCumLen, p),
    st: interp(g.geoCumStraight, p),
    ro: interp(g.geoCumRough, p),
    gr: interp(g.geoCumGrade, p),
    mi: interp(g.geoCumMinor, p),
  };
}

const minus = (a: Sums, b: Sums): Sums => ({ len: a.len - b.len, st: a.st - b.st, ro: a.ro - b.ro, gr: a.gr - b.gr, mi: a.mi - b.mi });
const costOf = (s: Sums, w: RouteWeights) => costFromSums(s.len, s.st, s.ro, s.gr, s.mi, w);

// ── Vías privadas (solo origen/destino, decisión D7) ──

/** Nodo dentro de un área privada: todas sus aristas salientes son privadas. */
function insidePrivate(g: CompiledGraph, u: number): boolean {
  const a = g.outStart[u];
  const b = g.outStart[u + 1];
  if (a === b) return false;
  for (let e = a; e < b; e++) if ((g.edgeFlags[e] & EDGE_FLAG_DESTINATION_ONLY) === 0) return false;
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
 * área del origen o si v es interior del área del destino. Los pedazos del
 * tramo donde está el origen/destino (nodo fantasma) siempre se pueden usar.
 * Partir de una calle pública junto a un portón no habilita nada, y dos áreas
 * privadas que comparten un portón no se encadenan.
 */
function privateAllowance(g: CompiledGraph, originNodes: number[], targetNodes: number[]) {
  if (!hasPrivate(g)) return null;
  const fromOrigin = new Set<number>();
  const queue = originNodes.filter((s) => insidePrivate(g, s));
  for (const s of queue) fromOrigin.add(s);
  while (queue.length) {
    const u = queue.pop()!;
    for (let e = g.outStart[u]; e < g.outStart[u + 1]; e++) {
      const v = g.edgeTo[e];
      if ((g.edgeFlags[e] & EDGE_FLAG_DESTINATION_ONLY) !== 0 && !fromOrigin.has(v) && insidePrivate(g, v)) {
        fromOrigin.add(v);
        queue.push(v);
      }
    }
  }
  const toDest = new Set<number>();
  const back = targetNodes.filter((t) => insidePrivate(g, t));
  for (const t of back) toDest.add(t);
  while (back.length) {
    const v = back.pop()!;
    for (let p = g.inStart[v]; p < g.inStart[v + 1]; p++) {
      const e = g.inEdge[p];
      if ((g.edgeFlags[e] & EDGE_FLAG_DESTINATION_ONLY) === 0) continue;
      const u = g.edgeFrom[e];
      if (!toDest.has(u) && insidePrivate(g, u)) {
        toDest.add(u);
        back.push(u);
      }
    }
  }
  return { fromOrigin, toDest };
}

// ── Extremos ──

/** Normaliza: una posición justo en el extremo de su tramo es ese nodo de unión. */
function asNode(g: CompiledGraph, ep: Endpoint): number | null {
  if ('node' in ep) return ep.node;
  if (isAtStart(g, ep)) return g.chainNode0[ep.chain];
  if (isAtEnd(g, ep)) return g.chainNode1[ep.chain];
  return null;
}

/** Extremo para un nodo crudo de OSM: su nodo de unión, o su posición dentro de un tramo. */
export function endpointOfRawNode(g: CompiledGraph, osmId: string | number): Endpoint | null {
  const n = nodeIndex(g, osmId);
  if (n >= 0) return { node: n };
  const p = pointOfRawNode(g, osmId);
  if (p < 0) return null;
  const c = chainOfPoint(g, p);
  return p === chainLast(g, c) ? { chain: c, point: p - 1, t: 1 } : { chain: c, point: p, t: 0 };
}

interface SeedInfo {
  origin: number;
  /** 'node': el origen es el nodo; 'fwd': se llegó desde la posición en el sentido del tramo; 'bwd': al revés. */
  mode: 'node' | 'fwd' | 'bwd';
}
interface TargetInfo {
  dest: number;
  /** 'node': el destino es el nodo; 'fwd': desde chainNode0 hacia la posición; 'bwd': desde chainNode1. */
  mode: 'node' | 'fwd' | 'bwd';
  cost: number;
}

// ── Búsqueda ──

export function dijkstra(
  g: CompiledGraph,
  start: Endpoint,
  end: Endpoint,
  weights: RouteWeights,
  options?: DijkstraOptions,
): EngineRoute | null {
  return dijkstraMultiSource(g, [start], [end], weights, options);
}

/**
 * Variante multi-candidato: prueba varios orígenes y destinos a la vez y
 * devuelve la mejor ruta (la de menor costo). Sirve para el "snap": en vez de
 * forzar el único tramo más cercano (que en autopistas divididas cae en la
 * calzada equivocada y obliga a rodeos absurdos), elige la combinación que
 * mejor conecta.
 */
export function dijkstraMultiSource(
  g: CompiledGraph,
  origins: Endpoint[],
  dests: Endpoint[],
  weights: RouteWeights,
  options?: DijkstraOptions,
): EngineRoute | null {
  const N = g.meta.nodeCount;
  const validNode = (n: number) => Number.isInteger(n) && n >= 0 && n < N;
  const avoidNodes = options?.avoidNodes;
  const avoidPenalty = options?.avoidPenalty ?? 6;

  // Semillas: nodo de unión → mejor costo inicial desde algún origen.
  const seedCost = new Map<number, number>();
  const seedInfo = new Map<number, SeedInfo>();
  const seed = (n: number, cost: number, info: SeedInfo) => {
    if (!validNode(n)) return;
    if (cost < (seedCost.get(n) ?? Infinity)) {
      seedCost.set(n, cost);
      seedInfo.set(n, info);
    }
  };
  origins.forEach((o, i) => {
    const n = asNode(g, o);
    if (n !== null) return seed(n, 0, { origin: i, mode: 'node' });
    const p = o as Position;
    const at = sumsAt(g, p);
    const total = sumsAt(g, endPos(g, p.chain));
    if (g.chainFwd[p.chain] >= 0) seed(g.chainNode1[p.chain], costOf(minus(total, at), weights), { origin: i, mode: 'fwd' });
    if (g.chainBwd[p.chain] >= 0) seed(g.chainNode0[p.chain], costOf(at, weights), { origin: i, mode: 'bwd' });
  });

  // Destinos: nodo de unión → costo extra para llegar desde él a algún destino.
  const target = new Map<number, TargetInfo>();
  const addTarget = (n: number, info: TargetInfo) => {
    if (!validNode(n)) return;
    if (info.cost < (target.get(n)?.cost ?? Infinity)) target.set(n, info);
  };
  dests.forEach((d, i) => {
    const n = asNode(g, d);
    if (n !== null) return addTarget(n, { dest: i, mode: 'node', cost: 0 });
    const q = d as Position;
    const at = sumsAt(g, q);
    const total = sumsAt(g, endPos(g, q.chain));
    if (g.chainFwd[q.chain] >= 0) addTarget(g.chainNode0[q.chain], { dest: i, mode: 'fwd', cost: costOf(at, weights) });
    if (g.chainBwd[q.chain] >= 0) addTarget(g.chainNode1[q.chain], { dest: i, mode: 'bwd', cost: costOf(minus(total, at), weights) });
  });

  // Recorrido directo dentro de un mismo tramo (origen y destino en el mismo tramo).
  let best = Infinity;
  let bestDirect: { o: number; d: number } | null = null;
  origins.forEach((o, i) => {
    if ('node' in o) return;
    dests.forEach((d, j) => {
      if ('node' in d || d.chain !== o.chain) return;
      const a = sumsAt(g, o);
      const b = sumsAt(g, d);
      let c = Infinity;
      if (b.len >= a.len && g.chainFwd[o.chain] >= 0) c = costOf(minus(b, a), weights);
      else if (b.len < a.len && g.chainBwd[o.chain] >= 0) c = costOf(minus(a, b), weights);
      if (c < best) {
        best = c;
        bestDirect = { o: i, d: j };
      }
    });
  });

  // Solo cuentan como "dentro del área privada del origen/destino" los nodos
  // donde está el origen/destino, o los que se alcanzan por un pedazo de tramo
  // PRIVADO. Un nodo al que se llega por un pedazo público es como uno al que
  // se llega por una arista pública: no habilita vías privadas aunque todas sus
  // salidas lo sean (p. ej. una calle pública de un sentido que termina en un
  // portón).
  const viaPrivate = (n: number, chain: number | null) => chain === null || (g.chainFlags[chain] & EDGE_FLAG_DESTINATION_ONLY) !== 0;
  const privOrigins = [...seedInfo.entries()]
    .filter(([n, si]) => viaPrivate(n, si.mode === 'node' ? null : (origins[si.origin] as Position).chain))
    .map(([n]) => n);
  const privTargets = [...target.entries()]
    .filter(([n, ti]) => viaPrivate(n, ti.mode === 'node' ? null : (dests[ti.dest] as Position).chain))
    .map(([n]) => n);
  const priv = privateAllowance(g, privOrigins, privTargets);
  const fromOrigin = priv?.fromOrigin;
  const toDest = priv?.toDest;

  const ws = workspace(g);
  const { stamp, dist, distStamp, visitedStamp, prevEdge } = ws;
  const heap = new MinHeap();
  const { outStart, edgeTo, edgeLen, edgeSumStraight, edgeSumRough, edgeSumGrade, edgeSumMinor, edgeFlags } = g;

  for (const [n, c0] of seedCost) {
    // Llegar a un nodo evitado por un pedazo de tramo (nodo fantasma) se encarece igual que por una arista.
    const c = avoidNodes && avoidNodes.has(n) ? c0 * avoidPenalty : c0;
    dist[n] = c;
    distStamp[n] = stamp;
    prevEdge[n] = -1;
    heap.push(n, c);
  }

  let bestNode = -1;
  while (heap.size > 0) {
    if (heap.topKey() >= best) break; // nada pendiente puede mejorar la mejor solución
    const u = heap.pop();
    if (visitedStamp[u] === stamp) continue;
    visitedStamp[u] = stamp;
    const distU = dist[u];

    const tg = target.get(u);
    if (tg && distU + tg.cost < best) {
      best = distU + tg.cost;
      bestNode = u;
      bestDirect = null;
    }

    for (let e = outStart[u]; e < outStart[u + 1]; e++) {
      const v = edgeTo[e];
      if (visitedStamp[v] === stamp) continue;
      if (
        (edgeFlags[e] & EDGE_FLAG_DESTINATION_ONLY) !== 0 &&
        !(fromOrigin && (fromOrigin.has(u) || toDest!.has(v)))
      ) {
        continue; // vía privada fuera del tramo inicial/final: no se usa de paso
      }
      let edgeCost = costFromSums(edgeLen[e], edgeSumStraight[e], edgeSumRough[e], edgeSumGrade[e], edgeSumMinor[e], weights);
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

  if (best === Infinity) return null;

  // ── Reconstrucción en pedazos de tramo ──
  const pieces: { from: Position; to: Position }[] = [];
  const nodes: number[] = [];
  const edges: number[] = [];
  let origin: Endpoint;
  let dest: Endpoint;
  if (bestDirect) {
    const { o, d } = bestDirect as { o: number; d: number };
    origin = origins[o];
    dest = dests[d];
    pieces.push({ from: origins[o] as Position, to: dests[d] as Position });
  } else {
    let cur = bestNode;
    while (prevEdge[cur] >= 0) {
      edges.push(prevEdge[cur]);
      cur = g.edgeFrom[prevEdge[cur]];
    }
    edges.reverse();
    nodes.push(cur, ...edges.map((e) => edgeTo[e]));
    const si = seedInfo.get(cur)!;
    origin = origins[si.origin];
    if (si.mode !== 'node') {
      const p = origins[si.origin] as Position;
      pieces.push({ from: p, to: si.mode === 'fwd' ? endPos(g, p.chain) : startPos(g, p.chain) });
    }
    for (const e of edges) {
      const c = g.edgeChain[e];
      pieces.push(g.edgeDir[e] === 0 ? { from: startPos(g, c), to: endPos(g, c) } : { from: endPos(g, c), to: startPos(g, c) });
    }
    const ti = target.get(bestNode)!;
    dest = dests[ti.dest];
    if (ti.mode !== 'node') {
      const q = dests[ti.dest] as Position;
      pieces.push({ from: ti.mode === 'fwd' ? startPos(g, q.chain) : endPos(g, q.chain), to: q });
    }
  }
  return { ...buildRouteResult(g, pieces, nodes, edges, best), origin, dest };
}

// ── Geometría y estadísticas de una ruta ──

/** Ubicación de una posición: punto exacto de geometría (o -1) y coordenadas. */
function locate(g: CompiledGraph, p: Position): { exact: number; lat: number; lon: number } {
  if (p.t === 0) return { exact: p.point, lat: g.geoLat[p.point], lon: g.geoLon[p.point] };
  if (p.t === 1) return { exact: p.point + 1, lat: g.geoLat[p.point + 1], lon: g.geoLon[p.point + 1] };
  return {
    exact: -1,
    lat: g.geoLat[p.point] + p.t * (g.geoLat[p.point + 1] - g.geoLat[p.point]),
    lon: g.geoLon[p.point] + p.t * (g.geoLon[p.point + 1] - g.geoLon[p.point]),
  };
}

/**
 * Construye el resultado a partir de pedazos de tramo (cada uno recorrido de
 * `from` a `to`, en cualquier sentido). La ruta lleva todos los nodos crudos
 * recorridos (`path`) y las coordenadas, incluidos los puntos proyectados de
 * los extremos cuando el origen/destino está a mitad de un segmento.
 */
export function buildRouteResult(
  g: CompiledGraph,
  pieces: { from: Position; to: Position }[],
  nodes: number[],
  edges: number[],
  totalCost: number,
): EngineRoute {
  const path: string[] = [];
  const coordinates: [number, number][] = [];
  const tramos: TramoUse[] = [];
  let distanceMeters = 0;
  let elevationGain = 0;
  let elevationLoss = 0;
  let curvinessMeters = 0;
  const highwayBreakdown: Record<string, number> = {};
  const surfaceBreakdown: Record<string, number> = {};

  const pushId = (p: number) => {
    const id = geoOsmIdString(g, p);
    if (path[path.length - 1] !== id) path.push(id);
  };
  const pushCoord = (lat: number, lon: number) => {
    const last = coordinates[coordinates.length - 1];
    if (!last || last[0] !== lat || last[1] !== lon) coordinates.push([lat, lon]);
  };

  for (const { from, to } of pieces) {
    const c = from.chain;
    const a = interp(g.geoCumLen, from);
    const b = interp(g.geoCumLen, to);
    const forward = b >= a;
    tramos.push({ chain: c, s0: Math.min(a, b), s1: Math.max(a, b), dir: forward ? 1 : -1 });
    // Recorremos siempre de lo/hi en orden de geometría y, si el pedazo va al revés, invertimos.
    const lo = forward ? from : to;
    const hi = forward ? to : from;
    const ids: number[] = [];
    const coords: [number, number][] = [];
    const L0 = locate(g, lo);
    const L1 = locate(g, hi);
    if (L0.exact >= 0) ids.push(L0.exact);
    coords.push([L0.lat, L0.lon]);
    const first = lo.point + 1 + (lo.t === 1 ? 1 : 0);
    const last = hi.t === 0 ? hi.point - 1 : hi.point;
    for (let k = first; k <= last; k++) {
      ids.push(k);
      coords.push([g.geoLat[k], g.geoLon[k]]);
    }
    if (L1.exact >= 0 && L1.exact !== ids[ids.length - 1]) ids.push(L1.exact);
    coords.push([L1.lat, L1.lon]);
    if (!forward) {
      ids.reverse();
      coords.reverse();
    }
    for (const k of ids) pushId(k);
    for (const [la, lo2] of coords) pushCoord(la, lo2);

    // Estadísticas por segmento (con la fracción recorrida en los extremos).
    for (let j = lo.point; j <= hi.point; j++) {
      if (j === hi.point && hi.t === 0 && j !== lo.point) break;
      const segLen = g.geoCumLen[j + 1] - g.geoCumLen[j];
      const t0 = j === lo.point ? lo.t : 0;
      const t1 = j === hi.point ? hi.t : 1;
      const frac = t1 - t0;
      if (frac <= 0) continue;
      const len = segLen * frac;
      distanceMeters += len;
      // Desnivel en el sentido de recorrido.
      elevationGain += frac * (forward ? g.segGain[j] : g.segLoss[j]);
      elevationLoss += frac * (forward ? g.segLoss[j] : g.segGain[j]);
      curvinessMeters += g.segCurv[j] * len;
      const hw = HIGHWAY_CODES[g.segHighway[j]];
      const sf = SURFACE_CODES[g.segSurface[j]];
      highwayBreakdown[hw] = (highwayBreakdown[hw] ?? 0) + len;
      surfaceBreakdown[sf] = (surfaceBreakdown[sf] ?? 0) + len;
    }
  }

  return {
    path,
    coordinates,
    totalCost,
    stats: {
      distanceMeters,
      elevationGainMeters: elevationGain,
      elevationLossMeters: elevationLoss,
      // Ponderada por largo.
      curviness: distanceMeters > 0 ? curvinessMeters / distanceMeters : 0,
      highwayBreakdown,
      surfaceBreakdown,
    },
    nodeIdx: nodes,
    edgeIdx: edges,
    tramos,
  };
}
