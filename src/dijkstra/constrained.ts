import { astarMultiSource, ellipseFilter } from './astar';
import { RouteWeights, costFromSums } from './cost';
import { CompiledGraph } from './compiled-graph';
import { DijkstraOptions, Endpoint, EngineRoute, NodeFilter, dijkstraMultiSource } from './dijkstra';

/**
 * Presupuesto de desvío (F4): la ruta de menor costo del perfil con largo ≤
 * maxDetourRatio × la distancia mínima entre los mismos puntos, por LARAC
 * (Jüttner et al., 2001) sobre costo + λ·largo, λ ≥ 0.
 *
 * - Solo límite superior (plan §1.11): con un mínimo, c − μ·L puede dejar
 *   aristas con peso ≤ 0 y Dijkstra/A* dejan de servir.
 * - Si la ruta sin restricción cabe en el presupuesto, es la respuesta (λ = 0,
 *   sin brecha). Si no, se recorre la envolvente convexa entre esa ruta (barata
 *   y larga) y la más corta: cada iteración busca con el λ donde las dos rutas
 *   vigentes empatan, hasta que la búsqueda no encuentra nada mejor.
 * - Devuelve la mejor ruta factible encontrada y la cota inferior de
 *   Lagrange, de donde sale la brecha: LARAC no garantiza el óptimo exacto
 *   (puede haber una ruta factible mejor fuera de la envolvente).
 * - Poda elíptica exacta: se descartan los nodos con cota(origen→v) +
 *   cota(v→destino) > largo máximo; todas las rutas factibles sobreviven.
 */

export interface ConstrainedOptions extends Pick<DijkstraOptions, 'blocked' | 'privateAccess' | 'stats'> {
  /** Motor de cada búsqueda: A* (por defecto) o Dijkstra (oráculo en los tests). */
  engine?: 'astar' | 'dijkstra';
  /** Poda elíptica (por defecto sí). */
  prune?: boolean;
  /** Tope de iteraciones de LARAC (seguridad; en la práctica bastan pocas). */
  maxIterations?: number;
}

export interface DetourInfo {
  /** Distancia mínima entre los candidatos de origen y de destino (m). */
  shortestMeters: number;
  /** Largo máximo permitido: maxDetourRatio × shortestMeters. */
  maxMeters: number;
  maxDetourRatio: number;
  /** Largo de la ruta / distancia mínima. */
  detourRatio: number;
  /** λ final (0 si el presupuesto no ata). */
  lambda: number;
  /** Cota inferior de Lagrange del costo óptimo con presupuesto. */
  lowerBound: number;
  /** Brecha relativa (costo − cota) / costo; 0 si el presupuesto no ata. */
  gap: number;
  /** Si el presupuesto cambió la ruta respecto de la óptima sin restricción. */
  binding: boolean;
  /** Búsquedas hechas (la más corta, la sin restricción y una por iteración). */
  searches: number;
}

const REL_EPS = 1e-9;

export function constrainedRoute(
  g: CompiledGraph,
  origins: Endpoint[],
  dests: Endpoint[],
  weights: RouteWeights,
  maxDetourRatio: number,
  opts: ConstrainedOptions = {},
): { route: EngineRoute; detour: DetourInfo } | null {
  const engine = opts.engine === 'dijkstra' ? dijkstraMultiSource : astarMultiSource;
  const base: DijkstraOptions = { blocked: opts.blocked, privateAccess: opts.privateAccess, stats: opts.stats };
  let searches = 0;
  const run = (extra: DijkstraOptions, filter: NodeFilter | null) => {
    searches++;
    return engine(g, origins, dests, weights, { ...base, ...extra }, filter);
  };
  const cost = (r: EngineRoute) => costFromSums(r.sums.len, r.sums.straight, r.sums.unpaved, r.sums.minor, weights);

  const shortest = run({ lengthOnly: true }, null);
  if (!shortest) return null;
  const Lmin = shortest.sums.len;
  const Lmax = maxDetourRatio * Lmin;
  const tol = REL_EPS * Math.max(1, Lmax);
  const feasible = (r: EngineRoute) => r.sums.len <= Lmax + tol;
  const filter = opts.prune === false ? null : ellipseFilter(g, origins, dests, Lmax + tol);

  const finish = (r: EngineRoute, lambda: number, lowerBound: number, binding: boolean) => {
    const c = cost(r);
    return {
      route: { ...r, totalCost: c },
      detour: {
        shortestMeters: Lmin,
        maxMeters: Lmax,
        maxDetourRatio,
        detourRatio: Lmin > 0 ? r.sums.len / Lmin : 1,
        lambda,
        lowerBound,
        gap: c > 0 ? Math.max(0, (c - lowerBound) / c) : 0,
        binding,
        searches,
      },
    };
  };

  // Sin restricción (λ = 0). Siempre hay ruta: la más corta pasa la poda.
  let pc = run({}, filter)!;
  if (feasible(pc)) return finish(pc, 0, cost(pc), false);

  let pd = shortest;
  let cPc = cost(pc);
  let cPd = cost(pd);
  let lambda = 0;
  let lowerBound = cPc;
  const maxIt = opts.maxIterations ?? 50;
  for (let it = 0; it < maxIt; it++) {
    lambda = (cPd - cPc) / (pc.sums.len - pd.sums.len);
    if (!(lambda > 0) || !Number.isFinite(lambda)) break;
    const r = run({ lambda }, filter);
    if (!r) break;
    const cr = cost(r);
    const valR = cr + lambda * r.sums.len;
    const valC = cPc + lambda * pc.sums.len;
    // Cota de Lagrange: min (c + λ·L) − λ·L_max ≤ costo óptimo con presupuesto.
    lowerBound = Math.max(lowerBound, valR - lambda * Lmax);
    if (valR >= valC - REL_EPS * valC) break; // la búsqueda no mejora: λ óptimo
    if (feasible(r)) {
      pd = r;
      cPd = cr;
    } else {
      pc = r;
      cPc = cr;
    }
  }
  return finish(pd, lambda, Math.min(lowerBound, cPd), true);
}
