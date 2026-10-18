import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { GraphService } from '../graph/graph.service';
import { OsmStoreService } from '../graph/osm-store.service';
import { FetchOptions, OsmService } from '../osm/osm.service';
import { OsmParser } from '../osm/osm.parser';
import { BoundingBox } from '../osm/osm.types';

export interface ImportResult {
  nodes: number;
  /** Segmentos importados (pares de nodos consecutivos de los ways). */
  edges: number;
  ways: number;
  deletedWays: number;
}

export interface ImportOptions {
  /** 'vista' (botón del frontend) o 'teselas' (reimportación masiva). */
  source?: 'vista' | 'teselas';
  fetch?: FetchOptions;
  /** Recompilar el grafo al terminar (por defecto sí; la CLI de teselas recompila una vez al final). */
  rebuild?: boolean;
}

@Injectable()
export class ImportService {
  private readonly logger = new Logger(ImportService.name);
  /** Los imports se serializan: el reemplazo por way y la recompilación no deben mezclarse. */
  private queue: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly osmService: OsmService,
    private readonly osmParser: OsmParser,
    private readonly store: OsmStoreService,
    private readonly graphService: GraphService,
  ) {}

  /**
   * Import con reemplazo por way al almacén canónico. Ya no pide elevación
   * (fuera del alcance de la tesis; el frontend consulta su propio perfil).
   */
  import(bbox: BoundingBox, options: ImportOptions = {}): Promise<ImportResult> {
    const run = this.queue.then(() => this.importNow(bbox, options));
    this.queue = run.catch(() => undefined);
    return run;
  }

  private async importNow(bbox: BoundingBox, options: ImportOptions): Promise<ImportResult> {
    const source = options.source ?? 'vista';
    if (bbox.south >= bbox.north || bbox.west >= bbox.east) {
      throw new BadRequestException(
        'Bounding box inválido: se requiere south < north y west < east',
      );
    }
    const startedAt = new Date();

    // 1. Descargar OSM (ways completos; nunca una respuesta cortada).
    const osmData = await this.osmService.fetchRoads(bbox, options.fetch);

    // 2. Parsear a ways crudos + nodos.
    const parsed = this.osmParser.parse(osmData);
    this.logger.log(`Parseado: ${parsed.ways.length} ways, ${parsed.nodes.length} nodos.`);
    if (parsed.ways.length === 0 && source === 'vista') {
      throw new BadRequestException(
        'No se encontraron vías vehiculares en el bounding box indicado',
      );
    }

    // 3. Reemplazo por way en el almacén.
    const res = await this.store.applyImport(bbox, parsed, { source, server: osmData.server, startedAt });

    // 4. Recompilar el grafo (se sigue sirviendo el anterior hasta que termina).
    if (options.rebuild !== false) await this.graphService.rebuild();

    const edges = parsed.ways.reduce((s, w) => s + w.nodeIds.length - 1, 0);
    this.logger.log(
      `Importación completada: ${res.ways} ways, ${res.nodes} nodos, ${res.deletedWays} ways borrados (versión de datos ${res.dataVersion}).`,
    );
    return { nodes: res.nodes, edges, ways: res.ways, deletedWays: res.deletedWays };
  }
}
