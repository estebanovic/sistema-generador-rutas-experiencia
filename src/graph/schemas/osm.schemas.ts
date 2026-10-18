import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Schema as MongooseSchema } from 'mongoose';
import { GeoPoint } from './node.schema';

/**
 * Almacén canónico por way (F0.1). Convive con las colecciones anteriores
 * (`nodes`, `edges`), que quedan congeladas hasta el punto de control C0.
 */

@Schema({ _id: false })
export class WayBbox {
  @Prop({ required: true }) minLat: number;
  @Prop({ required: true }) minLon: number;
  @Prop({ required: true }) maxLat: number;
  @Prop({ required: true }) maxLon: number;
}
const WayBboxSchema = SchemaFactory.createForClass(WayBbox);

@Schema({ collection: 'osm_ways' })
export class OsmWay {
  @Prop({ required: true, unique: true, index: true })
  osmWayId: string;

  @Prop({ type: [String], required: true })
  nodeIds: string[];

  /** Tags crudos (ver STORED_TAGS); se normalizan al compilar. */
  @Prop({ type: MongooseSchema.Types.Mixed, default: {} })
  tags: Record<string, string>;

  @Prop({ type: WayBboxSchema, required: true })
  bbox: WayBbox;

  @Prop({ required: true })
  importedAt: Date;
}
export type OsmWayDocument = HydratedDocument<OsmWay>;
export const OsmWaySchema = SchemaFactory.createForClass(OsmWay);
OsmWaySchema.index({ 'bbox.minLat': 1, 'bbox.maxLat': 1, 'bbox.minLon': 1, 'bbox.maxLon': 1 });

@Schema({ collection: 'osm_nodes' })
export class OsmNode {
  @Prop({ required: true, unique: true, index: true })
  osmId: string;

  @Prop({ required: true }) lat: number;
  @Prop({ required: true }) lon: number;

  /** GeoJSON [lon, lat] para el snap con $near (hasta F0.3). */
  @Prop({ type: SchemaFactory.createForClass(GeoPoint), required: true })
  location: GeoPoint;
}
export type OsmNodeDocument = HydratedDocument<OsmNode>;
export const OsmNodeSchema = SchemaFactory.createForClass(OsmNode);
OsmNodeSchema.index({ location: '2dsphere' });

@Schema({ collection: 'osm_imports' })
export class OsmImport {
  @Prop({ type: MongooseSchema.Types.Mixed, required: true })
  bbox: { south: number; west: number; north: number; east: number };

  @Prop({ required: true }) source: string; // 'vista' | 'teselas'
  @Prop() server: string;
  @Prop({ required: true }) startedAt: Date;
  @Prop({ required: true }) finishedAt: Date;
  @Prop({ default: 0 }) ways: number;
  @Prop({ default: 0 }) nodes: number;
  @Prop({ default: 0 }) deletedWays: number;
  @Prop({ default: 0 }) dataVersion: number;
}
export type OsmImportDocument = HydratedDocument<OsmImport>;
export const OsmImportSchema = SchemaFactory.createForClass(OsmImport);

/** Documento único `{_id: 'graph'}` con la versión de los datos (la usa el snapshot en F0.2). */
@Schema({ collection: 'graph_meta' })
export class GraphMeta {
  @Prop({ type: String }) _id: string;
  @Prop({ default: 0 }) dataVersion: number;
  @Prop() updatedAt: Date;
}
export type GraphMetaDocument = HydratedDocument<GraphMeta>;
export const GraphMetaSchema = SchemaFactory.createForClass(GraphMeta);
