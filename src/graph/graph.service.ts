import {
  Injectable,
  Logger,
  NotFoundException,
  OnModuleInit,
} from '@nestjs/common';
import { InjectConnection } from '@nestjs/mongoose';
import * as fs from 'fs';
import * as path from 'path';
import { Worker } from 'worker_threads';
import { Connection } from 'mongoose';
import { CompiledGraph } from '../dijkstra/compiled-graph';
import { SnapCandidate, chainInMainScc, spatialIndex } from '../dijkstra/snap';
import { buildFromLegacy, buildFromStore, readDataVersion } from '../graph-compiler/build';
import { COMPILER_VERSION } from '../graph-compiler/compile';
import { DeriveStats } from '../graph-compiler/derive';
import { pruneSnapshots, readSnapshot, snapshotFileName, writeSnapshot } from '../graph-compiler/snapshot';

/**
 * Fuente del grafo:
 * - `osm` (por defecto): almacén canónico por way (`osm_ways`/`osm_nodes`),
 *   derivado con las reglas de `src/graph-compiler/`.
 * - `legacy`: colecciones anteriores a F0.1 (`nodes`/`edges`), congeladas hasta
 *   el punto de control C0 para poder comparar y volver atrás.
 */
export type GraphSource = 'osm' | 'legacy';

/** Distancia máxima de ajuste del snap (D17). */
export const MAX_SNAP_M = 1000;
/** Radio de búsqueda para distinguir los mensajes de error (red lejana, isla, sin vías). */
const SNAP_RADIUS_M = 5000;

/** Cada cuánto se consulta `graph_meta.dataVersion` para detectar imports hechos por otro proceso (CLI). */
const VERSION_CHECK_MS = 30_000;

@Injectable()
export class GraphService implements OnModuleInit {
  private readonly logger = new Logger(GraphService.name);
  readonly source: GraphSource = process.env.GRAPH_SOURCE === 'legacy' ? 'legacy' : 'osm';
  private readonly cacheDir = path.resolve(process.env.GRAPH_CACHE_DIR ?? path.join(process.cwd(), 'data', 'graph-cache'));

  private graph: CompiledGraph | null = null;
  private lastDeriveStats: DeriveStats | null = null;
  private building: Promise<CompiledGraph> | null = null;
  private rebuildAgain = false;
  private lastVersionCheck = 0;

  constructor(@InjectConnection() private readonly connection: Connection) {}

  /** Precarga al arrancar (desactivable con GRAPH_PRELOAD=false, p. ej. en la CLI). */
  async onModuleInit(): Promise<void> {
    if (process.env.GRAPH_PRELOAD === 'false') return;
    await this.getGraph();
  }

  /** Grafo compilado vigente. La primera vez lo carga del snapshot o lo compila. */
  async getGraph(): Promise<CompiledGraph> {
    if (this.graph) {
      this.maybeCheckVersion();
      return this.graph;
    }
    return this.rebuild();
  }

  /**
   * (Re)construye el grafo. Mientras tanto se sigue sirviendo el anterior; al
   * terminar se reemplaza de una vez. Si llega otro pedido durante la
   * construcción, se hace una más al final (para incluir el último import).
   */
  rebuild(): Promise<CompiledGraph> {
    if (this.building) {
      this.rebuildAgain = true;
      return this.building;
    }
    this.building = (async () => {
      try {
        let g: CompiledGraph;
        do {
          this.rebuildAgain = false;
          g = await this.load();
          this.graph = g;
        } while (this.rebuildAgain);
        return g;
      } finally {
        this.building = null;
      }
    })();
    return this.building;
  }

  /** Estadísticas de la última derivación compilada en este proceso (si la hubo). */
  deriveStats(): DeriveStats | null {
    return this.lastDeriveStats;
  }

  private async load(): Promise<CompiledGraph> {
    const t0 = Date.now();
    const db = this.connection.db!;
    if (this.source === 'legacy') {
      const g = await buildFromLegacy(db);
      this.log(g, 'compilado (legacy)', t0);
      return g;
    }
    const dataVersion = await readDataVersion(db);
    const file = path.join(this.cacheDir, snapshotFileName({ source: 'osm', dataVersion, compilerVersion: COMPILER_VERSION }));
    if (fs.existsSync(file)) {
      try {
        const g = readSnapshot(file);
        this.log(g, `cargado del snapshot ${path.basename(file)}`, t0);
        return g;
      } catch (err) {
        this.logger.warn(`Snapshot ilegible, se recompila: ${err instanceof Error ? err.message : err}`);
      }
    }
    const g = await this.compileInWorker().catch(async (err) => {
      // Sin worker (p. ej. ejecutando desde TypeScript sin compilar): se compila en este hilo.
      this.logger.warn(`Compilación en worker no disponible (${err instanceof Error ? err.message : err}); se compila en el hilo principal.`);
      const { graph, derive } = await buildFromStore(db);
      this.lastDeriveStats = derive;
      const fileName = snapshotFileName(graph.meta);
      writeSnapshot(path.join(this.cacheDir, fileName), graph);
      pruneSnapshots(this.cacheDir, 'osm', fileName);
      return graph;
    });
    this.log(g, 'compilado', t0);
    return g;
  }

  private compileInWorker(): Promise<CompiledGraph> {
    const script = path.join(__dirname, '..', 'graph-compiler', 'compile.worker.js');
    if (!fs.existsSync(script)) return Promise.reject(new Error('compile.worker.js no existe'));
    const mongoUri = process.env.MONGO_URI ?? 'mongodb://localhost:27017/generador-rutas';
    return new Promise((resolve, reject) => {
      const worker = new Worker(script, {
        workerData: { mongoUri, cacheDir: this.cacheDir },
        resourceLimits: { maxOldGenerationSizeMb: 8192 },
      });
      worker.once('message', (msg: { ok: boolean; file?: string; derive?: DeriveStats; error?: string }) => {
        if (!msg.ok) return reject(new Error(msg.error));
        this.lastDeriveStats = msg.derive ?? null;
        try {
          resolve(readSnapshot(msg.file!));
        } catch (err) {
          reject(err);
        }
      });
      worker.once('error', reject);
      worker.once('exit', (code) => {
        if (code !== 0) reject(new Error(`el worker terminó con código ${code}`));
      });
    });
  }

  /** Detecta imports hechos por otro proceso y recompila en segundo plano. */
  private maybeCheckVersion(): void {
    if (this.source !== 'osm' || this.building || Date.now() - this.lastVersionCheck < VERSION_CHECK_MS) return;
    this.lastVersionCheck = Date.now();
    readDataVersion(this.connection.db!)
      .then((v) => {
        if (this.graph && v !== this.graph.meta.dataVersion) {
          this.logger.log(`Datos cambiados (versión ${this.graph.meta.dataVersion} → ${v}); recompilando en segundo plano.`);
          void this.rebuild();
        }
      })
      .catch(() => undefined);
  }

  private log(g: CompiledGraph, how: string, t0: number) {
    const m = g.meta;
    this.logger.log(
      `Grafo ${how} (${m.source}, datos v${m.dataVersion}, compilador ${m.compilerVersion}): ${m.nodeCount} nodos, ${m.edgeCount} aristas, CFC mayor ${((100 * m.mainSccSize) / Math.max(1, m.nodeCount)).toFixed(1)}%, ${Date.now() - t0} ms.`,
    );
  }

  /**
   * Snap con nodos fantasma (F0.3): proyecta el punto sobre los `k` tramos más
   * cercanos de la componente fuertemente conexa mayor (D15), con un índice
   * espacial en memoria (sin consultar Mongo). Con varios candidatos el router
   * elige el que mejor conecta (p. ej. la calzada correcta de una autopista).
   */
  async snap(lat: number, lon: number, k: number): Promise<SnapCandidate[]> {
    const g = await this.getGraph();
    const idx = spatialIndex(g);
    const inMain = (c: number) => chainInMainScc(g, c);
    const found = idx.nearest(lat, lon, k, MAX_SNAP_M, inMain);
    if (found.length > 0) return found;
    // D17: más allá de 1 km no se ajusta; se informa a qué distancia está la red.
    const [far] = idx.nearest(lat, lon, 1, SNAP_RADIUS_M, inMain);
    if (far) {
      throw new NotFoundException(
        `El punto (${lat}, ${lon}) está a ${Math.round(far.dist)} m de la red vial conectada; el máximo para ajustarlo es ${MAX_SNAP_M} m.`,
      );
    }
    if (idx.nearest(lat, lon, 1, SNAP_RADIUS_M).length > 0) {
      throw new NotFoundException(
        `El punto (${lat}, ${lon}) está fuera de la red conectada: las vías cercanas forman una isla sin conexión con el resto del grafo.`,
      );
    }
    throw new NotFoundException(`No hay vías importadas a menos de 5 km de (${lat}, ${lon}). ¿Importaste esa zona?`);
  }
}
