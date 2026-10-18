import { BadRequestException, Injectable } from '@nestjs/common';
import { Endpoint, EngineRoute, dijkstraMultiSource } from '../dijkstra/dijkstra';
import { RouteWeights } from '../dijkstra/cost';
import { RouteResult } from '../dijkstra/types';
import { SnapCandidate } from '../dijkstra/snap';
import { GraphService } from '../graph/graph.service';
import { CalculateRouteDto } from './dto/calculate-route.dto';
import { PROFILES } from './profiles';

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
};

export interface SnapInfo {
  distanceMeters: number;
  lat: number;
  lon: number;
}

function snapInfo(ep: Endpoint | undefined): SnapInfo {
  const c = ep as SnapCandidate | undefined;
  return c && 'dist' in c
    ? { distanceMeters: Math.round(c.dist * 10) / 10, lat: c.lat, lon: c.lon }
    : { distanceMeters: 0, lat: NaN, lon: NaN };
}

@Injectable()
export class RoutesService {
  constructor(private readonly graphService: GraphService) {}

  async calculate(dto: CalculateRouteDto): Promise<RouteResponse> {
    // nodeIdx/edgeIdx/tramos son internos del motor: no salen en la API.
    const { nodeIdx: _n, edgeIdx: _e, tramos: _t, origin, dest, ...result } = await this.calculateRoute(dto);
    return { ...result, snap: { origin: snapInfo(origin), destination: snapInfo(dest) } };
  }

  private async calculateRoute(dto: CalculateRouteDto): Promise<EngineRoute> {
    const weights = this.resolveWeights(dto);

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
    const K = 6;
    const [startCandidates, endCandidates] = await Promise.all([
      this.graphService.snap(dto.origin.lat, dto.origin.lon, K),
      this.graphService.snap(dto.destination.lat, dto.destination.lon, K),
    ]);

    // Elige la mejor combinación origen/destino entre candidatos.
    const route = dijkstraMultiSource(graph, startCandidates, endCandidates, weights);
    if (!route) {
      // Con ambos extremos en la CFC mayor solo pasa si las vías privadas (D7)
      // impiden el paso: p. ej. un destino al que solo se llega cruzando otra
      // propiedad privada.
      throw new BadRequestException(
        'No hay camino entre el origen y el destino sin pasar por vías privadas.',
      );
    }
    if (route.path.length < 2) {
      throw new BadRequestException(
        'Origen y destino quedaron sobre el mismo punto del grafo (ruta de 0 km). ' +
          'Elegí puntos más separados y dentro de la zona que importaste.',
      );
    }
    return route;
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
