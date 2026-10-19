import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import * as fs from 'fs';
import * as path from 'path';
import { Worker } from 'worker_threads';
import { CompiledGraph } from '../dijkstra/compiled-graph';
import { TargetLengthRequest, TargetLengthResult, targetLengthRoute } from '../dijkstra/ils';
import { sharedBufferOf } from '../graph-compiler/snapshot';

type IlsOutcome = TargetLengthResult | { error: string };

interface Job {
  jobId: number;
  graph: CompiledGraph;
  req: TargetLengthRequest;
  resolve: (r: IlsOutcome) => void;
  reject: (e: Error) => void;
}

interface Slot {
  worker: Worker;
  graphId: number;
  job: Job | null;
}

/**
 * Pool de workers para la ILS (F5): cada consulta con longitud objetivo
 * corre hasta ~6 s, así que no puede ejecutarse en el hilo que atiende la API.
 *
 * - `ILS_WORKERS` workers (por defecto 2); las consultas que llegan con todos
 *   ocupados esperan en cola.
 * - El grafo se comparte sin copiar: el snapshot vive en un
 *   `SharedArrayBuffer` y cada worker arma vistas sobre él. Cuando el grafo
 *   cambia (import, recompilación), se reenvía antes del siguiente cálculo.
 * - Si no hay worker disponible (grafo sin memoria compartida, como el legacy,
 *   o ejecución desde TypeScript sin compilar), calcula en el hilo principal.
 */
@Injectable()
export class IlsPool implements OnModuleDestroy {
  private readonly logger = new Logger(IlsPool.name);
  private readonly size = Math.max(0, Number(process.env.ILS_WORKERS ?? 2));
  private readonly script = path.join(__dirname, 'ils.worker.js');
  private readonly slots: Slot[] = [];
  private readonly queue: Job[] = [];
  private readonly graphIds = new WeakMap<CompiledGraph, number>();
  private nextGraphId = 1;
  private nextJobId = 1;
  private warned = false;

  run(graph: CompiledGraph, req: TargetLengthRequest): Promise<IlsOutcome> {
    const sab = sharedBufferOf(graph);
    if (!sab || this.size === 0 || !fs.existsSync(this.script)) {
      if (!this.warned) {
        this.warned = true;
        this.logger.warn('La ILS corre en el hilo principal (sin worker o sin grafo en memoria compartida).');
      }
      return Promise.resolve(targetLengthRoute(graph, req));
    }
    return new Promise((resolve, reject) => {
      this.queue.push({ jobId: this.nextJobId++, graph, req, resolve, reject });
      this.pump();
    });
  }

  private graphIdOf(g: CompiledGraph): number {
    let id = this.graphIds.get(g);
    if (id === undefined) {
      id = this.nextGraphId++;
      this.graphIds.set(g, id);
    }
    return id;
  }

  private spawn(): Slot {
    const slot: Slot = { worker: new Worker(this.script), graphId: 0, job: null };
    slot.worker.on('message', (msg: { jobId: number; ok: boolean; result?: TargetLengthResult; error?: string }) => {
      const job = slot.job;
      slot.job = null;
      if (job && job.jobId === msg.jobId) {
        if (msg.ok) job.resolve(msg.result!);
        else job.reject(new Error(msg.error));
      }
      this.pump();
    });
    const fail = (err: Error) => {
      const job = slot.job;
      slot.job = null;
      this.slots.splice(this.slots.indexOf(slot), 1);
      if (job) job.reject(err);
      this.pump();
    };
    slot.worker.on('error', fail);
    slot.worker.on('exit', (code) => {
      if (this.slots.includes(slot)) fail(new Error(`el worker de la ILS terminó con código ${code}`));
    });
    this.slots.push(slot);
    return slot;
  }

  private pump(): void {
    while (this.queue.length) {
      let slot = this.slots.find((s) => s.job === null);
      if (!slot && this.slots.length < this.size) slot = this.spawn();
      if (!slot) return;
      const job = this.queue.shift()!;
      const graphId = this.graphIdOf(job.graph);
      if (slot.graphId !== graphId) {
        slot.worker.postMessage({ type: 'graph', graphId, sab: sharedBufferOf(job.graph) });
        slot.graphId = graphId;
      }
      slot.job = job;
      slot.worker.postMessage({ type: 'run', jobId: job.jobId, graphId, req: job.req });
    }
  }

  async onModuleDestroy(): Promise<void> {
    const slots = this.slots.splice(0);
    await Promise.all(slots.map((s) => s.worker.terminate()));
  }
}
