import { Injectable } from '@nestjs/common';
import {
  GraphEdge,
  GraphNode,
  HighwayType,
  SmoothnessType,
  SurfaceType,
} from '../dijkstra/types';
import {
  OsmNodeElement,
  OsmWayElement,
  OverpassResponse,
} from './osm.types';

// Una arista lleva además el way de origen para identificarla en Mongo.
export type ParsedEdge = GraphEdge & { osmWayId: string };

export interface ParsedGraph {
  nodes: GraphNode[];
  edges: ParsedEdge[];
}

const HIGHWAY_VALUES: ReadonlySet<HighwayType> = new Set([
  'motorway',
  'trunk',
  'primary',
  'secondary',
  'tertiary',
  'unclassified',
  'residential',
  'track',
  'path',
  'service',
]);

const SURFACE_VALUES: ReadonlySet<SurfaceType> = new Set([
  'asphalt',
  'concrete',
  'gravel',
  'dirt',
  'sand',
  'cobblestone',
  'unknown',
]);

const SMOOTHNESS_VALUES: ReadonlySet<SmoothnessType> = new Set([
  'excellent',
  'good',
  'intermediate',
  'bad',
  'very_bad',
  'impassable',
]);

@Injectable()
export class OsmParser {
  parse(data: OverpassResponse): ParsedGraph {
    const osmNodes = new Map<number, OsmNodeElement>();
    const ways: OsmWayElement[] = [];

    for (const el of data.elements ?? []) {
      if (el.type === 'node') {
        osmNodes.set((el as OsmNodeElement).id, el as OsmNodeElement);
      } else if (el.type === 'way') {
        ways.push(el as OsmWayElement);
      }
    }

    // Solo conservamos los nodos efectivamente usados por alguna vía.
    const usedNodeIds = new Set<number>();
    const edges: ParsedEdge[] = [];
    // Una misma (from,to,way) no debe duplicarse.
    const seenEdges = new Set<string>();

    for (const way of ways) {
      const nodeIds = way.nodes ?? [];
      if (nodeIds.length < 2) continue;

      const coords = nodeIds
        .map((id) => osmNodes.get(id))
        .filter((n): n is OsmNodeElement => !!n);
      if (coords.length < 2) continue;

      const tags = way.tags ?? {};
      const highwayType = this.parseHighway(tags.highway);
      const surface = this.parseSurface(tags.surface);
      const smoothness = this.parseSmoothness(tags.smoothness);
      // Sinuosidad local por segmento, según el giro real (°/km).
      const segCurviness = this.computeSegmentCurviness(coords);
      const oneway = this.parseOneway(tags, highwayType);

      for (let i = 0; i < coords.length - 1; i++) {
        const a = coords[i];
        const b = coords[i + 1];
        const distance = haversine(a.lat, a.lon, b.lat, b.lon);
        if (distance <= 0) continue;
        const curviness = segCurviness[i];

        usedNodeIds.add(a.id);
        usedNodeIds.add(b.id);

        const wayId = String(way.id);
        // oneway: 'forward' | 'backward' | 'no'
        if (oneway !== 'backward') {
          this.pushEdge(edges, seenEdges, {
            fromOsmId: String(a.id),
            toOsmId: String(b.id),
            distanceMeters: distance,
            curviness,
            elevationGain: 0,
            elevationLoss: 0,
            highwayType,
            surface,
            smoothness,
            osmWayId: wayId,
          });
        }
        if (oneway === 'no' || oneway === 'backward') {
          this.pushEdge(edges, seenEdges, {
            fromOsmId: String(b.id),
            toOsmId: String(a.id),
            distanceMeters: distance,
            curviness,
            elevationGain: 0,
            elevationLoss: 0,
            highwayType,
            surface,
            smoothness,
            osmWayId: wayId,
          });
        }
      }
    }

    const nodes: GraphNode[] = [];
    for (const id of usedNodeIds) {
      const n = osmNodes.get(id)!;
      nodes.push({
        osmId: String(n.id),
        lat: n.lat,
        lon: n.lon,
        elevation: 0,
      });
    }

    return { nodes, edges };
  }

  private pushEdge(
    edges: ParsedEdge[],
    seen: Set<string>,
    edge: ParsedEdge,
  ): void {
    const key = `${edge.fromOsmId}|${edge.toOsmId}|${edge.osmWayId}`;
    if (seen.has(key)) return;
    seen.add(key);
    edges.push(edge);
  }

  /**
   * Sinuosidad LOCAL por segmento, basada en el giro real del camino.
   *
   * Para cada segmento medimos cuántos grados gira la traza por kilómetro
   * (densidad de giro). Una recta gira ~0°/km; un camino de curvas, decenas;
   * una horquilla, cientos. Esto captura la "experiencia de manejo" mucho
   * mejor que el ratio distancia-directa/largo (que daba ~0 en caminos rurales
   * digitalizados como una sola vía casi recta).
   *
   * Mapeo a [0,1]: ~10°/km → 0 (recto), ~130°/km → 1 (muy sinuoso).
   */
  private computeSegmentCurviness(coords: OsmNodeElement[]): number[] {
    const n = coords.length;
    const result = new Array(n - 1).fill(0);
    if (n < 3) return result; // un solo segmento: sin giro medible

    // Rumbo de cada segmento.
    const bearings: number[] = [];
    for (let i = 0; i < n - 1; i++) {
      bearings.push(
        bearing(coords[i].lat, coords[i].lon, coords[i + 1].lat, coords[i + 1].lon),
      );
    }

    for (let i = 0; i < n - 1; i++) {
      // Giro en el vértice de fin del segmento (entre este segmento y el
      // siguiente); el último segmento toma el giro de su vértice de inicio.
      let turnDeg: number;
      if (i < n - 2) turnDeg = angleDiff(bearings[i], bearings[i + 1]);
      else turnDeg = angleDiff(bearings[i - 1], bearings[i]);

      const segLenKm =
        haversine(
          coords[i].lat,
          coords[i].lon,
          coords[i + 1].lat,
          coords[i + 1].lon,
        ) / 1000;
      const degPerKm = segLenKm > 0 ? turnDeg / segLenKm : 0;
      result[i] = Math.min(1, Math.max(0, (degPerKm - 10) / 120));
    }
    return result;
  }

  private parseOneway(
    tags: Record<string, string>,
    highway: HighwayType,
  ): 'forward' | 'backward' | 'no' {
    const v = (tags.oneway ?? '').toLowerCase();
    if (v === 'yes' || v === 'true' || v === '1') return 'forward';
    if (v === '-1' || v === 'reverse') return 'backward';
    if (v === 'no' || v === 'false' || v === '0') return 'no';
    // Las autopistas suelen ser de un sentido aunque no esté etiquetado.
    if (highway === 'motorway') return 'forward';
    return 'no';
  }

  private parseHighway(value?: string): HighwayType {
    if (value && HIGHWAY_VALUES.has(value as HighwayType)) {
      return value as HighwayType;
    }
    return 'residential';
  }

  private parseSurface(value?: string): SurfaceType {
    if (!value) return 'unknown';
    if (SURFACE_VALUES.has(value as SurfaceType)) return value as SurfaceType;
    // Agrupamos variantes comunes de OSM.
    if (value.startsWith('paved') || value === 'paving_stones') return 'concrete';
    if (value === 'unpaved' || value === 'compacted' || value === 'fine_gravel')
      return 'gravel';
    if (value === 'ground' || value === 'earth' || value === 'mud') return 'dirt';
    return 'unknown';
  }

  private parseSmoothness(value?: string): SmoothnessType {
    if (value && SMOOTHNESS_VALUES.has(value as SmoothnessType)) {
      return value as SmoothnessType;
    }
    return 'intermediate';
  }
}

/** Rumbo inicial (grados, 0-360) del trayecto de (lat1,lon1) a (lat2,lon2). */
export function bearing(
  lat1: number,
  lon1: number,
  lat2: number,
  lon2: number,
): number {
  const toRad = (d: number) => (d * Math.PI) / 180;
  const φ1 = toRad(lat1);
  const φ2 = toRad(lat2);
  const Δλ = toRad(lon2 - lon1);
  const y = Math.sin(Δλ) * Math.cos(φ2);
  const x =
    Math.cos(φ1) * Math.sin(φ2) -
    Math.sin(φ1) * Math.cos(φ2) * Math.cos(Δλ);
  return ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360;
}

/** Diferencia angular mínima (0-180°) entre dos rumbos. */
export function angleDiff(b1: number, b2: number): number {
  const d = Math.abs(b1 - b2) % 360;
  return d > 180 ? 360 - d : d;
}

/** Distancia haversine en metros entre dos coordenadas. */
export function haversine(
  lat1: number,
  lon1: number,
  lat2: number,
  lon2: number,
): number {
  const R = 6371000; // radio terrestre en metros
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}
