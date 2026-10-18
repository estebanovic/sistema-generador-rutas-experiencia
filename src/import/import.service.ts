import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { GraphNode } from '../dijkstra/types';
import { GraphService } from '../graph/graph.service';
import { ElevationService } from '../elevation/elevation.service';
import { OsmService } from '../osm/osm.service';
import { OsmParser, ParsedEdge } from '../osm/osm.parser';
import { ImportBboxDto } from './dto/import-bbox.dto';

export interface ImportResult {
  nodes: number;
  edges: number;
}

@Injectable()
export class ImportService {
  private readonly logger = new Logger(ImportService.name);

  constructor(
    private readonly osmService: OsmService,
    private readonly osmParser: OsmParser,
    private readonly elevationService: ElevationService,
    private readonly graphService: GraphService,
  ) {}

  async import(bbox: ImportBboxDto): Promise<ImportResult> {
    if (bbox.south >= bbox.north || bbox.west >= bbox.east) {
      throw new BadRequestException(
        'Bounding box inválido: se requiere south < north y west < east',
      );
    }

    // 1. Descargar OSM
    const osmData = await this.osmService.fetchRoads(bbox);

    // 2. Parsear → nodos y aristas sin elevación
    const { nodes, edges } = this.osmParser.parse(osmData);
    this.logger.log(`Parseado: ${nodes.length} nodos, ${edges.length} aristas.`);
    if (nodes.length === 0) {
      throw new BadRequestException(
        'No se encontraron vías vehiculares en el bounding box indicado',
      );
    }

    // 3. Enriquecer nodos con elevación (incremental: reutiliza lo ya conocido)
    const known = await this.graphService.getExistingElevations(
      nodes.map((n) => n.osmId),
    );
    for (const n of nodes) {
      const e = known.get(n.osmId);
      if (e !== undefined) n.elevation = e;
    }
    const missing = nodes.filter((n) => !known.has(n.osmId));
    this.logger.log(
      `Elevación: ${known.size} ya conocidas, ${missing.length} por pedir.`,
    );
    await this.elevationService.enrich(missing);
    const elevatedNodes = nodes;

    // 4. Calcular elevationGain/Loss por arista (antes de sanear los NaN)
    const enrichedEdges = this.calculateEdgeElevation(elevatedNodes, edges);

    // Saneamos elevaciones desconocidas (NaN) a 0 para poder persistirlas.
    for (const n of elevatedNodes) {
      if (!Number.isFinite(n.elevation)) n.elevation = 0;
    }

    // 5. Guardar en MongoDB
    await this.graphService.upsertNodes(elevatedNodes);
    await this.graphService.upsertEdges(enrichedEdges);

    // 6. Invalidar cache en memoria
    this.graphService.clearCache();

    this.logger.log('Importación completada.');
    return { nodes: elevatedNodes.length, edges: enrichedEdges.length };
  }

  /** Asigna gain/loss a cada arista según la diferencia de elevación. */
  private calculateEdgeElevation(
    nodes: GraphNode[],
    edges: ParsedEdge[],
  ): ParsedEdge[] {
    const elevationById = new Map<string, number>();
    for (const n of nodes) elevationById.set(n.osmId, n.elevation);

    for (const edge of edges) {
      const from = elevationById.get(edge.fromOsmId);
      const to = elevationById.get(edge.toOsmId);
      // Si falta la elevación de algún extremo, no inventamos desnivel.
      if (from === undefined || to === undefined || !Number.isFinite(from) || !Number.isFinite(to)) {
        edge.elevationGain = 0;
        edge.elevationLoss = 0;
        continue;
      }
      const delta = to - from;
      if (delta >= 0) {
        edge.elevationGain = delta;
        edge.elevationLoss = 0;
      } else {
        edge.elevationGain = 0;
        edge.elevationLoss = -delta;
      }
    }
    return edges;
  }
}
