export interface OsmNodeElement {
  type: 'node';
  id: number;
  lat: number;
  lon: number;
}

export interface OsmWayElement {
  type: 'way';
  id: number;
  nodes: number[];
  tags?: Record<string, string>;
}

export type OsmElement = OsmNodeElement | OsmWayElement | { type: string };

export interface OverpassResponse {
  elements: OsmElement[];
}

export interface BoundingBox {
  south: number;
  west: number;
  north: number;
  east: number;
}
