import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';

export type EdgeDocument = HydratedDocument<Edge>;

@Schema()
export class Edge {
  @Prop()
  osmWayId: string;

  @Prop({ required: true, index: true })
  fromOsmId: string;

  @Prop({ required: true, index: true })
  toOsmId: string;

  @Prop({ default: 0 })
  distanceMeters: number;

  @Prop({ default: 0 })
  curviness: number;

  @Prop({ default: 0 })
  elevationGain: number;

  @Prop({ default: 0 })
  elevationLoss: number;

  @Prop({ default: 'residential' })
  highwayType: string;

  @Prop({ default: 'unknown' })
  surface: string;

  @Prop({ default: 'intermediate' })
  smoothness: string;
}

export const EdgeSchema = SchemaFactory.createForClass(Edge);
// Una arista queda unívocamente identificada por (way, from, to).
EdgeSchema.index({ fromOsmId: 1, toOsmId: 1, osmWayId: 1 }, { unique: true });
