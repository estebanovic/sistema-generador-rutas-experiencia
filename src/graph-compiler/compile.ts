import {
  CompiledGraph,
  EDGE_FLAG_DESTINATION_ONLY,
  HIGHWAY_CODES,
  SURFACE_CODES,
} from '../dijkstra/compiled-graph';
import { edgeFeatures } from '../dijkstra/cost';
import { GraphEdge, GraphNode } from '../dijkstra/types';
import { stronglyConnectedComponents } from './scc';

/**
 * Versión de la lógica derivada (normalización, features, CFC…). Subirla
 * invalida los snapshots y obliga a recompilar, sin reimportar.
 */
export const COMPILER_VERSION = 'f0.2-1';

export interface CompileInput {
  nodes: GraphNode[];
  edges: (GraphEdge & { osmWayId?: string })[];
  source: string;
  dataVersion: number;
  hasElevation: boolean;
}

/**
 * Compila nodos/aristas (de la derivación por way o de las colecciones
 * legacy) a CSR. Las aristas colgantes (extremo ausente) se descartan.
 */
export function compileGraph(input: CompileInput): CompiledGraph {
  const numeric = input.nodes.every((n) => /^\d+$/.test(n.osmId));
  const nodes = [...input.nodes].sort((a, b) =>
    numeric ? Number(a.osmId) - Number(b.osmId) : a.osmId < b.osmId ? -1 : a.osmId > b.osmId ? 1 : 0,
  );
  const N = nodes.length;
  const index = new Map<string, number>();
  const nodeOsmId = new Float64Array(N);
  const nodeLat = new Float64Array(N);
  const nodeLon = new Float64Array(N);
  nodes.forEach((n, i) => {
    index.set(n.osmId, i);
    nodeOsmId[i] = numeric ? Number(n.osmId) : i;
    nodeLat[i] = n.lat;
    nodeLon[i] = n.lon;
  });

  const edges = input.edges.filter((e) => index.has(e.fromOsmId) && index.has(e.toOsmId));
  const M = edges.length;

  // CSR de salida: conteo por origen y ubicación estable (conserva el orden).
  const outStart = new Int32Array(N + 1);
  for (const e of edges) outStart[index.get(e.fromOsmId)! + 1]++;
  for (let i = 0; i < N; i++) outStart[i + 1] += outStart[i];
  const cursor = outStart.slice(0, N);

  const edgeFrom = new Int32Array(M);
  const edgeTo = new Int32Array(M);
  const edgeLen = new Float64Array(M);
  const edgeStraight = new Float64Array(M);
  const edgeRough = new Float64Array(M);
  const edgeGrade = new Float64Array(M);
  const edgeMinor = new Float64Array(M);
  const edgeCurv = new Float32Array(M);
  const edgeGain = new Float32Array(M);
  const edgeLoss = new Float32Array(M);
  const edgeHighway = new Uint8Array(M);
  const edgeSurface = new Uint8Array(M);
  const edgeFlags = new Uint8Array(M);
  const edgeWay = new Float64Array(M);

  for (const e of edges) {
    const u = index.get(e.fromOsmId)!;
    const k = cursor[u]++;
    edgeFrom[k] = u;
    edgeTo[k] = index.get(e.toOsmId)!;
    edgeLen[k] = e.distanceMeters;
    const f = edgeFeatures(e);
    edgeStraight[k] = f.straightness;
    edgeRough[k] = f.roughness;
    edgeGrade[k] = f.grade;
    edgeMinor[k] = f.minorRoad;
    edgeCurv[k] = e.curviness;
    edgeGain[k] = e.elevationGain;
    edgeLoss[k] = e.elevationLoss;
    const h = HIGHWAY_CODES.indexOf(e.highwayType);
    edgeHighway[k] = h < 0 ? HIGHWAY_CODES.indexOf('residential') : h;
    const s = SURFACE_CODES.indexOf(e.surface);
    edgeSurface[k] = s < 0 ? SURFACE_CODES.indexOf('unknown') : s;
    edgeFlags[k] = e.destinationOnly ? EDGE_FLAG_DESTINATION_ONLY : 0;
    edgeWay[k] = e.osmWayId && /^\d+$/.test(e.osmWayId) ? Number(e.osmWayId) : 0;
  }

  // CSR de entrada (índices de arista agrupados por destino).
  const inStart = new Int32Array(N + 1);
  for (let k = 0; k < M; k++) inStart[edgeTo[k] + 1]++;
  for (let i = 0; i < N; i++) inStart[i + 1] += inStart[i];
  const inCursor = inStart.slice(0, N);
  const inEdge = new Int32Array(M);
  for (let k = 0; k < M; k++) inEdge[inCursor[edgeTo[k]]++] = k;

  const scc = stronglyConnectedComponents(N, outStart, edgeTo);
  const nodeInMainScc = new Uint8Array(N);
  for (let i = 0; i < N; i++) if (scc.comp[i] === scc.largest) nodeInMainScc[i] = 1;

  return {
    meta: {
      source: input.source,
      dataVersion: input.dataVersion,
      compilerVersion: COMPILER_VERSION,
      hasElevation: input.hasElevation,
      builtAt: new Date().toISOString(),
      nodeCount: N,
      edgeCount: M,
      sccCount: scc.count,
      mainSccSize: scc.largestSize,
    },
    nodeOsmId,
    ...(numeric ? {} : { nodeLabels: nodes.map((n) => n.osmId) }),
    nodeLat,
    nodeLon,
    nodeInMainScc,
    outStart,
    edgeFrom,
    edgeTo,
    edgeLen,
    edgeStraight,
    edgeRough,
    edgeGrade,
    edgeMinor,
    edgeCurv,
    edgeGain,
    edgeLoss,
    edgeHighway,
    edgeSurface,
    edgeFlags,
    edgeWay,
    inStart,
    inEdge,
  };
}
