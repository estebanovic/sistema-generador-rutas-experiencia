import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { Graph, GraphEdge, GraphNode } from '../dijkstra/types';
import { deriveGraph, DeriveStats } from '../graph-compiler/derive';
import { Node, NodeDocument } from './schemas/node.schema';
import { Edge, EdgeDocument } from './schemas/edge.schema';
import { OsmStoreService } from './osm-store.service';

/**
 * Fuente del grafo:
 * - `osm` (por defecto): almacén canónico por way (`osm_ways`/`osm_nodes`),
 *   derivado con las reglas de `src/graph-compiler/`.
 * - `legacy`: colecciones anteriores a F0.1 (`nodes`/`edges`), congeladas hasta
 *   el punto de control C0 para poder comparar y volver atrás.
 */
export type GraphSource = 'osm' | 'legacy';

@Injectable()
export class GraphService {
  private readonly logger = new Logger(GraphService.name);
  private cachedGraph: Graph | null = null;
  private lastDeriveStats: DeriveStats | null = null;
  readonly source: GraphSource = process.env.GRAPH_SOURCE === 'legacy' ? 'legacy' : 'osm';

  constructor(
    @InjectModel(Node.name) private readonly nodeModel: Model<NodeDocument>,
    @InjectModel(Edge.name) private readonly edgeModel: Model<EdgeDocument>,
    private readonly store: OsmStoreService,
  ) {}

  /** Carga el grafo completo a memoria (con cache). */
  async getGraph(): Promise<Graph> {
    if (this.cachedGraph) return this.cachedGraph;
    const t0 = Date.now();
    this.cachedGraph = this.source === 'legacy' ? await this.loadLegacy() : await this.loadFromStore();
    let edgeCount = 0;
    for (const list of this.cachedGraph.adjacency.values()) edgeCount += list.length;
    this.logger.log(
      `Grafo cargado (${this.source}): ${this.cachedGraph.nodes.size} nodos, ${edgeCount} aristas, ${Date.now() - t0} ms.`,
    );
    return this.cachedGraph;
  }

  /** La fuente nueva no tiene elevación (decisión del plan: fuera del alcance). */
  hasElevation(): boolean {
    return this.source === 'legacy';
  }

  /** Estadísticas de la última derivación (ways excluidos por regla, etc.). */
  deriveStats(): DeriveStats | null {
    return this.lastDeriveStats;
  }

  clearCache(): void {
    this.cachedGraph = null;
  }

  private async loadFromStore(): Promise<Graph> {
    this.logger.log('Derivando grafo desde el almacén por way...');
    const { ways, coords } = await this.store.loadAll();
    const derived = deriveGraph(ways, (id) => coords.get(id));
    this.lastDeriveStats = derived.stats;
    const nodes = new Map<string, GraphNode>();
    for (const n of derived.nodes) nodes.set(n.osmId, n);
    const adjacency = new Map<string, GraphEdge[]>();
    for (const { osmWayId: _w, ...edge } of derived.edges) {
      const list = adjacency.get(edge.fromOsmId);
      if (list) list.push(edge);
      else adjacency.set(edge.fromOsmId, [edge]);
    }
    return { nodes, adjacency };
  }

  private async loadLegacy(): Promise<Graph> {
    this.logger.log('Cargando grafo desde las colecciones anteriores (legacy)...');
    const [nodeDocs, edgeDocs] = await Promise.all([
      this.nodeModel.find().lean().exec(),
      this.edgeModel.find().lean().exec(),
    ]);

    const nodes = new Map<string, GraphNode>();
    for (const n of nodeDocs) {
      nodes.set(n.osmId, {
        osmId: n.osmId,
        lat: n.lat,
        lon: n.lon,
        elevation: n.elevation ?? 0,
      });
    }

    const adjacency = new Map<string, GraphEdge[]>();
    for (const e of edgeDocs) {
      // Ignoramos aristas colgantes (nodo extremo ausente del grafo).
      if (!nodes.has(e.fromOsmId) || !nodes.has(e.toOsmId)) continue;
      const edge: GraphEdge = {
        fromOsmId: e.fromOsmId,
        toOsmId: e.toOsmId,
        distanceMeters: e.distanceMeters,
        curviness: e.curviness,
        elevationGain: e.elevationGain,
        elevationLoss: e.elevationLoss,
        highwayType: e.highwayType as GraphEdge['highwayType'],
        surface: e.surface as GraphEdge['surface'],
        smoothness: e.smoothness as GraphEdge['smoothness'],
      };
      const list = adjacency.get(e.fromOsmId);
      if (list) list.push(edge);
      else adjacency.set(e.fromOsmId, [edge]);
    }
    return { nodes, adjacency };
  }

  /**
   * Los `k` nodos del grafo más cercanos (ordenados por distancia). El snap a
   * un solo nodo es frágil en autopistas divididas; con varios candidatos el
   * router puede elegir el que mejor conecta. En la fuente nueva el almacén
   * también tiene nodos de vías excluidas (D7), así que se piden de más y se
   * filtran a los que están en el grafo.
   */
  async findNearestNodes(lat: number, lon: number, k: number): Promise<string[]> {
    if (this.source === 'legacy') return this.legacyNearest(lat, lon, k);
    const graph = await this.getGraph();
    const ids = await this.store.findNearestNodeIds(lat, lon, k * 8);
    return ids.filter((id) => graph.nodes.has(id)).slice(0, k);
  }

  /** Nodo del grafo más cercano. */
  async findNearestNode(lat: number, lon: number): Promise<string> {
    const [id] = await this.findNearestNodes(lat, lon, 1);
    if (!id) {
      throw new NotFoundException(`No hay nodo cercano a (${lat}, ${lon}) en un radio de 5km`);
    }
    return id;
  }

  private async legacyNearest(lat: number, lon: number, k: number): Promise<string[]> {
    const docs = await this.nodeModel
      .find({
        location: {
          $near: {
            $geometry: { type: 'Point', coordinates: [lon, lat] },
            $maxDistance: 5000,
          },
        },
      })
      .limit(k)
      .lean()
      .exec();
    return docs.map((d) => d.osmId);
  }
}
