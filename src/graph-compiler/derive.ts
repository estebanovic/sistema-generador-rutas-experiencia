import { GraphEdge, GraphNode } from '../dijkstra/types';
import { computeSegmentCurviness } from './curviness';
import { haversine } from './geo';
import {
  ALL_EXCLUSION_RULES,
  ExclusionRule,
  exclusionReason,
  isDestinationOnly,
  parseHighway,
  parseOneway,
  parseSmoothness,
  parseSurface,
} from './normalize';
import { RawWay } from './raw';

export type DerivedEdge = GraphEdge & { osmWayId: string };

export interface DeriveStats {
  waysIn: number;
  waysUsed: number;
  /** Ways y km (largo del way, no por sentido) excluidos por cada regla. */
  excluded: Partial<Record<ExclusionRule, { ways: number; km: number }>>;
  /** Referencias a nodos que no están en el almacén (se saltan). */
  missingNodeRefs: number;
  /** Ways y km incluidos como solo-origen/destino (acceso privado). */
  destinationOnly: { ways: number; km: number };
}

export interface DerivedGraph {
  nodes: GraphNode[];
  edges: DerivedEdge[];
  stats: DeriveStats;
}

export interface DeriveOptions {
  /** Reglas de exclusión activas (por defecto, todas). */
  rules?: ReadonlySet<ExclusionRule>;
}

/**
 * Deriva el grafo de segmentos (una arista por par de nodos consecutivos de
 * cada way, en los sentidos permitidos) a partir de los ways crudos.
 *
 * El largo de cada arista se calcula desde las coordenadas ACTUALES de sus
 * nodos, así que por construcción vale `L == haversine(extremos)`: no puede
 * haber aristas obsoletas como las que dejaba el upsert de `edges`.
 * No hay elevación: elevationGain/Loss quedan en 0.
 */
export function deriveGraph(
  ways: Iterable<RawWay>,
  coordsOf: (osmId: string) => { lat: number; lon: number } | undefined,
  options: DeriveOptions = {},
): DerivedGraph {
  const rules = options.rules ?? new Set(ALL_EXCLUSION_RULES);
  const stats: DeriveStats = { waysIn: 0, waysUsed: 0, excluded: {}, missingNodeRefs: 0, destinationOnly: { ways: 0, km: 0 } };
  const edges: DerivedEdge[] = [];
  const used = new Map<string, GraphNode>();
  const seen = new Set<string>();

  for (const way of ways) {
    stats.waysIn++;
    const coords: { osmId: string; lat: number; lon: number }[] = [];
    for (const id of way.nodeIds) {
      const c = coordsOf(id);
      if (c) coords.push({ osmId: id, lat: c.lat, lon: c.lon });
      else stats.missingNodeRefs++;
    }

    const reason = exclusionReason(way.tags);
    if (reason && rules.has(reason)) {
      const ex = (stats.excluded[reason] ??= { ways: 0, km: 0 });
      ex.ways++;
      for (let i = 0; i < coords.length - 1; i++) {
        ex.km += haversine(coords[i].lat, coords[i].lon, coords[i + 1].lat, coords[i + 1].lon) / 1000;
      }
      continue;
    }
    if (coords.length < 2) continue;
    stats.waysUsed++;

    const highwayType = parseHighway(way.tags.highway);
    const surface = parseSurface(way.tags.surface);
    const smoothness = parseSmoothness(way.tags.smoothness);
    const oneway = parseOneway(way.tags);
    const destinationOnly = isDestinationOnly(way.tags);
    if (destinationOnly) stats.destinationOnly.ways++;
    const segCurviness = computeSegmentCurviness(coords);

    const push = (a: (typeof coords)[number], b: (typeof coords)[number], distance: number, curviness: number) => {
      const key = `${a.osmId}|${b.osmId}|${way.osmWayId}`;
      if (seen.has(key)) return;
      seen.add(key);
      edges.push({
        fromOsmId: a.osmId,
        toOsmId: b.osmId,
        distanceMeters: distance,
        curviness,
        elevationGain: 0,
        elevationLoss: 0,
        highwayType,
        surface,
        smoothness,
        ...(destinationOnly ? { destinationOnly: true } : {}),
        osmWayId: way.osmWayId,
      });
    };

    for (let i = 0; i < coords.length - 1; i++) {
      const a = coords[i];
      const b = coords[i + 1];
      const distance = haversine(a.lat, a.lon, b.lat, b.lon);
      if (distance <= 0) continue;
      if (destinationOnly) stats.destinationOnly.km += distance / 1000;
      if (!used.has(a.osmId)) used.set(a.osmId, { osmId: a.osmId, lat: a.lat, lon: a.lon, elevation: 0 });
      if (!used.has(b.osmId)) used.set(b.osmId, { osmId: b.osmId, lat: b.lat, lon: b.lon, elevation: 0 });
      if (oneway !== 'backward') push(a, b, distance, segCurviness[i]);
      if (oneway !== 'forward') push(b, a, distance, segCurviness[i]);
    }
  }

  return { nodes: [...used.values()], edges, stats };
}
