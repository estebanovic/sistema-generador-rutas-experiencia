import {
  CompiledGraph,
  EDGE_FLAG_DESTINATION_ONLY,
  HIGHWAY_CODES,
  SURFACE_CODES,
} from '../dijkstra/compiled-graph';
import { edgeFeatures } from '../dijkstra/cost';
import { GraphEdge, GraphNode } from '../dijkstra/types';
import { bridges } from './bridges';
import { CURVATURE_SATURATION_DEG_PER_KM } from './curviness';
import { SURFACE_SOURCES, SurfaceSource } from './surface';
import { stronglyConnectedComponents } from './scc';
import { oppositeTwins, WayLabels } from './twins';

/**
 * Versión de la lógica derivada (normalización, compactación, features, CFC…).
 * Subirla invalida los snapshots y obliga a recompilar, sin reimportar.
 */
export const COMPILER_VERSION = 'f2-1';

export interface CompileInput {
  nodes: GraphNode[];
  edges: (GraphEdge & { osmWayId?: string; surfaceSource?: SurfaceSource })[];
  source: string;
  dataVersion: number;
  hasElevation: boolean;
  /** name/ref de cada way (para las calzadas gemelas, D13). */
  wayLabels?: Map<string, WayLabels>;
}

/** Segmento crudo no dirigido (un par de nodos consecutivos de un way). */
interface Segment {
  a: number; // índice crudo (orientación: la de la primera arista vista)
  b: number;
  ab: boolean; // se puede ir a→b
  ba: boolean; // se puede ir b→a
  edge: GraphEdge & { osmWayId?: string; surfaceSource?: SurfaceSource }; // atributos (los de la arista a→b o b→a)
  gainAB: number;
  lossAB: number;
  private: boolean;
}

/**
 * Compila nodos/aristas crudos (de la derivación por way o de las colecciones
 * legacy) a un grafo COMPACTADO en CSR. Las aristas colgantes se descartan.
 */
export function compileGraph(input: CompileInput): CompiledGraph {
  // ── Nodos crudos: orden por osmId (o etiquetas en los fixtures) ──
  const numeric = input.nodes.every((n) => /^\d+$/.test(n.osmId));
  const raw = [...input.nodes].sort((a, b) =>
    numeric ? Number(a.osmId) - Number(b.osmId) : a.osmId < b.osmId ? -1 : a.osmId > b.osmId ? 1 : 0,
  );
  const R = raw.length;
  const rawIndex = new Map<string, number>();
  raw.forEach((n, i) => rawIndex.set(n.osmId, i));
  const rawId = (i: number) => (numeric ? Number(raw[i].osmId) : i);

  // ── Segmentos no dirigidos (por par de nodos y way) ──
  const segs: Segment[] = [];
  const segKey = new Map<string, number>();
  for (const e of input.edges) {
    const u = rawIndex.get(e.fromOsmId);
    const v = rawIndex.get(e.toOsmId);
    if (u === undefined || v === undefined || u === v) continue;
    const key = `${Math.min(u, v)}|${Math.max(u, v)}|${e.osmWayId ?? ''}`;
    const s = segKey.get(key);
    if (s === undefined) {
      segKey.set(key, segs.length);
      segs.push({ a: u, b: v, ab: true, ba: false, edge: e, gainAB: e.elevationGain, lossAB: e.elevationLoss, private: !!e.destinationOnly });
    } else if (segs[s].a === u) {
      segs[s].ab = true;
    } else {
      segs[s].ba = true;
    }
  }
  const S = segs.length;

  // Incidencia nodo crudo → segmentos (CSR).
  const incStart = new Int32Array(R + 1);
  for (const s of segs) {
    incStart[s.a + 1]++;
    incStart[s.b + 1]++;
  }
  for (let i = 0; i < R; i++) incStart[i + 1] += incStart[i];
  const incCur = incStart.slice(0, R);
  const incSeg = new Int32Array(2 * S);
  segs.forEach((s, k) => {
    incSeg[incCur[s.a]++] = k;
    incSeg[incCur[s.b]++] = k;
  });
  const other = (s: Segment, x: number) => (s.a === x ? s.b : s.a);
  const allows = (s: Segment, from: number) => (s.a === from ? s.ab : s.ba);

  // ── Nodos de unión ──
  const keep = new Uint8Array(R);
  for (let v = 0; v < R; v++) {
    const deg = incStart[v + 1] - incStart[v];
    if (deg === 0) continue; // nodo sin segmentos: no entra al grafo
    if (deg !== 2) {
      keep[v] = 1;
      continue;
    }
    const s1 = segs[incSeg[incStart[v]]];
    const s2 = segs[incSeg[incStart[v] + 1]];
    const x = other(s1, v);
    const y = other(s2, v);
    const consistent =
      x !== y && // dos segmentos hacia el mismo vecino (vías paralelas): se corta
      s1.private === s2.private && // cambio de acceso privado: se corta
      allows(s1, x) === allows(s2, v) && // sentido x→v→y
      allows(s2, y) === allows(s1, v); // sentido y→v→x
    if (!consistent) keep[v] = 1;
  }

  // ── Tramos: caminatas entre nodos de unión ──
  const visited = new Uint8Array(S);
  const chainPts: number[][] = [];
  const chainSegs: number[][] = [];
  const walk = (start: number, firstSeg: number) => {
    const pts = [start];
    const sg: number[] = [];
    let cur = start;
    let seg = firstSeg;
    while (true) {
      visited[seg] = 1;
      sg.push(seg);
      const nxt = other(segs[seg], cur);
      pts.push(nxt);
      if (keep[nxt]) break;
      const a = incSeg[incStart[nxt]];
      const b = incSeg[incStart[nxt] + 1];
      const n2 = a === seg ? b : a;
      if (visited[n2]) break;
      cur = nxt;
      seg = n2;
    }
    chainPts.push(pts);
    chainSegs.push(sg);
  };
  for (let v = 0; v < R; v++) {
    if (!keep[v]) continue;
    for (let p = incStart[v]; p < incStart[v + 1]; p++) if (!visited[incSeg[p]]) walk(v, incSeg[p]);
  }
  // Ciclos puros (sin ningún nodo de unión): se elige uno de sus nodos como unión.
  for (let v = 0; v < R; v++) {
    if (keep[v] || incStart[v + 1] === incStart[v] || visited[incSeg[incStart[v]]]) continue;
    keep[v] = 1;
    walk(v, incSeg[incStart[v]]);
  }
  const T = chainPts.length;

  // ── Nodos compactos (orden crudo = orden por osmId) ──
  const compactOf = new Int32Array(R).fill(-1);
  let N = 0;
  for (let v = 0; v < R; v++) if (keep[v]) compactOf[v] = N++;
  const nodeOsmId = new Float64Array(N);
  const nodeLat = new Float64Array(N);
  const nodeLon = new Float64Array(N);
  for (let v = 0; v < R; v++) {
    const c = compactOf[v];
    if (c < 0) continue;
    nodeOsmId[c] = rawId(v);
    nodeLat[c] = raw[v].lat;
    nodeLon[c] = raw[v].lon;
  }

  // ── Geometría con sumas prefijas ──
  const P = chainPts.reduce((s, p) => s + p.length, 0);
  const chainStart = new Int32Array(T + 1);
  const geoOsmId = new Float64Array(P);
  const geoLat = new Float64Array(P);
  const geoLon = new Float64Array(P);
  const geoCumLen = new Float64Array(P);
  const geoCumStraight = new Float64Array(P);
  const geoCumUnpaved = new Float64Array(P);
  const geoCumMinor = new Float64Array(P);
  const segCurv = new Float32Array(P);
  const segCurvDeg = new Float32Array(P);
  const segGain = new Float32Array(P);
  const segLoss = new Float32Array(P);
  const segHighway = new Uint8Array(P);
  const segSurface = new Uint8Array(P);
  /** Procedencia de la superficie (índice en SURFACE_SOURCES; 255 = sin dato, p. ej. legacy). */
  const segSurfaceSource = new Uint8Array(P).fill(255);
  const segWay = new Float64Array(P);
  const chainFlags = new Uint8Array(T);
  const chainNode0 = new Int32Array(T);
  const chainNode1 = new Int32Array(T);
  const chainCanFwd = new Uint8Array(T);
  const chainCanBwd = new Uint8Array(T);

  let p = 0;
  for (let t = 0; t < T; t++) {
    chainStart[t] = p;
    const pts = chainPts[t];
    const sg = chainSegs[t];
    chainNode0[t] = compactOf[pts[0]];
    chainNode1[t] = compactOf[pts[pts.length - 1]];
    const s0 = segs[sg[0]];
    chainCanFwd[t] = allows(s0, pts[0]) ? 1 : 0;
    chainCanBwd[t] = allows(s0, pts[1]) ? 1 : 0;
    chainFlags[t] = s0.private ? EDGE_FLAG_DESTINATION_ONLY : 0;
    for (let j = 0; j < pts.length; j++, p++) {
      const v = pts[j];
      geoOsmId[p] = rawId(v);
      geoLat[p] = raw[v].lat;
      geoLon[p] = raw[v].lon;
      if (j === 0) continue;
      // Segmento j-1 → j del tramo (sus atributos van en el punto p-1).
      const s = segs[sg[j - 1]];
      const e = s.edge;
      const len = e.distanceMeters;
      const f = edgeFeatures(e);
      geoCumLen[p] = geoCumLen[p - 1] + len;
      geoCumStraight[p] = geoCumStraight[p - 1] + len * f.straightness;
      geoCumUnpaved[p] = geoCumUnpaved[p - 1] + len * f.unpaved;
      geoCumMinor[p] = geoCumMinor[p - 1] + len * f.minorRoad;
      const forward = s.a === pts[j - 1];
      segCurv[p - 1] = e.curviness;
      // Las colecciones legacy no traen °/km: se aproxima desde la sinuosidad normalizada.
      segCurvDeg[p - 1] = e.curvatureDegPerKm ?? e.curviness * CURVATURE_SATURATION_DEG_PER_KM;
      segGain[p - 1] = forward ? s.gainAB : s.lossAB;
      segLoss[p - 1] = forward ? s.lossAB : s.gainAB;
      const h = HIGHWAY_CODES.indexOf(e.highwayType);
      segHighway[p - 1] = h < 0 ? HIGHWAY_CODES.indexOf('residential') : h;
      const sf = SURFACE_CODES.indexOf(e.surface);
      segSurface[p - 1] = sf < 0 ? SURFACE_CODES.indexOf('unknown') : sf;
      if (e.surfaceSource) segSurfaceSource[p - 1] = SURFACE_SOURCES.indexOf(e.surfaceSource);
      segWay[p - 1] = e.osmWayId && /^\d+$/.test(e.osmWayId) ? Number(e.osmWayId) : 0;
    }
  }
  chainStart[T] = p;

  // ── Aristas dirigidas (una por tramo y sentido) y CSR ──
  const edgeList: { from: number; to: number; chain: number; dir: number }[] = [];
  for (let t = 0; t < T; t++) {
    if (chainCanFwd[t]) edgeList.push({ from: chainNode0[t], to: chainNode1[t], chain: t, dir: 0 });
    if (chainCanBwd[t]) edgeList.push({ from: chainNode1[t], to: chainNode0[t], chain: t, dir: 1 });
  }
  const M = edgeList.length;
  const outStart = new Int32Array(N + 1);
  for (const e of edgeList) outStart[e.from + 1]++;
  for (let i = 0; i < N; i++) outStart[i + 1] += outStart[i];
  const cur = outStart.slice(0, N);
  const edgeFrom = new Int32Array(M);
  const edgeTo = new Int32Array(M);
  const edgeChain = new Int32Array(M);
  const edgeDir = new Uint8Array(M);
  const edgeLen = new Float64Array(M);
  const edgeSumStraight = new Float64Array(M);
  const edgeSumUnpaved = new Float64Array(M);
  const edgeSumMinor = new Float64Array(M);
  const edgeFlags = new Uint8Array(M);
  const chainFwd = new Int32Array(T).fill(-1);
  const chainBwd = new Int32Array(T).fill(-1);
  for (const e of edgeList) {
    const k = cur[e.from]++;
    const last = chainStart[e.chain + 1] - 1;
    edgeFrom[k] = e.from;
    edgeTo[k] = e.to;
    edgeChain[k] = e.chain;
    edgeDir[k] = e.dir;
    edgeLen[k] = geoCumLen[last];
    edgeSumStraight[k] = geoCumStraight[last];
    edgeSumUnpaved[k] = geoCumUnpaved[last];
    edgeSumMinor[k] = geoCumMinor[last];
    edgeFlags[k] = chainFlags[e.chain];
    if (e.dir === 0) chainFwd[e.chain] = k;
    else chainBwd[e.chain] = k;
  }
  const inStart = new Int32Array(N + 1);
  for (let k = 0; k < M; k++) inStart[edgeTo[k] + 1]++;
  for (let i = 0; i < N; i++) inStart[i + 1] += inStart[i];
  const inCur = inStart.slice(0, N);
  const inEdge = new Int32Array(M);
  for (let k = 0; k < M; k++) inEdge[inCur[edgeTo[k]]++] = k;

  // ── Conectividad: CFC (snap, D15), grado y puentes (excepción del acceso, D14) ──
  const scc = stronglyConnectedComponents(N, outStart, edgeTo);

  // ── Enclaves (D16): calles públicas a las que solo se entra o de las que solo
  // se sale por vías privadas (típico: calles internas de un condominio cuyo
  // portón está etiquetado como privado) pasan a ser parte del área privada. ──
  const enclaveChains = markEnclaves(N, M, T, outStart, edgeTo, edgeFlags, inStart, inEdge, edgeFrom, chainNode0, chainNode1, chainFlags, chainFwd, chainBwd, scc.comp, scc.largest);
  const nodeInMainScc = new Uint8Array(N);
  for (let i = 0; i < N; i++) if (scc.comp[i] === scc.largest) nodeInMainScc[i] = 1;
  const nodeDegree = new Int32Array(N);
  for (let t = 0; t < T; t++) {
    nodeDegree[chainNode0[t]]++;
    nodeDegree[chainNode1[t]]++;
  }
  const chainIsBridge = bridges(N, chainNode0, chainNode1);

  const g: CompiledGraph = {
    meta: {
      source: input.source,
      dataVersion: input.dataVersion,
      compilerVersion: COMPILER_VERSION,
      hasElevation: input.hasElevation,
      builtAt: new Date().toISOString(),
      nodeCount: N,
      edgeCount: M,
      chainCount: T,
      geoCount: P,
      rawNodeCount: R,
      sccCount: scc.count,
      mainSccSize: scc.largestSize,
      enclaveChains,
    },
    ...(numeric ? {} : { rawLabels: raw.map((n) => n.osmId) }),
    nodeOsmId, nodeLat, nodeLon, nodeInMainScc, nodeDegree,
    outStart, edgeFrom, edgeTo, edgeChain, edgeDir, edgeLen,
    edgeSumStraight, edgeSumUnpaved, edgeSumMinor, edgeFlags,
    inStart, inEdge,
    chainStart, chainFwd, chainBwd, chainNode0, chainNode1, chainIsBridge, chainFlags,
    geoOsmId, geoLat, geoLon, geoCumLen, geoCumStraight, geoCumUnpaved, geoCumMinor,
    segCurv, segCurvDeg, segGain, segLoss, segHighway, segSurface, segSurfaceSource, segWay,
    twinStart: new Int32Array(M + 1),
    twinEdge: new Int32Array(0),
    twinFrac: new Float32Array(0),
  };

  // ── Calzadas gemelas (D13) ──
  if (input.wayLabels && input.wayLabels.size > 0) {
    const tw = oppositeTwins(g, input.wayLabels);
    g.twinStart = tw.twinStart;
    g.twinEdge = tw.twinEdge;
    g.twinFrac = tw.twinFrac;
  }
  return g;
}

/**
 * Marca como privados (solo origen/destino) los tramos públicos que no se
 * pueden alcanzar desde la red pública principal, o desde los que no se puede
 * volver a ella, usando solo vías públicas, pero que sí están conectados al
 * resto por vías privadas (decisión D16). La red pública principal es la mayor
 * componente fuertemente conexa del subgrafo de aristas públicas. Modifica
 * `edgeFlags` y `chainFlags` en el lugar y devuelve cuántos tramos marcó.
 */
function markEnclaves(
  N: number,
  M: number,
  T: number,
  outStart: Int32Array,
  edgeTo: Int32Array,
  edgeFlags: Uint8Array,
  inStart: Int32Array,
  inEdge: Int32Array,
  edgeFrom: Int32Array,
  chainNode0: Int32Array,
  chainNode1: Int32Array,
  chainFlags: Uint8Array,
  chainFwd: Int32Array,
  chainBwd: Int32Array,
  comp: Int32Array,
  mainComp: number,
): number {
  const isPublic = (e: number) => (edgeFlags[e] & EDGE_FLAG_DESTINATION_ONLY) === 0;
  // Subgrafo público en CSR.
  const pubStart = new Int32Array(N + 1);
  for (let e = 0; e < M; e++) if (isPublic(e)) pubStart[edgeFrom[e] + 1]++;
  for (let i = 0; i < N; i++) pubStart[i + 1] += pubStart[i];
  const cur = pubStart.slice(0, N);
  const pubTo = new Int32Array(pubStart[N]);
  for (let u = 0; u < N; u++) {
    for (let e = outStart[u]; e < outStart[u + 1]; e++) if (isPublic(e)) pubTo[cur[u]++] = edgeTo[e];
  }
  const pub = stronglyConnectedComponents(N, pubStart, pubTo);
  if (pub.largest < 0) return 0;

  // Alcanzable desde la red pública principal (F) y que puede volver a ella (B), solo por vías públicas.
  const F = new Uint8Array(N);
  const B = new Uint8Array(N);
  const queue: number[] = [];
  for (let i = 0; i < N; i++) {
    if (pub.comp[i] === pub.largest) {
      F[i] = 1;
      B[i] = 1;
      queue.push(i);
    }
  }
  const seeds = [...queue];
  while (queue.length) {
    const u = queue.pop()!;
    for (let p = pubStart[u]; p < pubStart[u + 1]; p++) {
      const v = pubTo[p];
      if (!F[v]) {
        F[v] = 1;
        queue.push(v);
      }
    }
  }
  for (const s of seeds) queue.push(s); // sin spread: son cientos de miles
  while (queue.length) {
    const v = queue.pop()!;
    for (let p = inStart[v]; p < inStart[v + 1]; p++) {
      const e = inEdge[p];
      if (!isPublic(e)) continue;
      const u = edgeFrom[e];
      if (!B[u]) {
        B[u] = 1;
        queue.push(u);
      }
    }
  }

  let marked = 0;
  for (let t = 0; t < T; t++) {
    if (chainFlags[t] & EDGE_FLAG_DESTINATION_ONLY) continue;
    const a = chainNode0[t];
    const b = chainNode1[t];
    const publicOk = F[a] && B[a] && F[b] && B[b];
    const connected = comp[a] === mainComp && comp[b] === mainComp;
    if (publicOk || !connected) continue;
    chainFlags[t] |= EDGE_FLAG_DESTINATION_ONLY;
    if (chainFwd[t] >= 0) edgeFlags[chainFwd[t]] |= EDGE_FLAG_DESTINATION_ONLY;
    if (chainBwd[t] >= 0) edgeFlags[chainBwd[t]] |= EDGE_FLAG_DESTINATION_ONLY;
    marked++;
  }
  return marked;
}
