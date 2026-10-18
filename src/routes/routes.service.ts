import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { dijkstra, dijkstraMultiSource } from '../dijkstra/dijkstra';
import { RouteWeights } from '../dijkstra/cost';
import { Graph, RouteResult } from '../dijkstra/types';
import { bearing } from '../osm/osm.parser';
import { GraphService } from '../graph/graph.service';
import { CalculateRouteDto, TripLength } from './dto/calculate-route.dto';
import { PROFILES } from './profiles';

// Amplitud del arco (desvío lateral de los waypoints) como fracción de la
// distancia de la ruta directa.
const TRIP_OFFSET: Record<TripLength, number> = {
  direct: 0,
  short: 0.18,
  medium: 0.38,
  long: 0.65,
};

@Injectable()
export class RoutesService {
  constructor(private readonly graphService: GraphService) {}

  async calculate(dto: CalculateRouteDto): Promise<RouteResult> {
    const weights = this.resolveWeights(dto);
    const tripLength: TripLength = dto.tripLength ?? 'direct';

    const graph = await this.graphService.getGraph();
    if (graph.nodes.size === 0) {
      throw new BadRequestException(
        'El grafo está vacío. Importá una zona con POST /import primero.',
      );
    }

    // Varios nodos candidatos por punto: el snap a uno solo cae mal en
    // autopistas divididas y produce rodeos absurdos.
    const K = 6;
    const [startCandidates, endCandidates] = await Promise.all([
      this.graphService.findNearestNodes(dto.origin.lat, dto.origin.lon, K),
      this.graphService.findNearestNodes(dto.destination.lat, dto.destination.lon, K),
    ]);
    if (startCandidates.length === 0 || endCandidates.length === 0) {
      throw new NotFoundException(
        'No hay nodos cercanos al origen o destino (¿importaste esa zona?)',
      );
    }

    // La ruta directa elige la mejor combinación origen/destino entre candidatos.
    const direct = dijkstraMultiSource(
      graph,
      startCandidates,
      endCandidates,
      weights,
    );
    if (!direct || direct.path.length < 2) {
      throw new BadRequestException(
        'Origen y destino quedaron sobre el mismo punto del grafo (ruta de 0 km). ' +
          'Elegí puntos más separados y dentro de la zona que importaste.',
      );
    }
    if (tripLength === 'direct') return direct;

    // Para la vuelta usamos los nodos elegidos por la ruta directa.
    const startId = direct.path[0];
    const endId = direct.path[direct.path.length - 1];
    const detour = await this.routeWithDetour(
      graph,
      startId,
      endId,
      weights,
      tripLength,
      direct.stats.distanceMeters,
    );
    return detour ?? direct;
  }

  /**
   * Genera una "vuelta" más larga insertando un waypoint desviado
   * perpendicularmente a la línea origen-destino. A mayor nivel, mayor desvío.
   * Prueba ambos lados y escalas decrecientes hasta encontrar caminos reales.
   */
  private async routeWithDetour(
    graph: Graph,
    startId: string,
    endId: string,
    weights: RouteWeights,
    tripLength: TripLength,
    directRouteDist: number,
  ): Promise<RouteResult | null> {
    const start = graph.nodes.get(startId)!;
    const end = graph.nodes.get(endId)!;
    // El desvío escala con el largo de la ruta directa (no la línea recta).
    const baseOffset = TRIP_OFFSET[tripLength] * directRouteDist;
    if (baseOffset <= 0) return null;

    const lineBearing = bearing(start.lat, start.lon, end.lat, end.lon);

    let best: RouteResult | null = null;
    // Escalas decrecientes: si no hay caminos tan lejos, prueba más cerca.
    for (const scale of [1, 0.6, 0.35]) {
      for (const side of [1, -1]) {
        const off = baseOffset * scale;
        // Dos waypoints que AVANZAN hacia el destino (en 0.35 y 0.65 del trayecto),
        // desviados al mismo lado → forman un arco, no un pincho lateral.
        const w1 = offsetAlong(start, end, 0.35, lineBearing + 90 * side, off);
        const w2 = offsetAlong(start, end, 0.65, lineBearing + 90 * side, off);
        let id1: string;
        let id2: string;
        try {
          id1 = await this.graphService.findNearestNode(w1.lat, w1.lon);
          id2 = await this.graphService.findNearestNode(w2.lat, w2.lon);
        } catch {
          continue; // no hay caminos cerca de esos puntos
        }

        const route = this.routeThrough(graph, [startId, id1, id2, endId], weights);
        // Nos quedamos con la vuelta más larga que sea válida.
        if (route && (!best || route.stats.distanceMeters > best.stats.distanceMeters)) {
          best = route;
        }
      }
      if (best) break;
    }
    return best;
  }

  /**
   * Rutea pasando por una secuencia de nodos y une los tramos. Cada tramo evita
   * los nodos ya usados por los anteriores (anti-retroceso) para que la vuelta
   * sea un circuito y no un ida-y-vuelta por la misma calle.
   */
  private routeThrough(
    graph: Graph,
    ids: string[],
    weights: RouteWeights,
  ): RouteResult | null {
    const avoid = new Set<string>();
    let merged: RouteResult | null = null;
    for (let i = 0; i < ids.length - 1; i++) {
      const from = ids[i];
      const to = ids[i + 1];
      if (from === to) continue; // waypoints que colapsaron al mismo nodo
      const leg = dijkstra(graph, from, to, weights, { avoidNodes: avoid });
      if (!leg) return null;
      for (const n of leg.path) avoid.add(n);
      merged = merged ? mergeRoutes(merged, leg) : leg;
    }
    return merged;
  }

  private resolveWeights(dto: CalculateRouteDto): RouteWeights {
    if (dto.profile === 'custom') {
      if (!dto.customWeights) {
        throw new BadRequestException(
          'El perfil "custom" requiere el campo customWeights',
        );
      }
      return dto.customWeights;
    }
    return PROFILES[dto.profile];
  }
}

/**
 * Punto a fracción `f` del trayecto start→end, desplazado `dist` metros en el
 * rumbo dado (para colocar un waypoint "adelantado y al costado").
 */
function offsetAlong(
  start: { lat: number; lon: number },
  end: { lat: number; lon: number },
  f: number,
  bearingDeg: number,
  dist: number,
): { lat: number; lon: number } {
  const baseLat = start.lat + f * (end.lat - start.lat);
  const baseLon = start.lon + f * (end.lon - start.lon);
  return destinationPoint(baseLat, baseLon, bearingDeg, dist);
}

/** Punto destino a `distMeters` desde (lat,lon) siguiendo un rumbo. */
function destinationPoint(
  lat: number,
  lon: number,
  bearingDeg: number,
  distMeters: number,
): { lat: number; lon: number } {
  const R = 6371000;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const toDeg = (r: number) => (r * 180) / Math.PI;
  const δ = distMeters / R;
  const θ = toRad(bearingDeg);
  const φ1 = toRad(lat);
  const λ1 = toRad(lon);
  const φ2 = Math.asin(
    Math.sin(φ1) * Math.cos(δ) + Math.cos(φ1) * Math.sin(δ) * Math.cos(θ),
  );
  const λ2 =
    λ1 +
    Math.atan2(
      Math.sin(θ) * Math.sin(δ) * Math.cos(φ1),
      Math.cos(δ) - Math.sin(φ1) * Math.sin(φ2),
    );
  return { lat: toDeg(φ2), lon: ((toDeg(λ2) + 540) % 360) - 180 };
}

/** Une dos tramos de ruta (a luego b) en un solo RouteResult. */
function mergeRoutes(a: RouteResult, b: RouteResult): RouteResult {
  const path = a.path.concat(b.path.slice(1));
  const coordinates = a.coordinates.concat(b.coordinates.slice(1));

  const sumBreakdown = (
    x: Record<string, number>,
    y: Record<string, number>,
  ): Record<string, number> => {
    const out: Record<string, number> = { ...x };
    for (const [k, v] of Object.entries(y)) out[k] = (out[k] ?? 0) + v;
    return out;
  };

  const distA = a.stats.distanceMeters;
  const distB = b.stats.distanceMeters;
  const totalDist = distA + distB;
  const curviness =
    totalDist > 0
      ? (a.stats.curviness * distA + b.stats.curviness * distB) / totalDist
      : 0;

  return {
    path,
    coordinates,
    totalCost: a.totalCost + b.totalCost,
    stats: {
      distanceMeters: totalDist,
      elevationGainMeters:
        a.stats.elevationGainMeters + b.stats.elevationGainMeters,
      elevationLossMeters:
        a.stats.elevationLossMeters + b.stats.elevationLossMeters,
      curviness,
      highwayBreakdown: sumBreakdown(
        a.stats.highwayBreakdown,
        b.stats.highwayBreakdown,
      ),
      surfaceBreakdown: sumBreakdown(
        a.stats.surfaceBreakdown,
        b.stats.surfaceBreakdown,
      ),
    },
  };
}
