import { astarMultiSource } from './astar';
import { CompiledGraph, EDGE_FLAG_DESTINATION_ONLY } from './compiled-graph';
import { Endpoint, EngineRoute, Position } from './dijkstra';
import { TramoOverlay } from './overlay';
import { haversine } from '../graph-compiler/geo';

/**
 * Estructura de la red para la modalidad con longitud objetivo (F5): puentes de
 * la red PÚBLICA, núcleo, núcleo principal, acceso desde el origen (D14
 * ampliada por D19) y cotas de existencia de circuitos (techo estructural).
 *
 * Los puentes se calculan sobre la red pública: un circuito no puede usar vías
 * privadas, así que un tramo que solo forma ciclo gracias a una calle privada
 * es, para el circuito, un puente (`chainIsBridge` del compilador incluye las
 * privadas).
 */

const LENGTH_ONLY = { curvinessWeight: 0, surfaceWeight: 0 };

export interface NetworkStructure {
  /** Tramos incidentes por nodo (no dirigido; un lazo aparece dos veces). */
  incStart: Int32Array;
  incChain: Int32Array;
  /** 1 si el tramo es puente de la red pública. */
  publicBridge: Uint8Array;
  /** 1 si el nodo está en la CFC mayor y toca ≥ 2 veces tramos públicos que no son puente (un lazo cuenta 2). */
  core: Uint8Array;
  /** Componente 2-arista-conexa pública de cada nodo. */
  block: Int32Array;
  /** La mayor de esas componentes, por largo: el núcleo principal (D19). */
  mainBlock: number;
  mainBlockMeters: number;
}

const structures = new WeakMap<CompiledGraph, NetworkStructure>();

export const chainLength = (g: CompiledGraph, c: number) => g.geoCumLen[g.chainStart[c + 1] - 1];
export const isPublicChain = (g: CompiledGraph, c: number) => (g.chainFlags[c] & EDGE_FLAG_DESTINATION_ONLY) === 0;
const otherEnd = (g: CompiledGraph, c: number, u: number) => (g.chainNode0[c] === u ? g.chainNode1[c] : g.chainNode0[c]);

/** Puentes del subgrafo no dirigido formado por los tramos con `inChain` (Tarjan iterativo, multigrafo). */
export function bridgesOf(g: CompiledGraph, s: Pick<NetworkStructure, 'incStart' | 'incChain'>, inChain: Uint8Array): Uint8Array {
  const N = g.meta.nodeCount;
  const disc = new Int32Array(N).fill(-1);
  const low = new Int32Array(N);
  const bridge = new Uint8Array(g.meta.chainCount);
  const stNode = new Int32Array(N);
  const stVia = new Int32Array(N);
  const stPtr = new Int32Array(N);
  let time = 0;
  for (let s0 = 0; s0 < N; s0++) {
    if (disc[s0] >= 0) continue;
    let top = 0;
    stNode[0] = s0;
    stVia[0] = -1;
    stPtr[0] = s.incStart[s0];
    disc[s0] = low[s0] = time++;
    while (top >= 0) {
      const u = stNode[top];
      if (stPtr[top] < s.incStart[u + 1]) {
        const c = s.incChain[stPtr[top]++];
        if (!inChain[c] || c === stVia[top]) continue;
        const v = otherEnd(g, c, u);
        if (disc[v] < 0) {
          disc[v] = low[v] = time++;
          top++;
          stNode[top] = v;
          stVia[top] = c;
          stPtr[top] = s.incStart[v];
        } else if (disc[v] < low[u]) low[u] = disc[v];
      } else {
        const via = stVia[top];
        top--;
        if (top >= 0) {
          const p = stNode[top];
          if (low[u] < low[p]) low[p] = low[u];
          if (low[u] > disc[p]) bridge[via] = 1;
        }
      }
    }
  }
  return bridge;
}

/** Estructura de la red (se calcula una vez por grafo). */
export function networkStructure(g: CompiledGraph): NetworkStructure {
  let st = structures.get(g);
  if (st) return st;
  const N = g.meta.nodeCount;
  const T = g.meta.chainCount;
  const incStart = new Int32Array(N + 1);
  for (let c = 0; c < T; c++) {
    incStart[g.chainNode0[c] + 1]++;
    incStart[g.chainNode1[c] + 1]++;
  }
  for (let i = 0; i < N; i++) incStart[i + 1] += incStart[i];
  const incChain = new Int32Array(2 * T);
  const pos = incStart.slice(0, N);
  for (let c = 0; c < T; c++) {
    incChain[pos[g.chainNode0[c]]++] = c;
    incChain[pos[g.chainNode1[c]]++] = c;
  }
  const publicMask = new Uint8Array(T);
  for (let c = 0; c < T; c++) if (isPublicChain(g, c)) publicMask[c] = 1;
  const publicBridge = bridgesOf(g, { incStart, incChain }, publicMask);

  const core = new Uint8Array(N);
  for (let u = 0; u < N; u++) {
    if (!g.nodeInMainScc[u]) continue;
    let touches = 0;
    for (let p = incStart[u]; p < incStart[u + 1]; p++) {
      const c = incChain[p];
      if (publicMask[c] && !publicBridge[c]) touches++;
    }
    if (touches >= 2) core[u] = 1;
  }

  const block = new Int32Array(N).fill(-1);
  const meters: number[] = [];
  const stack: number[] = [];
  for (let s0 = 0; s0 < N; s0++) {
    if (block[s0] >= 0) continue;
    const id = meters.length;
    meters.push(0);
    block[s0] = id;
    stack.push(s0);
    while (stack.length) {
      const u = stack.pop()!;
      for (let p = incStart[u]; p < incStart[u + 1]; p++) {
        const c = incChain[p];
        if (!publicMask[c] || publicBridge[c]) continue;
        if (g.chainNode0[c] === u) meters[id] += chainLength(g, c);
        const v = otherEnd(g, c, u);
        if (block[v] < 0) {
          block[v] = id;
          stack.push(v);
        }
      }
    }
  }
  let mainBlock = 0;
  for (let i = 1; i < meters.length; i++) if (meters[i] > meters[mainBlock]) mainBlock = i;
  st = { incStart, incChain, publicBridge, core, block, mainBlock, mainBlockMeters: meters[mainBlock] ?? 0 };
  structures.set(g, st);
  return st;
}

// ── Distancias de red ──

/**
 * Distancia por largo (m) desde un extremo a todos los nodos hasta `maxLen`,
 * solo por vías públicas (Dijkstra uno-a-muchos acotado, plan §5). Infinity
 * para los que quedan más lejos.
 */
export function lengthsFrom(g: CompiledGraph, from: Endpoint, maxLen: number): Float64Array {
  const N = g.meta.nodeCount;
  const dist = new Float64Array(N).fill(Infinity);
  const keys: number[] = [];
  const vals: number[] = [];
  const push = (v: number, k: number) => {
    keys.push(k);
    vals.push(v);
    let i = keys.length - 1;
    while (i > 0) {
      const q = (i - 1) >> 1;
      if (keys[q] <= keys[i]) break;
      [keys[q], keys[i]] = [keys[i], keys[q]];
      [vals[q], vals[i]] = [vals[i], vals[q]];
      i = q;
    }
  };
  const pop = (): [number, number] => {
    const k = keys[0];
    const v = vals[0];
    const lk = keys.pop()!;
    const lv = vals.pop()!;
    if (keys.length) {
      keys[0] = lk;
      vals[0] = lv;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1;
        const r = l + 1;
        let m = i;
        if (l < keys.length && keys[l] < keys[m]) m = l;
        if (r < keys.length && keys[r] < keys[m]) m = r;
        if (m === i) break;
        [keys[m], keys[i]] = [keys[i], keys[m]];
        [vals[m], vals[i]] = [vals[i], vals[m]];
        i = m;
      }
    }
    return [v, k];
  };
  const seed = (n: number, d: number) => {
    if (d < dist[n]) {
      dist[n] = d;
      push(n, d);
    }
  };
  if ('node' in from) seed(from.node, 0);
  else {
    const c = from.chain;
    const at = g.geoCumLen[from.point] + from.t * (g.geoCumLen[from.point + 1] - g.geoCumLen[from.point]) - g.geoCumLen[g.chainStart[c]];
    if (g.chainFwd[c] >= 0) seed(g.chainNode1[c], chainLength(g, c) - at);
    if (g.chainBwd[c] >= 0) seed(g.chainNode0[c], at);
  }
  while (keys.length) {
    const [u, d] = pop();
    if (d > dist[u] || d > maxLen) continue;
    for (let e = g.outStart[u]; e < g.outStart[u + 1]; e++) {
      if ((g.edgeFlags[e] & EDGE_FLAG_DESTINATION_ONLY) !== 0) continue;
      const v = g.edgeTo[e];
      const nd = d + g.edgeLen[e];
      if (nd < dist[v] && nd <= maxLen) {
        dist[v] = nd;
        push(v, nd);
      }
    }
  }
  return dist;
}

// ── Ancla del circuito (D14 ampliada por D19) ──

export interface CircuitAnchor {
  /** Donde empieza y termina el circuito propiamente tal (sin el acceso). */
  ep: Endpoint;
  lat: number;
  lon: number;
  /** Nodos del ancla: el nodo X, o los dos extremos del tramo del origen. */
  nodes: number[];
  /** Tramo del origen, si el circuito parte de él (sin acceso). */
  chain?: number;
  /** Acceso de ida (origen → X) y de vuelta (X → origen); null si no hay acceso. */
  accessOut: EngineRoute | null;
  accessBack: EngineRoute | null;
  /** Metros de acceso repetidos (ida + vuelta). */
  accessMeters: number;
}

/**
 * Ancla del circuito para un origen (D19): si el tramo del origen es público,
 * no es puente de la red pública y está en el núcleo principal, el circuito
 * parte de él. Si no, el acceso llega hasta el nodo más cercano del núcleo
 * principal (la mayor componente 2-arista-conexa pública) y se recorre de ida
 * y de vuelta. El tope del 25% de acceso lo aplica quien usa el ancla.
 */
export function circuitAnchor(g: CompiledGraph, origin: Position & { lat: number; lon: number }): CircuitAnchor | { error: string } {
  const st = networkStructure(g);
  const c = origin.chain;
  if (isPublicChain(g, c) && !st.publicBridge[c] && st.block[g.chainNode0[c]] === st.mainBlock) {
    return { ep: origin, lat: origin.lat, lon: origin.lon, nodes: [g.chainNode0[c], g.chainNode1[c]], chain: c, accessOut: null, accessBack: null, accessMeters: 0 };
  }
  // Acceso al núcleo principal: candidatos cada vez más lejos hasta encontrar uno.
  for (const radius of [5000, 20000, 60000]) {
    const near: Endpoint[] = [];
    for (let u = 0; u < g.meta.nodeCount; u++) {
      if (st.core[u] && st.block[u] === st.mainBlock && haversine(origin.lat, origin.lon, g.nodeLat[u], g.nodeLon[u]) <= radius) near.push({ node: u });
    }
    if (!near.length) continue;
    const out = astarMultiSource(g, [origin], near, LENGTH_ONLY, { lengthOnly: true, privateAccess: { origin: true, dest: false } });
    if (!out) continue;
    const X = (out.dest as { node: number }).node;
    const back = astarMultiSource(g, [{ node: X }], [origin], LENGTH_ONLY, { lengthOnly: true, privateAccess: { origin: false, dest: true } });
    if (!back) return { error: 'el acceso al núcleo principal es de un solo sentido' };
    return { ep: { node: X }, lat: g.nodeLat[X], lon: g.nodeLon[X], nodes: [X], accessOut: out, accessBack: back, accessMeters: out.sums.len + back.sums.len };
  }
  return { error: 'no hay camino al núcleo principal de la red' };
}

/**
 * Banda del circuito propiamente tal (sin acceso) para una longitud objetivo
 * total L con tolerancia relativa `tol`, con el tope de D19: el acceso
 * repetido no puede superar `maxAccessShare` del largo total. Devuelve null si
 * la banda queda vacía (el resultado debe ser una ida y vuelta, D18).
 */
export function circuitBand(L: number, tol: number, accessMeters: number, maxAccessShare = 0.25): { lo: number; hi: number } | null {
  const hi = (1 + tol) * L - accessMeters;
  // acceso ≤ share · (circuito + acceso)  ⇔  circuito ≥ acceso · (1 − share) / share
  const lo = Math.max((1 - tol) * L - accessMeters, (accessMeters * (1 - maxAccessShare)) / maxAccessShare, 0);
  return hi > 0 && lo <= hi ? { lo, hi } : null;
}

// ── Cotas de existencia (techo estructural) ──

/**
 * Largo total de la parte de la red donde puede vivir un circuito por el
 * ancla con largo ≤ 2R: dentro del disco de radio R, pública, fuertemente
 * conexa con el ancla y 2-arista-conexa con ella (se itera hasta que no
 * cambia). Si es menor que el mínimo pedido, no hay circuito. Devuelve
 * también los nodos que quedan (para elegir puntos de giro).
 */
export function circuitUpperBound(g: CompiledGraph, anchor: CircuitAnchor, R: number): { total: number; nodes: Uint8Array | null } {
  const st = networkStructure(g);
  const N = g.meta.nodeCount;
  const T = g.meta.chainCount;
  const inNode = new Uint8Array(N);
  for (let u = 0; u < N; u++) if (g.nodeInMainScc[u] && haversine(anchor.lat, anchor.lon, g.nodeLat[u], g.nodeLon[u]) <= R) inNode[u] = 1;
  const inChain = new Uint8Array(T);
  for (let c = 0; c < T; c++) if (isPublicChain(g, c) && inNode[g.chainNode0[c]] && inNode[g.chainNode1[c]]) inChain[c] = 1;
  const root = anchor.nodes[0];
  const alive = () => inNode[root] === 1 && anchor.nodes.every((u) => inNode[u] === 1) && (anchor.chain === undefined || inChain[anchor.chain] === 1);
  const reach = (fwd: boolean) => {
    const seen = new Uint8Array(N);
    const stack = [root];
    seen[root] = 1;
    while (stack.length) {
      const u = stack.pop()!;
      for (let p = st.incStart[u]; p < st.incStart[u + 1]; p++) {
        const c = st.incChain[p];
        if (!inChain[c]) continue;
        const v = otherEnd(g, c, u);
        if (seen[v]) continue;
        const atStart = g.chainNode0[c] === u;
        const uv = atStart ? g.chainFwd[c] >= 0 : g.chainBwd[c] >= 0;
        const vu = atStart ? g.chainBwd[c] >= 0 : g.chainFwd[c] >= 0;
        if (fwd ? uv : vu) {
          seen[v] = 1;
          stack.push(v);
        }
      }
    }
    return seen;
  };
  const prune = () => {
    let changed = false;
    for (let c = 0; c < T; c++) {
      if (inChain[c] && !(inNode[g.chainNode0[c]] && inNode[g.chainNode1[c]])) {
        inChain[c] = 0;
        changed = true;
      }
    }
    return changed;
  };
  for (let round = 0; round < 20; round++) {
    if (!alive()) return { total: 0, nodes: null };
    let changed = false;
    const F = reach(true);
    const B = reach(false);
    for (let u = 0; u < N; u++) {
      if (inNode[u] && !(F[u] && B[u])) {
        inNode[u] = 0;
        changed = true;
      }
    }
    if (prune()) changed = true;
    if (!alive()) return { total: 0, nodes: null };
    const bridge = bridgesOf(g, st, inChain);
    for (let c = 0; c < T; c++) {
      if (inChain[c] && bridge[c]) {
        inChain[c] = 0;
        changed = true;
      }
    }
    const comp = new Uint8Array(N);
    const stack = [root];
    comp[root] = 1;
    while (stack.length) {
      const u = stack.pop()!;
      for (let p = st.incStart[u]; p < st.incStart[u + 1]; p++) {
        const c = st.incChain[p];
        if (!inChain[c]) continue;
        const v = otherEnd(g, c, u);
        if (!comp[v]) {
          comp[v] = 1;
          stack.push(v);
        }
      }
    }
    for (let u = 0; u < N; u++) {
      if (inNode[u] && !comp[u]) {
        inNode[u] = 0;
        changed = true;
      }
    }
    if (prune()) changed = true;
    if (!changed) break;
  }
  if (!alive()) return { total: 0, nodes: null };
  let total = 0;
  for (let c = 0; c < T; c++) if (inChain[c]) total += chainLength(g, c);
  return { total, nodes: inNode };
}

/**
 * Largo del ciclo más corto que contiene el ancla (respetando sentidos y sin
 * vías privadas). Todo circuito por el ancla contiene un ciclo por ella, así
 * que si este ya supera el máximo, no hay circuito.
 */
export function minCycleThrough(g: CompiledGraph, anchor: CircuitAnchor): number {
  const back = (from: number, to: number, chain: number) => {
    const ov = new TramoOverlay(g);
    ov.add({ chain, s0: 0, s1: chainLength(g, chain), dir: 1 });
    const r = astarMultiSource(g, [{ node: from }], [{ node: to }], LENGTH_ONLY, {
      lengthOnly: true,
      blocked: ov,
      privateAccess: { origin: false, dest: false },
    });
    return r ? r.sums.len : Infinity;
  };
  let best = Infinity;
  if (anchor.chain !== undefined) {
    const c = anchor.chain;
    const a = g.chainNode0[c];
    const b = g.chainNode1[c];
    if (g.chainFwd[c] >= 0) best = Math.min(best, chainLength(g, c) + (a === b ? 0 : back(b, a, c)));
    if (g.chainBwd[c] >= 0) best = Math.min(best, chainLength(g, c) + (a === b ? 0 : back(a, b, c)));
  } else {
    const X = anchor.nodes[0];
    for (let e = g.outStart[X]; e < g.outStart[X + 1]; e++) {
      const c = g.edgeChain[e];
      if (!isPublicChain(g, c)) continue;
      const v = g.edgeTo[e];
      best = Math.min(best, g.edgeLen[e] + (v === X ? 0 : back(v, X, c)));
    }
  }
  return best;
}

/**
 * Bloques 2-arista-conexos y puentes que puede usar una ruta sin repetir
 * tramos entre dos grupos de nodos: los del camino entre sus bloques en el
 * árbol de puentes de la red pública. Si la ruta entrara a un ramal lateral
 * (por un puente que no está en ese camino), no podría salir sin repetirlo.
 * Devuelve null si los extremos no están unidos por la red pública (por
 * ejemplo, un destino al que solo se llega por una vía privada).
 */
export function bridgeTreeCorridor(g: CompiledGraph, fromNodes: number[], toNodes: number[]): { blocks: Set<number>; bridges: Set<number> } | null {
  const st = networkStructure(g);
  // Grafo de bloques: un puente público une los bloques de sus dos extremos.
  const adj = new Map<number, [number, number][]>();
  for (let c = 0; c < g.meta.chainCount; c++) {
    if (!st.publicBridge[c] || !isPublicChain(g, c)) continue;
    const a = st.block[g.chainNode0[c]];
    const b = st.block[g.chainNode1[c]];
    if (a === b) continue;
    (adj.get(a) ?? adj.set(a, []).get(a)!).push([b, c]);
    (adj.get(b) ?? adj.set(b, []).get(b)!).push([a, c]);
  }
  const starts = new Set(fromNodes.map((u) => st.block[u]));
  const ends = new Set(toNodes.map((u) => st.block[u]));
  const blocks = new Set<number>();
  const bridges = new Set<number>();
  // BFS desde cada bloque de inicio (en un bosque, el camino a cada fin es único).
  for (const s0 of starts) {
    const parent = new Map<number, [number, number]>([[s0, [-1, -1]]]);
    const queue = [s0];
    while (queue.length) {
      const x = queue.shift()!;
      for (const [y, c] of adj.get(x) ?? []) {
        if (parent.has(y)) continue;
        parent.set(y, [x, c]);
        queue.push(y);
      }
    }
    for (const e of ends) {
      if (!parent.has(e)) continue;
      for (let x = e; x !== -1; ) {
        blocks.add(x);
        const [px, pc] = parent.get(x)!;
        if (pc >= 0) bridges.add(pc);
        x = px;
      }
    }
  }
  return blocks.size ? { blocks, bridges } : null;
}

/**
 * Cota para la ruta con destino fijo: largo total de los tramos que puede usar
 * una ruta sin repetir tramos entre origen y destino con largo ≤ Lmax:
 * - dentro de la elipse de focos origen y destino (eje mayor = Lmax);
 * - alcanzables desde el origen y desde los que se llega al destino;
 * - en el corredor del árbol de puentes (`bridgeTreeCorridor`), más los tramos
 *   privados (solo pueden aparecer en el acceso al origen o al destino, D7; se
 *   cuentan todos, así la cota sigue siendo superior).
 * Si es menor que el mínimo pedido, no hay ruta de esa longitud.
 */
export function pathUpperBound(g: CompiledGraph, from: { lat: number; lon: number; nodes: number[] }, to: { lat: number; lon: number; nodes: number[] }, Lmax: number): number {
  const st = networkStructure(g);
  const N = g.meta.nodeCount;
  const T = g.meta.chainCount;
  const inNode = new Uint8Array(N);
  for (let u = 0; u < N; u++) {
    if (!g.nodeInMainScc[u]) continue;
    const d = haversine(from.lat, from.lon, g.nodeLat[u], g.nodeLon[u]) + haversine(g.nodeLat[u], g.nodeLon[u], to.lat, to.lon);
    if (d <= Lmax) inNode[u] = 1;
  }
  for (const u of [...from.nodes, ...to.nodes]) inNode[u] = 1;
  const corridor = bridgeTreeCorridor(g, from.nodes, to.nodes);
  const inCorridor = (c: number) => {
    if (!isPublicChain(g, c) || !corridor) return true;
    if (st.publicBridge[c]) return corridor.bridges.has(c);
    return corridor.blocks.has(st.block[g.chainNode0[c]]);
  };
  const usable = (c: number) => inNode[g.chainNode0[c]] === 1 && inNode[g.chainNode1[c]] === 1 && inCorridor(c);
  const reach = (roots: number[], fwd: boolean) => {
    const seen = new Uint8Array(N);
    const stack = [...roots];
    for (const r of roots) seen[r] = 1;
    while (stack.length) {
      const u = stack.pop()!;
      for (let p = st.incStart[u]; p < st.incStart[u + 1]; p++) {
        const c = st.incChain[p];
        if (!usable(c)) continue;
        const v = otherEnd(g, c, u);
        if (seen[v]) continue;
        const atStart = g.chainNode0[c] === u;
        const uv = atStart ? g.chainFwd[c] >= 0 : g.chainBwd[c] >= 0;
        const vu = atStart ? g.chainBwd[c] >= 0 : g.chainFwd[c] >= 0;
        if (fwd ? uv : vu) {
          seen[v] = 1;
          stack.push(v);
        }
      }
    }
    return seen;
  };
  const F = reach(from.nodes, true);
  const B = reach(to.nodes, false);
  let total = 0;
  for (let c = 0; c < T; c++) {
    const a = g.chainNode0[c];
    const b = g.chainNode1[c];
    if (usable(c) && F[a] && F[b] && B[a] && B[b]) total += chainLength(g, c);
  }
  return total;
}
