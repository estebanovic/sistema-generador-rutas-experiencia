import { Injectable, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { RawWay } from '../graph-compiler/raw';
import { ParsedOsm } from '../osm/osm.parser';
import { BoundingBox } from '../osm/osm.types';
import { ExistingWayRef, inBbox, planReplacement, wayBbox } from '../import/replace-plan';
import {
  GraphMeta,
  OsmImport,
  OsmNode,
  OsmWay,
} from './schemas/osm.schemas';

export interface ApplyImportResult {
  ways: number;
  nodes: number;
  deletedWays: number;
  dataVersion: number;
}

const BATCH = 1000;
const chunks = <T>(arr: T[], size: number): T[][] => {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
};

/** Almacén canónico por way: `osm_ways`, `osm_nodes`, `osm_imports`, `graph_meta`. */
@Injectable()
export class OsmStoreService {
  private readonly logger = new Logger(OsmStoreService.name);

  constructor(
    @InjectModel(OsmWay.name) private readonly wayModel: Model<OsmWay>,
    @InjectModel(OsmNode.name) private readonly nodeModel: Model<OsmNode>,
    @InjectModel(OsmImport.name) private readonly importModel: Model<OsmImport>,
    @InjectModel(GraphMeta.name) private readonly metaModel: Model<GraphMeta>,
  ) {}

  /**
   * Aplica un import con reemplazo por way: escribe cada way completo (los
   * repetidos entre teselas se sobrescriben con el mismo contenido) y borra
   * los ways guardados con un nodo dentro del bbox que Overpass ya no devuelve.
   */
  async applyImport(
    bbox: BoundingBox,
    parsed: ParsedOsm,
    meta: { source: string; server?: string; startedAt: Date },
  ): Promise<ApplyImportResult> {
    const coords = new Map(parsed.nodes.map((n) => [n.osmId, n]));
    const incomingIds = new Set(parsed.ways.map((w) => w.osmWayId));

    // Candidatos a borrar: ways guardados cuyo rectángulo se cruza con el bbox.
    const candidates = await this.wayModel
      .find(
        {
          'bbox.minLat': { $lte: bbox.north },
          'bbox.maxLat': { $gte: bbox.south },
          'bbox.minLon': { $lte: bbox.east },
          'bbox.maxLon': { $gte: bbox.west },
        },
        { _id: 0, osmWayId: 1, nodeIds: 1 },
      )
      .lean()
      .exec();
    const absent = candidates.filter((c) => !incomingIds.has(c.osmWayId));
    const absentCoords = await this.coordsOf([...new Set(absent.flatMap((c) => c.nodeIds))]);
    const existing: ExistingWayRef[] = absent.map((c) => ({
      osmWayId: c.osmWayId,
      hasNodeInBbox: c.nodeIds.some((id) => {
        const p = absentCoords.get(id);
        return !!p && inBbox(p.lat, p.lon, bbox);
      }),
    }));
    const plan = planReplacement(parsed.ways, existing);

    for (const batch of chunks(parsed.nodes, BATCH)) {
      await this.nodeModel.bulkWrite(
        batch.map((n) => ({
          updateOne: {
            filter: { osmId: n.osmId },
            update: { $set: { osmId: n.osmId, lat: n.lat, lon: n.lon, location: { type: 'Point', coordinates: [n.lon, n.lat] } } },
            upsert: true,
          },
        })),
        { ordered: false },
      );
    }
    const importedAt = new Date();
    for (const batch of chunks(plan.upserts, BATCH)) {
      await this.wayModel.bulkWrite(
        batch.map((w) => ({
          replaceOne: {
            filter: { osmWayId: w.osmWayId },
            replacement: { osmWayId: w.osmWayId, nodeIds: w.nodeIds, tags: w.tags, bbox: wayBbox(w.nodeIds, (id) => coords.get(id)), importedAt },
            upsert: true,
          },
        })),
        { ordered: false },
      );
    }
    if (plan.deletes.length > 0) {
      await this.wayModel.deleteMany({ osmWayId: { $in: plan.deletes } }).exec();
      this.logger.log(`Ways borrados (ya no están en OSM o dejaron de ser viales): ${plan.deletes.length}`);
    }

    const metaDoc = await this.metaModel
      .findOneAndUpdate({ _id: 'graph' }, { $inc: { dataVersion: 1 }, $set: { updatedAt: new Date() } }, { upsert: true, new: true })
      .lean()
      .exec();
    const dataVersion = metaDoc?.dataVersion ?? 0;

    await this.importModel.create({
      bbox: { south: bbox.south, west: bbox.west, north: bbox.north, east: bbox.east },
      source: meta.source,
      server: meta.server,
      startedAt: meta.startedAt,
      finishedAt: new Date(),
      ways: plan.upserts.length,
      nodes: parsed.nodes.length,
      deletedWays: plan.deletes.length,
      dataVersion,
    });

    return { ways: plan.upserts.length, nodes: parsed.nodes.length, deletedWays: plan.deletes.length, dataVersion };
  }

  /** Todos los ways y las coordenadas de sus nodos (para derivar el grafo). */
  async loadAll(): Promise<{ ways: RawWay[]; coords: Map<string, { lat: number; lon: number }> }> {
    const [wayDocs, nodeDocs] = await Promise.all([
      this.wayModel.find({}, { _id: 0, osmWayId: 1, nodeIds: 1, tags: 1 }).lean().exec(),
      this.nodeModel.find({}, { _id: 0, osmId: 1, lat: 1, lon: 1 }).lean().exec(),
    ]);
    const coords = new Map<string, { lat: number; lon: number }>();
    for (const n of nodeDocs) coords.set(n.osmId, { lat: n.lat, lon: n.lon });
    const ways: RawWay[] = wayDocs.map((w) => ({ osmWayId: w.osmWayId, nodeIds: w.nodeIds, tags: w.tags ?? {} }));
    return { ways, coords };
  }

  /** IDs de los nodos más cercanos (orden por distancia), dentro de 5 km. */
  async findNearestNodeIds(lat: number, lon: number, limit: number): Promise<string[]> {
    const docs = await this.nodeModel
      .find(
        { location: { $near: { $geometry: { type: 'Point', coordinates: [lon, lat] }, $maxDistance: 5000 } } },
        { _id: 0, osmId: 1 },
      )
      .limit(limit)
      .lean()
      .exec();
    return docs.map((d) => d.osmId);
  }

  async dataVersion(): Promise<number> {
    const doc = await this.metaModel.findById('graph').lean().exec();
    return doc?.dataVersion ?? 0;
  }

  private async coordsOf(ids: string[]): Promise<Map<string, { lat: number; lon: number }>> {
    const out = new Map<string, { lat: number; lon: number }>();
    for (const batch of chunks(ids, 5000)) {
      const docs = await this.nodeModel.find({ osmId: { $in: batch } }, { _id: 0, osmId: 1, lat: 1, lon: 1 }).lean().exec();
      for (const d of docs) out.set(d.osmId, { lat: d.lat, lon: d.lon });
    }
    return out;
  }
}
