import { CompiledGraph, chainOfPoint } from './compiled-graph';
import { Position } from './dijkstra';

/**
 * Índice espacial en memoria (grilla) sobre los segmentos de geometría, para
 * el snap con nodos fantasma: proyecta un punto sobre los tramos más cercanos.
 * Reemplaza la consulta `$near` a Mongo. Se construye una vez por grafo.
 */
export interface SnapCandidate extends Position {
  /** Distancia del punto consultado a su proyección sobre el tramo (m). */
  dist: number;
  lat: number;
  lon: number;
}

const CELL_DEG = 0.002; // ~220 m de latitud, ~185 m de longitud a −33°
const M_PER_DEG = 111_320;

export class SpatialIndex {
  private readonly cellKeys: Float64Array;
  private readonly cellStart: Int32Array;
  private readonly cellSegs: Int32Array;

  constructor(private readonly g: CompiledGraph) {
    const keys: number[] = [];
    const segs: number[] = [];
    for (let c = 0; c < g.meta.chainCount; c++) {
      for (let j = g.chainStart[c]; j < g.chainStart[c + 1] - 1; j++) {
        const x0 = Math.floor(Math.min(g.geoLon[j], g.geoLon[j + 1]) / CELL_DEG);
        const x1 = Math.floor(Math.max(g.geoLon[j], g.geoLon[j + 1]) / CELL_DEG);
        const y0 = Math.floor(Math.min(g.geoLat[j], g.geoLat[j + 1]) / CELL_DEG);
        const y1 = Math.floor(Math.max(g.geoLat[j], g.geoLat[j + 1]) / CELL_DEG);
        for (let x = x0; x <= x1; x++) {
          for (let y = y0; y <= y1; y++) {
            keys.push(x * 1e6 + y);
            segs.push(j);
          }
        }
      }
    }
    const order = Int32Array.from({ length: keys.length }, (_, i) => i).sort((a, b) => keys[a] - keys[b] || a - b);
    const uniq: number[] = [];
    const start: number[] = [];
    this.cellSegs = new Int32Array(order.length);
    order.forEach((idx, i) => {
      this.cellSegs[i] = segs[idx];
      if (i === 0 || keys[idx] !== keys[order[i - 1]]) {
        uniq.push(keys[idx]);
        start.push(i);
      }
    });
    start.push(order.length);
    this.cellKeys = Float64Array.from(uniq);
    this.cellStart = Int32Array.from(start);
  }

  private cell(key: number): [number, number] {
    let lo = 0;
    let hi = this.cellKeys.length - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      const v = this.cellKeys[mid];
      if (v === key) return [this.cellStart[mid], this.cellStart[mid + 1]];
      if (v < key) lo = mid + 1;
      else hi = mid - 1;
    }
    return [0, 0];
  }

  /**
   * Los `k` tramos más cercanos (uno por tramo, el punto más cercano de cada
   * uno) a menos de `maxDistM`, entre los que cumplen `accept`.
   */
  nearest(lat: number, lon: number, k: number, maxDistM: number, accept: (chain: number) => boolean = () => true): SnapCandidate[] {
    const g = this.g;
    const cosLat = Math.cos((lat * Math.PI) / 180);
    const cellM = CELL_DEG * M_PER_DEG * Math.min(1, cosLat);
    const cx = Math.floor(lon / CELL_DEG);
    const cy = Math.floor(lat / CELL_DEG);
    const best = new Map<number, SnapCandidate>();
    const maxRing = Math.ceil(maxDistM / cellM) + 1;

    for (let r = 0; r <= maxRing; r++) {
      for (let x = cx - r; x <= cx + r; x++) {
        for (let y = cy - r; y <= cy + r; y++) {
          if (Math.max(Math.abs(x - cx), Math.abs(y - cy)) !== r) continue; // solo el anillo r
          const [a, b] = this.cell(x * 1e6 + y);
          for (let i = a; i < b; i++) {
            const j = this.cellSegs[i];
            // Proyección sobre el segmento j→j+1 en un plano local (metros).
            const ax = (g.geoLon[j] - lon) * cosLat * M_PER_DEG;
            const ay = (g.geoLat[j] - lat) * M_PER_DEG;
            const sx = (g.geoLon[j + 1] - g.geoLon[j]) * cosLat * M_PER_DEG;
            const sy = (g.geoLat[j + 1] - g.geoLat[j]) * M_PER_DEG;
            const ss = sx * sx + sy * sy;
            const t = ss > 0 ? Math.max(0, Math.min(1, -(ax * sx + ay * sy) / ss)) : 0;
            const d = Math.hypot(ax + t * sx, ay + t * sy);
            if (d > maxDistM) continue;
            const chain = chainOfPoint(g, j);
            const prev = best.get(chain);
            if (prev && prev.dist <= d) continue;
            if (!accept(chain)) continue;
            best.set(chain, {
              chain,
              point: j,
              t,
              dist: d,
              lat: g.geoLat[j] + t * (g.geoLat[j + 1] - g.geoLat[j]),
              lon: g.geoLon[j] + t * (g.geoLon[j + 1] - g.geoLon[j]),
            });
          }
        }
      }
      // Lo que queda sin revisar está a más de r·celda: si ya hay k más cerca, se termina.
      const found = [...best.values()].sort((p, q) => p.dist - q.dist);
      if (found.length >= k && found[k - 1].dist <= r * cellM) return found.slice(0, k);
    }
    return [...best.values()].sort((p, q) => p.dist - q.dist).slice(0, k);
  }
}

const indexes = new WeakMap<CompiledGraph, SpatialIndex>();

export function spatialIndex(g: CompiledGraph): SpatialIndex {
  let idx = indexes.get(g);
  if (!idx) {
    idx = new SpatialIndex(g);
    indexes.set(g, idx);
  }
  return idx;
}

/** Tramo dentro de la componente fuertemente conexa mayor (D15): sus dos extremos lo están. */
export function chainInMainScc(g: CompiledGraph, chain: number): boolean {
  return g.nodeInMainScc[g.chainNode0[chain]] === 1 && g.nodeInMainScc[g.chainNode1[chain]] === 1;
}
