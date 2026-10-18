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
  | 'service'
  | 'living_street';

export type SurfaceType =
  | 'asphalt'
  | 'concrete'
  | 'gravel'
  | 'dirt'
  | 'sand'
  | 'cobblestone'
  | 'unknown';

export interface GraphNode {
  osmId: string;
  lat: number;
  lon: number;
}

export interface GraphEdge {
  fromOsmId: string;
  toOsmId: string;
  distanceMeters: number;
  /** Sinuosidad normalizada [0,1] que usa el costo (desde F0.4: clamp(°/km / 300)). */
  curviness: number;
  /** Densidad de giro en °/km (F0.4); ausente en las colecciones legacy. */
  curvatureDegPerKm?: number;
  highwayType: HighwayType;
  surface: SurfaceType;
  /**
   * Vía privada: solo puede usarse en el tramo inicial o final de una ruta
   * (salir de / llegar a un condominio o fundo), nunca como paso.
   */
  destinationOnly?: boolean;
}

export interface RouteStats {
  distanceMeters: number;
  /** Sinuosidad normalizada [0,1] media, ponderada por largo. */
  curviness: number;
  /** Densidad de giro media (°/km), ponderada por largo. */
  curvinessDegPerKm: number;
  /** Fracción de los metros con densidad ≥ 100 °/km (tramo curvo). */
  curvyShare: number;
  // Metros recorridos por cada tipo de vía / superficie (para gráficos).
  highwayBreakdown: Record<string, number>;
  surfaceBreakdown: Record<string, number>;
  /** Metros por procedencia de la superficie: declarada, tracktype, vecindad, tipo (F0.5). */
  surfaceSourceBreakdown: Record<string, number>;
}

export interface RouteResult {
  path: string[]; // lista de osmIds
  coordinates: [number, number][];
  totalCost: number;
  stats: RouteStats;
}
