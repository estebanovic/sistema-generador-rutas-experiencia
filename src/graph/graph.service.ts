import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { Graph, GraphEdge, GraphNode } from '../dijkstra/types';
import { Node, NodeDocument } from './schemas/node.schema';
import { Edge, EdgeDocument } from './schemas/edge.schema';

@Injectable()
export class GraphService {
  private readonly logger = new Logger(GraphService.name);
  private cachedGraph: Graph | null = null;

  constructor(
    @InjectModel(Node.name) private readonly nodeModel: Model<NodeDocument>,
    @InjectModel(Edge.name) private readonly edgeModel: Model<EdgeDocument>,
  ) {}

  /** Carga el grafo completo desde MongoDB a memoria (con cache). */
  async getGraph(): Promise<Graph> {
    if (this.cachedGraph) return this.cachedGraph;

    this.logger.log('Cargando grafo desde MongoDB a memoria...');
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

    this.cachedGraph = { nodes, adjacency };
    this.logger.log(
      `Grafo cargado: ${nodes.size} nodos, ${edgeDocs.length} aristas.`,
    );
    return this.cachedGraph;
  }

  clearCache(): void {
    this.cachedGraph = null;
  }

  /**
   * Devuelve las elevaciones ya conocidas (> 0) de los osmIds dados. Sirve para
   * no volver a pedir a la API elevaciones que ya tenemos (import incremental).
   */
  async getExistingElevations(osmIds: string[]): Promise<Map<string, number>> {
    const result = new Map<string, number>();
    const CHUNK = 5000;
    for (let i = 0; i < osmIds.length; i += CHUNK) {
      const slice = osmIds.slice(i, i + CHUNK);
      const docs = await this.nodeModel
        .find({ osmId: { $in: slice }, elevation: { $gt: 0 } }, { osmId: 1, elevation: 1 })
        .lean()
        .exec();
      for (const d of docs) result.set(d.osmId, d.elevation);
    }
    return result;
  }

  async upsertNodes(nodes: GraphNode[]): Promise<void> {
    if (nodes.length === 0) return;
    const ops = nodes.map((n) => ({
      updateOne: {
        filter: { osmId: n.osmId },
        update: {
          $set: {
            osmId: n.osmId,
            lat: n.lat,
            lon: n.lon,
            elevation: n.elevation ?? 0,
            // GeoJSON usa orden [lon, lat].
            location: { type: 'Point', coordinates: [n.lon, n.lat] },
          },
        },
        upsert: true,
      },
    }));
    await this.edgeBulk(this.nodeModel, ops);
  }

  async upsertEdges(edges: GraphEdge[]): Promise<void> {
    if (edges.length === 0) return;
    const ops = edges.map((e) => ({
      updateOne: {
        filter: {
          fromOsmId: e.fromOsmId,
          toOsmId: e.toOsmId,
          osmWayId: (e as GraphEdge & { osmWayId?: string }).osmWayId ?? '',
        },
        update: { $set: e },
        upsert: true,
      },
    }));
    await this.edgeBulk(this.edgeModel, ops);
  }

  /** bulkWrite en lotes para no exceder límites de Mongo. */
  private async edgeBulk(model: Model<any>, ops: any[]): Promise<void> {
    const BATCH = 1000;
    for (let i = 0; i < ops.length; i += BATCH) {
      await model.bulkWrite(ops.slice(i, i + BATCH), { ordered: false });
    }
  }

  /**
   * Los `k` nodos más cercanos (ordenados por distancia) usando $near. El snap
   * a un solo nodo es frágil en autopistas divididas; con varios candidatos el
   * router puede elegir el que mejor conecta.
   */
  async findNearestNodes(
    lat: number,
    lon: number,
    k: number,
  ): Promise<string[]> {
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

  /** Nodo más cercano usando índice 2dsphere + $near. */
  async findNearestNode(lat: number, lon: number): Promise<string> {
    const result = await this.nodeModel
      .findOne({
        location: {
          $near: {
            $geometry: { type: 'Point', coordinates: [lon, lat] },
            $maxDistance: 5000,
          },
        },
      })
      .lean()
      .exec();
    if (!result) {
      throw new NotFoundException(
        `No hay nodo cercano a (${lat}, ${lon}) en un radio de 5km`,
      );
    }
    return result.osmId;
  }
}
