import type { Db } from 'mongodb';
import { CompiledGraph } from '../dijkstra/compiled-graph';
import { GraphEdge, GraphNode } from '../dijkstra/types';
import { compileGraph } from './compile';
import { deriveGraph, DeriveStats } from './derive';
import { RawWay } from './raw';
import { WayLabels } from './twins';

/**
 * Construcción completa del grafo desde Mongo (lectura directa con el driver,
 * sin Nest), para usarla tanto desde el servicio como desde el worker.
 */

export async function readDataVersion(db: Db): Promise<number> {
  const meta = await db.collection<{ _id: string; dataVersion?: number }>('graph_meta').findOne({ _id: 'graph' });
  return meta?.dataVersion ?? 0;
}

/** Almacén por way → derivación (reglas D7) → CSR. */
export async function buildFromStore(db: Db): Promise<{ graph: CompiledGraph; derive: DeriveStats }> {
  const dataVersion = await readDataVersion(db);
  const [wayDocs, nodeDocs] = await Promise.all([
    db.collection('osm_ways').find({}, { projection: { _id: 0, osmWayId: 1, nodeIds: 1, tags: 1 } }).toArray(),
    db.collection('osm_nodes').find({}, { projection: { _id: 0, osmId: 1, lat: 1, lon: 1 } }).toArray(),
  ]);
  const coords = new Map<string, { lat: number; lon: number }>();
  for (const n of nodeDocs) coords.set(n.osmId as string, { lat: n.lat as number, lon: n.lon as number });
  const ways: RawWay[] = wayDocs.map((w) => ({ osmWayId: w.osmWayId as string, nodeIds: w.nodeIds as string[], tags: (w.tags as Record<string, string>) ?? {} }));
  const derived = deriveGraph(ways, (id) => coords.get(id));
  const wayLabels = new Map<string, WayLabels>();
  for (const w of ways) if (w.tags.name || w.tags.ref) wayLabels.set(w.osmWayId, { name: w.tags.name, ref: w.tags.ref });
  const graph = compileGraph({ nodes: derived.nodes, edges: derived.edges, source: 'osm', dataVersion, hasElevation: false, wayLabels });
  return { graph, derive: derived.stats };
}

/** Colecciones anteriores a F0.1 (`nodes`/`edges`) → CSR. */
export async function buildFromLegacy(db: Db): Promise<CompiledGraph> {
  const [nodeDocs, edgeDocs] = await Promise.all([
    db.collection('nodes').find({}, { projection: { _id: 0, osmId: 1, lat: 1, lon: 1, elevation: 1 } }).toArray(),
    db.collection('edges').find({}, { projection: { _id: 0, __v: 0 } }).toArray(),
  ]);
  const nodes: GraphNode[] = nodeDocs.map((n) => ({ osmId: n.osmId, lat: n.lat, lon: n.lon, elevation: n.elevation ?? 0 }));
  const edges: (GraphEdge & { osmWayId?: string })[] = edgeDocs.map((e) => ({
    fromOsmId: e.fromOsmId,
    toOsmId: e.toOsmId,
    distanceMeters: e.distanceMeters,
    curviness: e.curviness,
    elevationGain: e.elevationGain,
    elevationLoss: e.elevationLoss,
    highwayType: e.highwayType,
    surface: e.surface,
    smoothness: e.smoothness,
    osmWayId: e.osmWayId,
  }));
  return compileGraph({ nodes, edges, source: 'legacy', dataVersion: 0, hasElevation: true });
}
