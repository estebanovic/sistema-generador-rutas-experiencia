// COPIA CONGELADA de los tipos del grafo anteriores a F0 (oráculo de tests).
// Los tests convierten al formato nuevo/viejo según haga falta.

export type HighwayType =
  | 'motorway'
  | 'trunk'
  | 'primary'
  | 'secondary'
  | 'tertiary'
  | 'unclassified'
  | 'residential'
  | 'track'
  | 'path'
  | 'service';

export type SurfaceType =
  | 'asphalt'
  | 'concrete'
  | 'gravel'
  | 'dirt'
  | 'sand'
  | 'cobblestone'
  | 'unknown';

export type SmoothnessType =
  | 'excellent'
  | 'good'
  | 'intermediate'
  | 'bad'
  | 'very_bad'
  | 'impassable';

export interface GraphNode {
  osmId: string;
  lat: number;
  lon: number;
  elevation: number;
}

export interface GraphEdge {
  fromOsmId: string;
  toOsmId: string;
  distanceMeters: number;
  curviness: number; // 0-1, qué tan curva es la calle
  elevationGain: number;
  elevationLoss: number;
  highwayType: HighwayType;
  surface: SurfaceType;
  smoothness: SmoothnessType;
}

export interface Graph {
  nodes: Map<string, GraphNode>;
  adjacency: Map<string, GraphEdge[]>; // osmId → aristas salientes
}

export interface RouteStats {
  distanceMeters: number;
  elevationGainMeters: number;
  elevationLossMeters: number;
  curviness: number;
  // Metros recorridos por cada tipo de vía / superficie (para gráficos).
  highwayBreakdown: Record<string, number>;
  surfaceBreakdown: Record<string, number>;
}

export interface RouteResult {
  path: string[]; // lista de osmIds
  coordinates: [number, number][];
  totalCost: number;
  stats: RouteStats;
}
