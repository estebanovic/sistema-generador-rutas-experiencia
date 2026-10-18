import {
  Injectable,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import { OVERPASS_HIGHWAYS } from '../graph-compiler/normalize';
import { BoundingBox, OverpassResponse } from './osm.types';

const OVERPASS_SERVERS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
  'https://maps.mail.ru/osm/tools/overpass/api/interpreter',
];

// Sin User-Agent, overpass-api.de responde 406.
const USER_AGENT = 'generador-rutas/1.0';

export interface FetchOptions {
  /** Reintentos por servidor ante límite de uso o timeout (por defecto 1). */
  retries?: number;
  /** Espera antes del primer reintento; se duplica en cada uno (por defecto 10 s). */
  baseDelayMs?: number;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Error transitorio: conviene esperar y reintentar en el mismo servidor. */
class RetryableError extends Error {}

@Injectable()
export class OsmService {
  private readonly logger = new Logger(OsmService.name);

  /**
   * Descarga los ways viales del bounding box, COMPLETOS: todos sus nodos,
   * aunque queden fuera del bbox (no se cortan en el borde).
   * Nunca devuelve una respuesta incompleta: si Overpass corta la consulta
   * (`remark`), se reintenta o se lanza error.
   */
  async fetchRoads(bbox: BoundingBox, options: FetchOptions = {}): Promise<OverpassResponse & { server: string }> {
    const retries = options.retries ?? 1;
    const baseDelayMs = options.baseDelayMs ?? 10_000;
    const query = this.buildQuery(bbox);
    let lastError: unknown;

    for (const server of OVERPASS_SERVERS) {
      for (let attempt = 0; attempt <= retries; attempt++) {
        if (attempt > 0) {
          const wait = baseDelayMs * 2 ** (attempt - 1);
          this.logger.warn(`Reintento ${attempt}/${retries} en ${server} tras ${Math.round(wait / 1000)} s`);
          await sleep(wait);
        }
        try {
          this.logger.log(`Consultando Overpass: ${server}`);
          const data = await this.request(server, query);
          this.logger.log(`Overpass OK: ${data.elements?.length ?? 0} elementos.`);
          return { ...data, server };
        } catch (err) {
          lastError = err;
          this.logger.warn(`Falló ${server}: ${err instanceof Error ? err.message : err}`);
          if (!(err instanceof RetryableError)) break; // error no transitorio: siguiente servidor
        }
      }
    }

    throw new ServiceUnavailableException(
      `Todos los servidores Overpass fallaron. Último error: ${
        lastError instanceof Error ? lastError.message : lastError
      }`,
    );
  }

  private async request(server: string, query: string): Promise<OverpassResponse> {
    const res = await fetch(server, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': USER_AGENT },
      body: 'data=' + encodeURIComponent(query),
    });
    if (res.status === 429 || res.status === 502 || res.status === 503 || res.status === 504) {
      throw new RetryableError(`HTTP ${res.status} ${res.statusText}`);
    }
    if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
    const data = (await res.json()) as OverpassResponse;
    if (data.remark && /error|timed out|out of memory|rate/i.test(data.remark)) {
      throw new RetryableError(`respuesta incompleta: ${data.remark}`);
    }
    return data;
  }

  /**
   * El regex de highway debe ir en UNA sola línea: un salto de línea dentro de
   * la expresión de Overpass rompe la query. `>;` trae todos los nodos de los
   * ways encontrados, también los que caen fuera del bbox.
   */
  private buildQuery(bbox: BoundingBox): string {
    const { south, west, north, east } = bbox;
    const highways = OVERPASS_HIGHWAYS.join('|');
    return `[out:json][timeout:180];
(
  way["highway"~"^(${highways})$"](${south},${west},${north},${east});
);
out body;
>;
out skel qt;`;
  }
}
