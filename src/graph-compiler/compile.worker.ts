/**
 * Worker de compilación: lee el almacén por way, deriva, compila y escribe el
 * snapshot sin bloquear el hilo que atiende rutas. Responde con la ruta del
 * archivo; el hilo principal lo carga (rápido) y reemplaza el grafo.
 */
import * as path from 'path';
import { parentPort, workerData } from 'worker_threads';
import mongoose from 'mongoose';
import { buildFromStore } from './build';
import { pruneSnapshots, snapshotFileName, writeSnapshot } from './snapshot';

interface WorkerInput {
  mongoUri: string;
  cacheDir: string;
}

async function run() {
  const { mongoUri, cacheDir } = workerData as WorkerInput;
  const t0 = Date.now();
  const conn = await mongoose.createConnection(mongoUri).asPromise();
  try {
    const { graph, derive } = await buildFromStore(conn.db!);
    const fileName = snapshotFileName(graph.meta);
    const file = path.join(cacheDir, fileName);
    writeSnapshot(file, graph);
    pruneSnapshots(cacheDir, graph.meta.source, fileName);
    parentPort!.postMessage({ ok: true, file, meta: graph.meta, derive, ms: Date.now() - t0 });
  } finally {
    await conn.close();
  }
}

run().catch((err) => {
  parentPort!.postMessage({ ok: false, error: err instanceof Error ? err.stack ?? err.message : String(err) });
});
