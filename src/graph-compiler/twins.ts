import { CompiledGraph } from '../dijkstra/compiled-graph';

/**
 * Calzadas gemelas en sentido opuesto (D13). Para cada arista dirigida `e`,
 * las aristas `e'` de OTRO tramo que:
 *  - comparten `name` o `ref` (normalizados),
 *  - corren en sentido opuesto (ángulo > 150°),
 *  - a menos de 50 m,
 * durante al menos el 20% del recorrido de `e` (`twinFrac`). La ILS usa esta
 * lista para la penalización blanda de ir por una calzada y volver por la otra.
 */
export interface WayLabels {
  name?: string;
  ref?: string;
}

const SAMPLE_STEP_M = 20;
const MAX_DIST_M = 50;
const MIN_FRAC = 0.2;
const COS_OPPOSITE = Math.cos((150 * Math.PI) / 180);
const CELL_DEG = 0.0005; // ~55 m: con ±1 celda se cubren 50 m
const M_PER_DEG = 111_320;

function labelKeys(l: WayLabels | undefined): string[] {
  if (!l) return [];
  const out: string[] = [];
  if (l.name && l.name.trim()) out.push('n:' + l.name.trim().toLowerCase());
  if (l.ref) for (const r of l.ref.split(';')) if (r.trim()) out.push('r:' + r.trim().toUpperCase());
  return out;
}

export function oppositeTwins(
  g: CompiledGraph,
  wayLabels: Map<string, WayLabels>,
): { twinStart: Int32Array; twinEdge: Int32Array; twinFrac: Float32Array } {
  const T = g.meta.chainCount;
  const M = g.meta.edgeCount;

  // Etiquetas por tramo.
  const chainLabels: (Set<string> | null)[] = new Array(T).fill(null);
  for (let t = 0; t < T; t++) {
    const set = new Set<string>();
    for (let j = g.chainStart[t]; j < g.chainStart[t + 1] - 1; j++) {
      for (const k of labelKeys(wayLabels.get(String(g.segWay[j])))) set.add(k);
    }
    if (set.size > 0) chainLabels[t] = set;
  }
  const shareLabel = (a: Set<string>, b: Set<string>) => {
    for (const k of a) if (b.has(k)) return true;
    return false;
  };

  // Grilla de segmentos de tramos con etiqueta.
  const cellKey = (lat: number, lon: number) => Math.floor(lon / CELL_DEG) * 1e6 + Math.floor(lat / CELL_DEG);
  const grid = new Map<number, number[]>();
  for (let t = 0; t < T; t++) {
    if (!chainLabels[t]) continue;
    for (let j = g.chainStart[t]; j < g.chainStart[t + 1] - 1; j++) {
      const la0 = Math.min(g.geoLat[j], g.geoLat[j + 1]);
      const la1 = Math.max(g.geoLat[j], g.geoLat[j + 1]);
      const lo0 = Math.min(g.geoLon[j], g.geoLon[j + 1]);
      const lo1 = Math.max(g.geoLon[j], g.geoLon[j + 1]);
      for (let cx = Math.floor(lo0 / CELL_DEG); cx <= Math.floor(lo1 / CELL_DEG); cx++) {
        for (let cy = Math.floor(la0 / CELL_DEG); cy <= Math.floor(la1 / CELL_DEG); cy++) {
          const k = cx * 1e6 + cy;
          const l = grid.get(k);
          if (l) l.push(j);
          else grid.set(k, [j]);
        }
      }
    }
  }
  // Tramo de cada punto de geometría (para los segmentos de la grilla).
  const chainOf = new Int32Array(g.meta.geoCount);
  for (let t = 0; t < T; t++) for (let j = g.chainStart[t]; j < g.chainStart[t + 1]; j++) chainOf[j] = t;

  const lists: { e: number; f: number }[][] = new Array(M);
  for (let e = 0; e < M; e++) {
    const t = g.edgeChain[e];
    const labels = chainLabels[t];
    if (!labels) continue;
    const sign = g.edgeDir[e] === 0 ? 1 : -1;
    const p0 = g.chainStart[t];
    const pLast = g.chainStart[t + 1] - 1;
    const L = g.geoCumLen[pLast];
    const n = Math.max(1, Math.floor(L / SAMPLE_STEP_M));
    const matches = new Map<number, number>();
    let j = p0;
    for (let i = 0; i <= n; i++) {
      const s = (L * i) / n;
      while (j < pLast - 1 && g.geoCumLen[j + 1] < s) j++;
      const segLen = g.geoCumLen[j + 1] - g.geoCumLen[j];
      const u = segLen > 0 ? (s - g.geoCumLen[j]) / segLen : 0;
      const lat = g.geoLat[j] + u * (g.geoLat[j + 1] - g.geoLat[j]);
      const lon = g.geoLon[j] + u * (g.geoLon[j + 1] - g.geoLon[j]);
      const cosLat = Math.cos((lat * Math.PI) / 180);
      const dx = sign * (g.geoLon[j + 1] - g.geoLon[j]) * cosLat;
      const dy = sign * (g.geoLat[j + 1] - g.geoLat[j]);
      const dn = Math.hypot(dx, dy);
      if (dn === 0) continue;
      const seen = new Set<number>();
      const cx = Math.floor(lon / CELL_DEG);
      const cy = Math.floor(lat / CELL_DEG);
      for (let ox = -1; ox <= 1; ox++) {
        for (let oy = -1; oy <= 1; oy++) {
          for (const j2 of grid.get((cx + ox) * 1e6 + (cy + oy)) ?? []) {
            const t2 = chainOf[j2];
            if (t2 === t || !shareLabel(labels, chainLabels[t2]!)) continue;
            // Distancia del punto al segmento j2 (plano local en metros).
            const ax = (g.geoLon[j2] - lon) * cosLat * M_PER_DEG;
            const ay = (g.geoLat[j2] - lat) * M_PER_DEG;
            const bx = (g.geoLon[j2 + 1] - lon) * cosLat * M_PER_DEG;
            const by = (g.geoLat[j2 + 1] - lat) * M_PER_DEG;
            const sx = bx - ax;
            const sy = by - ay;
            const ss = sx * sx + sy * sy;
            const w = ss > 0 ? Math.max(0, Math.min(1, -(ax * sx + ay * sy) / ss)) : 0;
            const d = Math.hypot(ax + w * sx, ay + w * sy);
            if (d > MAX_DIST_M) continue;
            for (const [e2, s2] of [[g.chainFwd[t2], 1], [g.chainBwd[t2], -1]] as const) {
              if (e2 < 0 || seen.has(e2)) continue;
              const ex = s2 * (g.geoLon[j2 + 1] - g.geoLon[j2]) * cosLat;
              const ey = s2 * (g.geoLat[j2 + 1] - g.geoLat[j2]);
              const en = Math.hypot(ex, ey);
              if (en === 0) continue;
              if ((dx * ex + dy * ey) / (dn * en) <= COS_OPPOSITE) {
                seen.add(e2);
                matches.set(e2, (matches.get(e2) ?? 0) + 1);
              }
            }
          }
        }
      }
    }
    const out: { e: number; f: number }[] = [];
    for (const [e2, c] of matches) {
      const f = c / (n + 1);
      if (f >= MIN_FRAC) out.push({ e: e2, f });
    }
    if (out.length) lists[e] = out.sort((a, b) => b.f - a.f || a.e - b.e);
  }

  const twinStart = new Int32Array(M + 1);
  for (let e = 0; e < M; e++) twinStart[e + 1] = twinStart[e] + (lists[e]?.length ?? 0);
  const twinEdge = new Int32Array(twinStart[M]);
  const twinFrac = new Float32Array(twinStart[M]);
  for (let e = 0; e < M; e++) {
    const l = lists[e];
    if (!l) continue;
    l.forEach((x, i) => {
      twinEdge[twinStart[e] + i] = x.e;
      twinFrac[twinStart[e] + i] = x.f;
    });
  }
  return { twinStart, twinEdge, twinFrac };
}
