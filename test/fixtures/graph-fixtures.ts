/**
 * Fixtures de grafos para tests: sintéticos (solución conocida) y un subgrafo
 * real exportado de Mongo con `scripts/export-fixture.js`.
 *
 * Los fixtures se describen en un formato plano (`PlainGraph`) y se convierten
 * al formato del motor actual (grafo compilado en CSR, desde F0.2) o al del
 * oráculo legado (Maps).
 */
import * as fs from 'fs';
import * as path from 'path';
import { CompiledGraph } from '../../src/dijkstra/compiled-graph';
import { compileGraph } from '../../src/graph-compiler/compile';
import {
  GraphEdge,
  GraphNode,
  HighwayType,
  SmoothnessType,
  SurfaceType,
} from '../../src/dijkstra/types';
import * as legacy from '../../src/dijkstra/legacy/types.legacy';

export interface PlainGraph {
  nodes: GraphNode[];
  edges: (GraphEdge & { osmWayId?: string })[];
}

// ── Conversión a los formatos de los motores ─────────────────

function buildMaps<N, E extends { fromOsmId: string }>(
  nodes: N[],
  edges: E[],
  idOf: (n: N) => string,
) {
  const nodeMap = new Map<string, N>();
  for (const n of nodes) nodeMap.set(idOf(n), n);
  const adjacency = new Map<string, E[]>();
  for (const e of edges) {
    const list = adjacency.get(e.fromOsmId);
    if (list) list.push(e);
    else adjacency.set(e.fromOsmId, [e]);
  }
  return { nodes: nodeMap, adjacency };
}

/** Grafo en el formato del motor actual (CSR compilado). */
export function toGraph(p: PlainGraph): CompiledGraph {
  return compileGraph({ nodes: p.nodes, edges: p.edges, source: 'test', dataVersion: 0, hasElevation: true });
}

/** Grafo en el formato del oráculo legado (copia congelada anterior a F0). */
export function toLegacyGraph(p: PlainGraph): legacy.Graph {
  return buildMaps(
    p.nodes.map((n) => ({ ...n })),
    p.edges.map((e) => ({ ...e }) as legacy.GraphEdge),
    (n) => n.osmId,
  );
}

// ── Fixture real ─────────────────────────────────────────────

interface FixtureFile {
  meta: { name: string; bbox: Record<string, number>; exportedAt: string };
  nodes: [string, number, number, number][];
  edges: [string, string, number, number, number, number, string, string, string, string][];
}

/** Carga test/fixtures/<nombre>.json (exportado con scripts/export-fixture.js). */
export function loadFixture(name: string): PlainGraph & { meta: FixtureFile['meta'] } {
  const file = path.join(__dirname, `${name}.json`);
  const raw = JSON.parse(fs.readFileSync(file, 'utf8')) as FixtureFile;
  return {
    meta: raw.meta,
    nodes: raw.nodes.map(([osmId, lat, lon, elevation]) => ({ osmId, lat, lon, elevation })),
    edges: raw.edges.map(([fromOsmId, toOsmId, distanceMeters, curviness, elevationGain, elevationLoss, highwayType, surface, smoothness, osmWayId]) => ({
      fromOsmId,
      toOsmId,
      distanceMeters,
      curviness,
      elevationGain,
      elevationLoss,
      highwayType: highwayType as HighwayType,
      surface: surface as SurfaceType,
      smoothness: smoothness as SmoothnessType,
      osmWayId,
    })),
  };
}

/** Ways del Camino a Farellones (G-21) presentes en el fixture `farellones`. */
export const CAMINO_A_FARELLONES_WAY_IDS = [
  '30679799', '283786386', '285948716', '928492318', '41264709',
  '313444753', '313444758', '120257748', '41264708',
];

// ── Fixtures sintéticos ──────────────────────────────────────

export interface EdgeSpec {
  from: string;
  to: string;
  length: number;
  curviness?: number;
  highwayType?: HighwayType;
  surface?: SurfaceType;
  smoothness?: SmoothnessType;
  /** true = solo from→to. Por defecto la arista es de doble sentido. */
  oneway?: boolean;
  elevationGain?: number;
  elevationLoss?: number;
}

/**
 * Arma un grafo sintético. Las coordenadas son [lat, lon]; los largos se dan
 * explícitos para que la solución esperada no dependa de la haversine.
 */
export function synthetic(
  coords: Record<string, [number, number]>,
  specs: EdgeSpec[],
): PlainGraph {
  const nodes: GraphNode[] = Object.entries(coords).map(([osmId, [lat, lon]]) => ({
    osmId,
    lat,
    lon,
    elevation: 0,
  }));
  const edges: GraphEdge[] = [];
  for (const s of specs) {
    const base = {
      distanceMeters: s.length,
      curviness: s.curviness ?? 0,
      highwayType: s.highwayType ?? 'secondary',
      surface: s.surface ?? 'asphalt',
      smoothness: s.smoothness ?? 'good',
    };
    edges.push({ ...base, fromOsmId: s.from, toOsmId: s.to, elevationGain: s.elevationGain ?? 0, elevationLoss: s.elevationLoss ?? 0 });
    if (!s.oneway) {
      edges.push({ ...base, fromOsmId: s.to, toOsmId: s.from, elevationGain: s.elevationLoss ?? 0, elevationLoss: s.elevationGain ?? 0 });
    }
  }
  return { nodes, edges };
}

/**
 * Diamante: S→A→T es recto y corto (1000 m, curviness 0); S→B→T es curvo y
 * largo (1300 m, curviness 1). Distancia pura elige A; curvas elige B.
 */
export function diamante(): PlainGraph {
  return synthetic(
    { S: [0, 0], A: [0.003, 0.0045], B: [-0.004, 0.0045], T: [0, 0.009] },
    [
      { from: 'S', to: 'A', length: 500 },
      { from: 'A', to: 'T', length: 500 },
      { from: 'S', to: 'B', length: 650, curviness: 1 },
      { from: 'B', to: 'T', length: 650, curviness: 1 },
    ],
  );
}

/** Grilla n×n de calles rectas de `step` metros; nodos "r,c". */
export function grilla(n: number, step = 100): PlainGraph {
  const coords: Record<string, [number, number]> = {};
  const specs: EdgeSpec[] = [];
  for (let r = 0; r < n; r++) {
    for (let c = 0; c < n; c++) {
      coords[`${r},${c}`] = [r * 0.0009, c * 0.0011];
      if (c + 1 < n) specs.push({ from: `${r},${c}`, to: `${r},${c + 1}`, length: step });
      if (r + 1 < n) specs.push({ from: `${r},${c}`, to: `${r + 1},${c}`, length: step });
    }
  }
  return synthetic(coords, specs);
}

// ── Utilidades ───────────────────────────────────────────────

/** RNG determinista (mulberry32) para elegir pares reproducibles. */
export function seededRandom(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Pares (origen, destino) distintos y reproducibles entre nodos con aristas salientes. */
export function randomPairs(g: PlainGraph, count: number, seed: number): [string, string][] {
  const withOut = [...new Set(g.edges.map((e) => e.fromOsmId))].sort();
  const rnd = seededRandom(seed);
  const pairs: [string, string][] = [];
  while (pairs.length < count) {
    const a = withOut[Math.floor(rnd() * withOut.length)];
    const b = withOut[Math.floor(rnd() * withOut.length)];
    if (a !== b) pairs.push([a, b]);
  }
  return pairs;
}
