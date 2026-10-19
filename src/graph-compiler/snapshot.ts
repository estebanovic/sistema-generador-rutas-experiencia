import * as fs from 'fs';
import * as path from 'path';
import { CompiledGraph, CompiledMeta } from '../dijkstra/compiled-graph';

/**
 * Snapshot binario del grafo compilado. Formato:
 *   8 bytes  "GRPHSNP2" (versión del formato; la 1 era el grafo sin compactar)
 *   4 bytes  largo del encabezado JSON (uint32 LE)
 *   N bytes  encabezado JSON (meta, etiquetas y descriptores de arrays), relleno a múltiplo de 8
 *   arrays   uno tras otro, cada uno alineado a 8 bytes
 * Al leer, los arrays son vistas sobre el mismo buffer (sin copias).
 */
const MAGIC = 'GRPHSNP2';

type TypedArrayCtor =
  | Float64ArrayConstructor
  | Float32ArrayConstructor
  | Int32ArrayConstructor
  | Uint8ArrayConstructor;

const ARRAYS: [keyof CompiledGraph, TypedArrayCtor][] = [
  ['nodeOsmId', Float64Array],
  ['nodeLat', Float64Array],
  ['nodeLon', Float64Array],
  ['nodeInMainScc', Uint8Array],
  ['nodeDegree', Int32Array],
  ['outStart', Int32Array],
  ['edgeFrom', Int32Array],
  ['edgeTo', Int32Array],
  ['edgeChain', Int32Array],
  ['edgeDir', Uint8Array],
  ['edgeLen', Float64Array],
  ['edgeSumStraight', Float64Array],
  ['edgeSumUnpaved', Float64Array],
  ['edgeSumMinor', Float64Array],
  ['edgeFlags', Uint8Array],
  ['inStart', Int32Array],
  ['inEdge', Int32Array],
  ['chainStart', Int32Array],
  ['chainFwd', Int32Array],
  ['chainBwd', Int32Array],
  ['chainNode0', Int32Array],
  ['chainNode1', Int32Array],
  ['chainIsBridge', Uint8Array],
  ['chainFlags', Uint8Array],
  ['geoOsmId', Float64Array],
  ['geoLat', Float64Array],
  ['geoLon', Float64Array],
  ['geoCumLen', Float64Array],
  ['geoCumStraight', Float64Array],
  ['geoCumUnpaved', Float64Array],
  ['geoCumMinor', Float64Array],
  ['segCurv', Float32Array],
  ['segCurvDeg', Float32Array],
  ['segHighway', Uint8Array],
  ['segSurface', Uint8Array],
  ['segSurfaceSource', Uint8Array],
  ['segWay', Float64Array],
  ['twinStart', Int32Array],
  ['twinEdge', Int32Array],
  ['twinFrac', Float32Array],
];

interface Header {
  meta: CompiledMeta;
  rawLabels?: string[];
  arrays: { name: string; type: string; length: number; offset: number }[];
}

const align8 = (n: number) => (n + 7) & ~7;

export function snapshotFileName(meta: Pick<CompiledMeta, 'source' | 'dataVersion' | 'compilerVersion'>): string {
  return `graph-${meta.source}-v${meta.dataVersion}-${meta.compilerVersion}.bin`;
}

/** Escribe el snapshot de forma atómica (archivo temporal + rename). */
export function writeSnapshot(file: string, g: CompiledGraph): void {
  const descriptors: Header['arrays'] = [];
  let offset = 0;
  for (const [name] of ARRAYS) {
    const arr = g[name] as ArrayBufferView & { length: number };
    descriptors.push({ name, type: arr.constructor.name, length: arr.length, offset });
    offset = align8(offset + arr.byteLength);
  }
  const header: Header = { meta: g.meta, rawLabels: g.rawLabels, arrays: descriptors };
  const headerBuf = Buffer.from(JSON.stringify(header), 'utf8');
  const dataStart = align8(12 + headerBuf.length);
  const total = dataStart + offset;

  const out = Buffer.alloc(total);
  out.write(MAGIC, 0, 'ascii');
  out.writeUInt32LE(headerBuf.length, 8);
  headerBuf.copy(out, 12);
  for (let i = 0; i < ARRAYS.length; i++) {
    const arr = g[ARRAYS[i][0]] as ArrayBufferView;
    Buffer.from(arr.buffer, arr.byteOffset, arr.byteLength).copy(out, dataStart + descriptors[i].offset);
  }

  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, out);
  fs.renameSync(tmp, file);
}

/** Memoria compartida de cada grafo leído de un snapshot (para los workers de la ILS). */
const sharedBuffers = new WeakMap<CompiledGraph, SharedArrayBuffer>();

/**
 * Lee un snapshot en memoria compartida (`SharedArrayBuffer`): las vistas del
 * grafo apuntan a esa memoria y los workers de la ILS construyen las mismas
 * vistas sin copiar el grafo (`graphFromShared`).
 */
export function readSnapshot(file: string): CompiledGraph {
  const fd = fs.openSync(file, 'r');
  try {
    const size = fs.fstatSync(fd).size;
    const sab = new SharedArrayBuffer(size);
    const buf = Buffer.from(sab);
    let off = 0;
    while (off < size) {
      const n = fs.readSync(fd, buf, off, size - off, off);
      if (n <= 0) break;
      off += n;
    }
    return graphFromShared(sab, file);
  } finally {
    fs.closeSync(fd);
  }
}

/** Grafo con vistas sobre un snapshot ya cargado en memoria compartida (sin copiar). */
export function graphFromShared(sab: SharedArrayBuffer, label = 'memoria compartida'): CompiledGraph {
  const buf = Buffer.from(sab);
  if (buf.length < 12 || buf.toString('ascii', 0, 8) !== MAGIC) throw new Error(`No es un snapshot de grafo: ${label}`);
  const headerLen = buf.readUInt32LE(8);
  const header = JSON.parse(buf.toString('utf8', 12, 12 + headerLen)) as Header;
  const dataStart = align8(12 + headerLen);

  const g: Partial<CompiledGraph> = { meta: header.meta };
  if (header.rawLabels) g.rawLabels = header.rawLabels;
  for (const [name, Ctor] of ARRAYS) {
    const d = header.arrays.find((a) => a.name === name);
    if (!d || d.type !== Ctor.name) throw new Error(`Snapshot incompatible: falta ${name} o cambió su tipo`);
    // Los constructores de vistas aceptan memoria compartida; el tipo de la unión de constructores solo declara ArrayBuffer.
    (g as Record<string, unknown>)[name] = new Ctor(sab as unknown as ArrayBuffer, dataStart + d.offset, d.length);
  }
  const graph = g as CompiledGraph;
  sharedBuffers.set(graph, sab);
  return graph;
}

/** Memoria compartida del grafo, si se leyó de un snapshot (los compilados en memoria, p. ej. legacy, no tienen). */
export function sharedBufferOf(g: CompiledGraph): SharedArrayBuffer | undefined {
  return sharedBuffers.get(g);
}

/** Borra los snapshots de la misma fuente distintos de `keep`. */
export function pruneSnapshots(dir: string, source: string, keep: string): void {
  if (!fs.existsSync(dir)) return;
  for (const f of fs.readdirSync(dir)) {
    if (f.startsWith(`graph-${source}-`) && f.endsWith('.bin') && f !== keep) {
      try {
        fs.unlinkSync(path.join(dir, f));
      } catch {
        // otro proceso puede estar leyéndolo; se borra en la próxima compilación
      }
    }
  }
}
