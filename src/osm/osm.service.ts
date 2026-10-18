import {
  Injectable,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import { BoundingBox, OverpassResponse } from './osm.types';

const OVERPASS_SERVERS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
  'https://maps.mail.ru/osm/tools/overpass/api/interpreter',
];

@Injectable()
export class OsmService {
  private readonly logger = new Logger(OsmService.name);

  /** Descarga todas las vías vehiculares dentro del bounding box. */
  async fetchRoads(bbox: BoundingBox): Promise<OverpassResponse> {
    const query = this.buildQuery(bbox);
    let lastError: unknown;

    for (const server of OVERPASS_SERVERS) {
      try {
        this.logger.log(`Consultando Overpass: ${server}`);
        const res = await fetch(server, {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: 'data=' + encodeURIComponent(query),
        });
        if (!res.ok) {
          throw new Error(`HTTP ${res.status} ${res.statusText}`);
        }
        const data = (await res.json()) as OverpassResponse;
        this.logger.log(
          `Overpass OK: ${data.elements?.length ?? 0} elementos.`,
        );
        return data;
      } catch (err) {
        lastError = err;
        this.logger.warn(
          `Falló ${server}: ${err instanceof Error ? err.message : err}`,
        );
      }
    }

    throw new ServiceUnavailableException(
      `Todos los servidores Overpass fallaron. Último error: ${
        lastError instanceof Error ? lastError.message : lastError
      }`,
    );
  }

  /**
   * El regex de highway debe ir en UNA sola línea: un salto de línea dentro de
   * la expresión de Overpass rompe la query.
   */
  private buildQuery(bbox: BoundingBox): string {
    const { south, west, north, east } = bbox;
    const highways =
      'motorway|trunk|primary|secondary|tertiary|unclassified|residential|track|service';
    return `[out:json][timeout:60];
(
  way["highway"~"^(${highways})$"](${south},${west},${north},${east});
);
out body;
>;
out skel qt;`;
  }
}
