import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';

export type NodeDocument = HydratedDocument<Node>;

// GeoJSON Point: las coordenadas se guardan como [lon, lat] (orden GeoJSON).
@Schema({ _id: false })
export class GeoPoint {
  @Prop({ type: String, enum: ['Point'], default: 'Point' })
  type: 'Point';

  @Prop({ type: [Number], required: true })
  coordinates: [number, number];
}
const GeoPointSchema = SchemaFactory.createForClass(GeoPoint);

@Schema()
export class Node {
  @Prop({ required: true, unique: true, index: true })
  osmId: string;

  @Prop({ required: true })
  lat: number;

  @Prop({ required: true })
  lon: number;

  @Prop({ default: 0 })
  elevation: number;

  @Prop({ type: GeoPointSchema, required: true })
  location: GeoPoint;
}

export const NodeSchema = SchemaFactory.createForClass(Node);
NodeSchema.index({ location: '2dsphere' });
