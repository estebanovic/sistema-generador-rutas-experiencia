import { RouteWeights } from './cost';
import { CompiledGraph } from './compiled-graph';
import { Endpoint, EngineRoute, dijkstraMultiSource } from './dijkstra';
import { TramoOverlay } from './overlay';

/**
 * Ruta que pasa por una secuencia de puntos (origen, waypoints…, destino),
 * pierna por pierna (plan §1.11 y §5). Es la primitiva de la ILS (F5).
 *
 * - Cada punto es una lista de candidatos del snap; la pierna i parte del punto
 *   exacto donde terminó la i−1.
 * - RNF-SinRepetición: al terminar cada pierna, sus tramos se bloquean en el
 *   overlay duro y ninguna pierna siguiente puede recorrerlos, ni en pedazos
 *   que se superpongan. Si el bloqueo deja una pierna sin camino, devuelve null.
 * - Vías privadas (D7): solo en el acceso desde el origen (primera pierna) y
 *   hacia el destino (última). Los waypoints nunca abren áreas privadas.
 * - `overlay` permite que la ILS pase tramos ya bloqueados por otras piernas;
 *   `routeVia` le suma los de esta ruta y no lo reinicia.
 */
export function routeVia(
  g: CompiledGraph,
  points: Endpoint[][],
  weights: RouteWeights,
  overlay: TramoOverlay = new TramoOverlay(g),
): EngineRoute | null {
  if (points.length < 2) throw new Error('routeVia necesita al menos un origen y un destino');
  const legs: EngineRoute[] = [];
  let from = points[0];
  for (let i = 1; i < points.length; i++) {
    const leg = dijkstraMultiSource(g, from, points[i], weights, {
      blocked: overlay,
      privateAccess: { origin: i === 1, dest: i === points.length - 1 },
    });
    if (!leg) return null;
    overlay.addRoute(leg);
    legs.push(leg);
    from = [leg.dest!];
  }
  return concatRoutes(legs);
}

const sumBreakdown = (x: Record<string, number>, y: Record<string, number>): Record<string, number> => {
  const out: Record<string, number> = { ...x };
  for (const [k, v] of Object.entries(y)) out[k] = (out[k] ?? 0) + v;
  return out;
};

/** Une piernas consecutivas (cada una empieza donde termina la anterior) en una sola ruta. */
export function concatRoutes(legs: EngineRoute[]): EngineRoute {
  return legs.reduce((a, b) => {
    // El punto de unión se repite al final de a y al inicio de b solo si es un nodo exacto.
    const path = a.path.concat(b.path[0] === a.path[a.path.length - 1] ? b.path.slice(1) : b.path);
    // El punto de unión puede ser un waypoint a mitad de un tramo (no es nodo de unión).
    const nodeIdx = b.nodeIdx[0] === a.nodeIdx[a.nodeIdx.length - 1] ? a.nodeIdx.concat(b.nodeIdx.slice(1)) : a.nodeIdx.concat(b.nodeIdx);
    const la = a.coordinates[a.coordinates.length - 1];
    const fb = b.coordinates[0];
    const coordinates = a.coordinates.concat(la && fb && la[0] === fb[0] && la[1] === fb[1] ? b.coordinates.slice(1) : b.coordinates);
    const dA = a.stats.distanceMeters;
    const dB = b.stats.distanceMeters;
    const total = dA + dB;
    const weighted = (x: number, y: number) => (total > 0 ? (x * dA + y * dB) / total : 0);
    return {
      path,
      coordinates,
      nodeIdx,
      edgeIdx: a.edgeIdx.concat(b.edgeIdx),
      tramos: a.tramos.concat(b.tramos),
      origin: a.origin,
      dest: b.dest,
      totalCost: a.totalCost + b.totalCost,
      stats: {
        distanceMeters: total,
        curviness: weighted(a.stats.curviness, b.stats.curviness),
        curvinessDegPerKm: weighted(a.stats.curvinessDegPerKm, b.stats.curvinessDegPerKm),
        curvyShare: weighted(a.stats.curvyShare, b.stats.curvyShare),
        highwayBreakdown: sumBreakdown(a.stats.highwayBreakdown, b.stats.highwayBreakdown),
        surfaceBreakdown: sumBreakdown(a.stats.surfaceBreakdown, b.stats.surfaceBreakdown),
        surfaceSourceBreakdown: sumBreakdown(a.stats.surfaceSourceBreakdown, b.stats.surfaceSourceBreakdown),
      },
    };
  });
}
