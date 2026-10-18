import { BadRequestException, Injectable } from '@nestjs/common';
import { DetourInfo, constrainedRoute } from '../dijkstra/constrained';
import { Endpoint, EngineRoute } from '../dijkstra/dijkstra';
import { RouteWeights } from '../dijkstra/cost';
import { RouteResult } from '../dijkstra/types';
import { SNAP_K, SnapCandidate } from '../dijkstra/snap';
import { GraphService } from '../graph/graph.service';
import { CalculateRouteDto } from './dto/calculate-route.dto';
import { PROFILES, PROFILE_DETOUR_BUDGET } from './profiles';

/**
 * Respuesta de la API. Desde F0.6 no lleva desnivel (no hay datos de elevación;
 * fuera del alcance de la tesis) ni existe la "vuelta" de `tripLength`.
 */
export type RouteResponse = RouteResult & {
  /**
   * Ajuste del snap (D17): punto de la vía donde empieza/termina la ruta y su
   * distancia al punto pedido. El snap falla si supera 1 km.
   */
  snap: { origin: SnapInfo; destination: SnapInfo };
  /** Presupuesto de desvío (F4): cuánto se alargó la ruta respecto de la más corta. */
  detour: DetourResponse;
};

export interface SnapInfo {
  distanceMeters: number;
  lat: number;
  lon: number;
}

export interface DetourResponse {
  /** Distancia de la ruta más corta entre los mismos puntos (m). */
  shortestDistanceMeters: number;
  /** Largo de la ruta / distancia más corta. */
  detourRatio: number;
  /** Presupuesto aplicado (el del perfil o el pedido). */
  maxDetourRatio: number;
  /** true si el presupuesto cambió la ruta respecto de la óptima sin límite. */
  binding: boolean;
  /** Multiplicador de LARAC (0 si el presupuesto no ata). */
  lambda: number;
  /** Brecha relativa con la cota inferior de Lagrange (0 si el presupuesto no ata). */
  gap: number;
}

function snapInfo(ep: Endpoint | undefined): SnapInfo {
  const c = ep as SnapCandidate | undefined;
  return c && 'dist' in c
    ? { distanceMeters: Math.round(c.dist * 10) / 10, lat: c.lat, lon: c.lon }
    : { distanceMeters: 0, lat: NaN, lon: NaN };
}

function detourResponse(d: DetourInfo): DetourResponse {
  const r4 = (x: number) => Math.round(x * 1e4) / 1e4;
  return {
    shortestDistanceMeters: Math.round(d.shortestMeters * 10) / 10,
    detourRatio: r4(d.detourRatio),
    maxDetourRatio: d.maxDetourRatio,
    binding: d.binding,
    lambda: r4(d.lambda),
    gap: r4(d.gap),
  };
}

@Injectable()
export class RoutesService {
  constructor(private readonly graphService: GraphService) {}

  async calculate(dto: CalculateRouteDto): Promise<RouteResponse> {
    const { route, detour } = await this.calculateRoute(dto);
    // nodeIdx/edgeIdx/tramos/sums son internos del motor: no salen en la API.
    const { nodeIdx: _n, edgeIdx: _e, tramos: _t, sums: _s, origin, dest, ...result } = route;
    return { ...result, snap: { origin: snapInfo(origin), destination: snapInfo(dest) }, detour: detourResponse(detour) };
  }

  private async calculateRoute(dto: CalculateRouteDto): Promise<{ route: EngineRoute; detour: DetourInfo }> {
    const weights = this.resolveWeights(dto);
    const maxDetourRatio = dto.maxDetourRatio ?? PROFILE_DETOUR_BUDGET[dto.profile];

    const graph = await this.graphService.getGraph();
    if (graph.meta.nodeCount === 0) {
      throw new BadRequestException(
        'El grafo está vacío. Importá una zona con POST /import primero.',
      );
    }

    // Snap con nodos fantasma sobre varios tramos candidatos por punto: el
    // snap a uno solo cae mal en autopistas divididas y produce rodeos
    // absurdos. Solo tramos de la componente fuertemente conexa mayor (D15);
    // si no hay, snap() responde 'fuera de la red conectada' o 'no hay vías'.
    const [startCandidates, endCandidates] = await Promise.all([
      this.graphService.snap(dto.origin.lat, dto.origin.lon, SNAP_K),
      this.graphService.snap(dto.destination.lat, dto.destination.lon, SNAP_K),
    ]);

    // La mejor combinación origen/destino entre candidatos, con el presupuesto
    // de desvío (LARAC sobre A*, F4).
    const res = constrainedRoute(graph, startCandidates, endCandidates, weights, maxDetourRatio);
    if (!res) {
      // Con ambos extremos en la CFC mayor solo pasa si las vías privadas (D7)
      // impiden el paso: p. ej. un destino al que solo se llega cruzando otra
      // propiedad privada.
      throw new BadRequestException(
        'No hay camino entre el origen y el destino sin pasar por vías privadas.',
      );
    }
    if (res.route.path.length < 2) {
      throw new BadRequestException(
        'Origen y destino quedaron sobre el mismo punto del grafo (ruta de 0 km). ' +
          'Elegí puntos más separados y dentro de la zona que importaste.',
      );
    }
    return res;
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
