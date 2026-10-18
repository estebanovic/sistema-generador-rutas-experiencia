import { Injectable, Logger } from '@nestjs/common';
import { GraphNode } from '../dijkstra/types';

@Injectable()
export class ElevationService {
  private readonly logger = new Logger(ElevationService.name);

  // Ambos aceptan hasta 100 ubicaciones por request y usan datos SRTM.
  private readonly batchSize = 100;
  private readonly delayBetweenBatchesMs = 300;
  // Tope blando: no bloquear el import más de esto pidiendo elevación.
  private readonly timeBudgetMs = 90_000;

  /**
   * Rellena `elevation` de cada nodo. Intenta Open-Meteo y, si corta por rate
   * limit, cae a Open-Topo-Data (cuota separada). Los puntos no resueltos
   * quedan en `NaN` para que el cálculo de desnivel los ignore (no 0 falso).
   */
  async enrich(nodes: GraphNode[]): Promise<GraphNode[]> {
    if (nodes.length === 0) return nodes;

    const totalBatches = Math.ceil(nodes.length / this.batchSize);
    this.logger.log(
      `Solicitando elevación de ${nodes.length} nodos en ${totalBatches} lote(s)...`,
    );

    const start = Date.now();
    let failed = 0;

    for (let i = 0; i < nodes.length; i += this.batchSize) {
      const batch = nodes.slice(i, i + this.batchSize);

      if (Date.now() - start > this.timeBudgetMs) {
        // Se acabó el presupuesto: el resto queda sin elevación (se completa
        // reimportando la zona más tarde, gracias al modo incremental).
        for (let j = i; j < nodes.length; j++) nodes[j].elevation = NaN;
        this.logger.warn(
          `Presupuesto de elevación agotado; ${nodes.length - i} nodos sin ` +
            'elevación por ahora (reimportá para completarlos).',
        );
        break;
      }

      let elevations = await this.fetchOpenMeteo(batch);
      if (!elevations) {
        // Open-Meteo cortó: probamos el otro proveedor (respeta ~1 req/seg).
        await this.sleep(1100);
        elevations = await this.fetchOpenTopo(batch);
      }

      if (!elevations) {
        batch.forEach((n) => (n.elevation = NaN));
        failed += batch.length;
      } else {
        batch.forEach((node, idx) => {
          const e = elevations![idx];
          node.elevation = Number.isFinite(e) ? e : NaN;
          if (!Number.isFinite(e)) failed++;
        });
      }

      if (i + this.batchSize < nodes.length) {
        await this.sleep(this.delayBetweenBatchesMs);
      }
    }

    if (failed > 0) {
      this.logger.warn(
        `Elevación no resuelta para ${failed}/${nodes.length} nodos.`,
      );
    }
    return nodes;
  }

  /** Devuelve el array de elevaciones, o null si el proveedor falló/cortó. */
  private async fetchOpenMeteo(batch: GraphNode[]): Promise<number[] | null> {
    const lats = batch.map((n) => n.lat).join(',');
    const lons = batch.map((n) => n.lon).join(',');
    const url = `https://api.open-meteo.com/v1/elevation?latitude=${lats}&longitude=${lons}`;
    try {
      const res = await fetch(url);
      if (!res.ok) return null; // 429 u otro → que el caller use el fallback
      const data = (await res.json()) as { elevation?: number[] };
      return Array.isArray(data.elevation) ? data.elevation : null;
    } catch {
      return null;
    }
  }

  private async fetchOpenTopo(batch: GraphNode[]): Promise<number[] | null> {
    const locs = batch.map((n) => `${n.lat},${n.lon}`).join('|');
    const url = `https://api.opentopodata.org/v1/srtm30m?locations=${locs}`;
    try {
      const res = await fetch(url);
      if (!res.ok) return null;
      const data = (await res.json()) as {
        results?: { elevation: number | null }[];
      };
      if (!Array.isArray(data.results)) return null;
      return data.results.map((r) => (r.elevation == null ? NaN : r.elevation));
    } catch {
      return null;
    }
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
