/**
 * Worker de la ILS (F5): calcula rutas con longitud objetivo sin bloquear el
 * hilo que atiende la API. El grafo llega como memoria compartida
 * (`SharedArrayBuffer` del snapshot): el worker construye vistas sobre ella, sin
 * copiarlo. Los índices que el motor cachea por grafo (estructura de la red,
 * geometría de A*) se calculan una vez por worker y por grafo.
 */
import { parentPort } from 'worker_threads';
import { CompiledGraph } from '../dijkstra/compiled-graph';
import { TargetLengthRequest, targetLengthRoute } from '../dijkstra/ils';
import { graphFromShared } from '../graph-compiler/snapshot';

type Message =
  | { type: 'graph'; graphId: number; sab: SharedArrayBuffer }
  | { type: 'run'; jobId: number; graphId: number; req: TargetLengthRequest };

let current: { graphId: number; graph: CompiledGraph } | null = null;

parentPort!.on('message', (msg: Message) => {
  if (msg.type === 'graph') {
    current = { graphId: msg.graphId, graph: graphFromShared(msg.sab) };
    return;
  }
  try {
    if (!current || current.graphId !== msg.graphId) throw new Error('el worker no tiene cargado el grafo pedido');
    parentPort!.postMessage({ jobId: msg.jobId, ok: true, result: targetLengthRoute(current.graph, msg.req) });
  } catch (err) {
    parentPort!.postMessage({ jobId: msg.jobId, ok: false, error: err instanceof Error ? err.message : String(err) });
  }
});
