/**
 * Reimportación masiva por teselas al almacén por way (F0.1, decisión D6).
 *
 * Uso (después de `npm run build`):
 *   node dist/cli/reimport-tiles.js --bbox <s>,<w>,<n>,<e> [--tile 0.25] [--delay 15] [--desde 0]
 *
 * - Cada tesela trae sus ways COMPLETOS (también los nodos fuera de la tesela);
 *   los ways repetidos entre teselas se deduplican por ID de OSM, porque el
 *   reemplazo por way sobrescribe el mismo documento.
 * - Entre teselas espera `--delay` segundos; ante límite de uso o timeout de
 *   Overpass reintenta con espera creciente (30 s, 60 s, 120 s, ...).
 * - `--desde N` retoma desde la tesela N si una corrida anterior se cortó.
 */
import { NestFactory } from '@nestjs/core';
import { AppModule } from '../app.module';
import { ImportService } from '../import/import.service';
import { BoundingBox } from '../osm/osm.types';

function arg(name: string, fallback?: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : fallback;
}

export function tiles(b: BoundingBox, size: number): BoundingBox[] {
  const out: BoundingBox[] = [];
  for (let s = b.south; s < b.north - 1e-9; s += size) {
    for (let w = b.west; w < b.east - 1e-9; w += size) {
      out.push({
        south: +s.toFixed(6),
        west: +w.toFixed(6),
        north: +Math.min(s + size, b.north).toFixed(6),
        east: +Math.min(w + size, b.east).toFixed(6),
      });
    }
  }
  return out;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const bboxArg = arg('bbox');
  if (!bboxArg) {
    console.error('Uso: node dist/cli/reimport-tiles.js --bbox <s>,<w>,<n>,<e> [--tile 0.25] [--delay 15] [--desde 0]');
    process.exit(1);
  }
  const [south, west, north, east] = bboxArg.split(',').map(Number);
  const size = Number(arg('tile', '0.25'));
  const delayMs = Number(arg('delay', '15')) * 1000;
  const from = Number(arg('desde', '0'));
  const list = tiles({ south, west, north, east }, size);

  const app = await NestFactory.createApplicationContext(AppModule, { logger: ['log', 'warn', 'error'] });
  const importer = app.get(ImportService);
  const t0 = Date.now();
  let totalWays = 0;
  let current = from;
  try {
    for (let i = from; i < list.length; i++) {
      current = i;
      const t = list[i];
      const ti = Date.now();
      const res = await importer.import(t, { source: 'teselas', fetch: { retries: 5, baseDelayMs: 30_000 } });
      totalWays += res.ways;
      console.log(
        `[tesela ${i + 1}/${list.length}] ${t.south},${t.west},${t.north},${t.east}: ${res.ways} ways, ${res.nodes} nodos, ${res.deletedWays} borrados (${Math.round((Date.now() - ti) / 1000)} s)`,
      );
      if (i < list.length - 1) await sleep(delayMs);
    }
  } catch (err) {
    console.error(`Corte en la tesela ${current}. Retomar con --desde ${current}. ${err instanceof Error ? err.message : err}`);
    process.exitCode = 1;
  } finally {
    await app.close();
  }
  console.log(`Listo: ${list.length - from} teselas, ${totalWays} ways escritos (con repetidos entre teselas), ${Math.round((Date.now() - t0) / 60000)} min.`);
}

if (require.main === module) void main();
