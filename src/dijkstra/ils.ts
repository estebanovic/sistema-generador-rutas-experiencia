import { astarMultiSource } from './astar';
import { RouteWeights, costFromSums } from './cost';
import { CompiledGraph } from './compiled-graph';
import { DijkstraOptions, Endpoint, EngineRoute, Position, buildRouteResult, positionAtMeters } from './dijkstra';
import { Exencion, sinRepeticionViolations } from './no-repeat';
import { TramoOverlay } from './overlay';
import {
  CircuitAnchor,
  bridgeTreeCorridor,
  circuitAnchor,
  circuitBand,
  circuitUpperBound,
  lengthsFrom,
  minCycleThrough,
  networkStructure,
} from './structure';
import { concatRoutes } from './via';
import { haversine } from '../graph-compiler/geo';

/**
 * Rutas con longitud objetivo (F5): una ILS sobre waypoints con el mismo
 * mecanismo para las dos variantes.
 *
 * - **Circuito** (origen = destino): parte y termina en el ancla del origen
 *   (D14 ampliada por D19: acceso hasta el núcleo principal, repetido a lo sumo
 *   un 25% del largo total). Si no hay circuito, se entrega una ida y vuelta
 *   declarada (D18), nunca mezclada con un circuito.
 * - **Ruta con destino fijo** (origen ≠ destino): de los candidatos del origen
 *   a los del destino, alargada hasta la longitud pedida.
 *
 * Mecanismo común: una secuencia de waypoints (nodos del núcleo) unidos por
 * piernas de costo mínimo del perfil (A*) con bloqueo duro de los tramos de
 * las demás piernas (RNF-SinRepetición) y penalización blanda de sus calzadas
 * gemelas (D13). Los movimientos (insertar, quitar, reemplazar un waypoint)
 * recalculan solo las piernas tocadas. Se acepta con recocido simulado y se
 * guarda la mejor solución dentro de la banda. Objetivo: costo medio por
 * metro (1 = ideal para el perfil), con penalización fuera de la banda.
 */

export interface TargetLengthRequest {
  /** Candidatos del snap del origen (el primero es el más cercano). */
  origins: (Position & { lat: number; lon: number })[];
  /** Candidatos del destino; vacío o ausente = circuito. */
  dests?: (Position & { lat: number; lon: number })[];
  weights: RouteWeights;
  /** Largo pedido, en metros (incluye el acceso en el circuito). */
  targetMeters: number;
  /** Tolerancia relativa de la banda (por defecto ±15%). */
  tolerance?: number;
  /** Presupuesto de tiempo de la búsqueda (ms). */
  timeBudgetMs?: number;
  /** Semilla del generador (resultados reproducibles). */
  seed?: number;
  /** Tope de acceso repetido sobre el largo total (D19; por defecto 25%). */
  maxAccessShare?: number;
}

export type TargetLengthKind = 'circuito' | 'ida-y-vuelta' | 'ruta';

export interface TargetLengthResult {
  kind: TargetLengthKind;
  route: EngineRoute;
  targetMeters: number;
  tolerance: number;
  achievedMeters: number;
  withinBand: boolean;
  /** Metros recorridos dos veces: el acceso (D19) y, en la ida y vuelta, todo el camino. */
  repeatedMeters: number;
  accessRepeatedMeters: number;
  /** Punto de giro de la ida y vuelta. */
  turnaround?: { lat: number; lon: number };
  /** Por qué se entrega una ida y vuelta o una ruta fuera de la banda. */
  reason?: string;
  /** true si la imposibilidad de un circuito está demostrada (cota estructural o tope de acceso). */
  certain?: boolean;
  /** Tramos exentos de la regla de no repetición (acceso; en la ida y vuelta, todo el camino). */
  exemptions: Exencion[];
  waypoints: number;
  iterations: number;
  elapsedMs: number;
}

const DEFAULT_TOLERANCE = 0.15;
const DEFAULT_BUDGET_MS = 6000;
/** Penalización por salir de la banda, por fracción del objetivo (domina sobre la calidad: el costo por metro va de 1 a 7). */
const BAND_PENALTY = 30;
/** Preferencia leve por acercarse al objetivo dentro de la banda. */
const CLOSENESS = 0.05;
/** Penalización blanda de las calzadas gemelas (D13): ×(1 + β·fracción). */
const TWIN_BETA = 2;

// ── Generador determinista ──
function lcg(seed: number) {
  let s = seed >>> 0 || 1;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

const EARTH = 6371000;
/** Punto a `dist` metros del (lat, lon) con rumbo `brg` (grados). */
function offsetPoint(lat: number, lon: number, brg: number, dist: number): [number, number] {
  const d = dist / EARTH;
  const t = (brg * Math.PI) / 180;
  const f = (lat * Math.PI) / 180;
  return [lat + (d * Math.cos(t) * 180) / Math.PI, lon + (d * Math.sin(t) * 180) / Math.PI / Math.cos(f)];
}

// ── Candidatos a waypoint ──

/** Nodos del núcleo principal en la región, con su "atractivo" para el perfil y una grilla para buscarlos. */
class CandidatePool {
  readonly nodes: number[] = [];
  /** Costo por metro de la mejor arista saliente (1 = ideal para el perfil). */
  readonly factor = new Map<number, number>();
  private readonly grid = new Map<number, number[]>();
  private static readonly CELL = 0.01; // ~1 km
  /** Radio máximo de búsqueda (acota el costo de recorrer la grilla). */
  private static readonly MAX_RADIUS = 30000;

  constructor(
    private readonly g: CompiledGraph,
    weights: RouteWeights,
    inRegion: (u: number) => boolean,
    /** Solo nodos del núcleo (waypoints); si no, cualquier nodo de la región (punto de giro de la ida y vuelta). */
    coreOnly = true,
    /** Con coreOnly: true acepta nodos del núcleo de cualquier bloque (la región ya acota cuáles). */
    anyBlock = false,
  ) {
    const st = networkStructure(g);
    for (let u = 0; u < g.meta.nodeCount; u++) {
      if (!inRegion(u)) continue;
      if (coreOnly ? !st.core[u] || (!anyBlock && st.block[u] !== st.mainBlock) : !g.nodeInMainScc[u]) continue;
      let best = Infinity;
      for (let e = g.outStart[u]; e < g.outStart[u + 1]; e++) {
        const L = g.edgeLen[e];
        if (L <= 0) continue;
        best = Math.min(best, costFromSums(L, g.edgeSumStraight[e], g.edgeSumUnpaved[e], g.edgeSumMinor[e], weights) / L);
      }
      if (!Number.isFinite(best)) continue;
      this.nodes.push(u);
      this.factor.set(u, best);
      const k = this.key(g.nodeLat[u], g.nodeLon[u]);
      const l = this.grid.get(k);
      if (l) l.push(u);
      else this.grid.set(k, [u]);
    }
  }

  private key(lat: number, lon: number) {
    return CandidatePool.cellKey(Math.floor(lat / CandidatePool.CELL), Math.floor(lon / CandidatePool.CELL));
  }

  private static cellKey(i: number, j: number) {
    return i * 1e6 + j;
  }

  /**
   * Un nodo cerca de (lat, lon): entre hasta `sample` candidatos al azar dentro
   * de `radius`, el más atractivo para el perfil (torneo). Amplía el radio si
   * no hay ninguno.
   */
  near(lat: number, lon: number, radius: number, rnd: () => number, exclude: Set<number>, sample = 6): number | null {
    const r0 = Math.min(radius, CandidatePool.MAX_RADIUS);
    for (let r = r0; r <= Math.min(r0 * 8, CandidatePool.MAX_RADIUS); r *= 2) {
      const span = Math.ceil(r / 1000 / (CandidatePool.CELL * 111)) + 1;
      const ci = Math.floor(lat / CandidatePool.CELL);
      const cj = Math.floor(lon / CandidatePool.CELL);
      const found: number[] = [];
      for (let i = ci - span; i <= ci + span; i++) {
        for (let j = cj - span; j <= cj + span; j++) {
          for (const u of this.grid.get(CandidatePool.cellKey(i, j)) ?? []) {
            if (!exclude.has(u) && haversine(lat, lon, this.g.nodeLat[u], this.g.nodeLon[u]) <= r) found.push(u);
          }
        }
      }
      if (found.length) {
        let best = -1;
        for (let k = 0; k < sample; k++) {
          const u = found[Math.floor(rnd() * found.length)];
          if (best < 0 || this.factor.get(u)! < this.factor.get(best)!) best = u;
        }
        return best;
      }
    }
    return null;
  }
}

// ── Solución: waypoints y piernas, con evaluación incremental ──

interface Snapshot {
  wps: number[];
  legs: EngineRoute[];
}

class Solution {
  wps: number[] = [];
  legs: EngineRoute[] = [];
  /**
   * Peso del largo en las piernas (costo + λ·largo, como en LARAC). Empieza en 0;
   * la búsqueda lo sube si la ruta queda más larga que la banda (piernas del
   * perfil que se desvían mucho, por ejemplo 4x4 buscando ripio).
   */
  lambda = 0;
  readonly overlay: TramoOverlay;
  readonly twin: Float32Array;

  constructor(
    private readonly g: CompiledGraph,
    private readonly weights: RouteWeights,
    private readonly start: Endpoint[],
    private readonly end: Endpoint[],
    /** Tramos que ninguna pierna puede usar (el acceso del circuito). */
    blockedBase: EngineRoute[],
  ) {
    this.overlay = new TramoOverlay(g);
    for (const r of blockedBase) this.overlay.addRoute(r);
    this.twin = new Float32Array(g.meta.edgeCount);
  }

  get meters() {
    return this.legs.reduce((s, l) => s + l.sums.len, 0);
  }

  get cost() {
    return this.legs.reduce((s, l) => s + costFromSums(l.sums.len, l.sums.straight, l.sums.unpaved, l.sums.minor, this.weights), 0);
  }

  private mark(leg: EngineRoute, sign: 1 | -1) {
    if (sign > 0) this.overlay.addRoute(leg);
    else this.overlay.removeRoute(leg);
    const g = this.g;
    for (const e of leg.edgeIdx) {
      for (let k = g.twinStart[e]; k < g.twinStart[e + 1]; k++) {
        const t = g.twinEdge[k];
        this.twin[t] = Math.max(0, this.twin[t] + sign * TWIN_BETA * g.twinFrac[k]);
      }
    }
  }

  private legBetween(j: number, wps: number[]): EngineRoute | null {
    const from = j === 0 ? this.start : [{ node: wps[j - 1] }];
    const to = j === wps.length ? this.end : [{ node: wps[j] }];
    const opts: DijkstraOptions = {
      blocked: this.overlay,
      edgeFactor: this.twin,
      lambda: this.lambda,
      privateAccess: { origin: j === 0, dest: j === wps.length },
    };
    return astarMultiSource(this.g, from, to, this.weights, opts);
  }

  /** Construye todas las piernas desde cero; false si alguna no tiene camino. */
  build(wps: number[]): boolean {
    for (const l of this.legs) this.mark(l, -1);
    this.legs = [];
    this.wps = [...wps];
    for (let j = 0; j <= wps.length; j++) {
      const leg = this.legBetween(j, this.wps);
      if (!leg) {
        for (const l of this.legs) this.mark(l, -1);
        this.legs = [];
        return false;
      }
      this.mark(leg, 1);
      this.legs.push(leg);
    }
    return true;
  }

  snapshot(): Snapshot {
    return { wps: [...this.wps], legs: [...this.legs] };
  }

  /**
   * Cambia los waypoints a `wps`: las piernas viejas [a, bOld) se reemplazan
   * por piernas nuevas [a, bNew), calculadas con las demás bloqueadas.
   * Devuelve una función para deshacer, o null si alguna pierna no tiene camino.
   */
  apply(wps: number[], a: number, bOld: number, bNew: number): (() => void) | null {
    const old = this.legs.slice(a, bOld);
    for (const l of old) this.mark(l, -1);
    const fresh: EngineRoute[] = [];
    for (let j = a; j < bNew; j++) {
      const leg = this.legBetween(j, wps);
      if (!leg) {
        for (const l of fresh) this.mark(l, -1);
        for (const l of old) this.mark(l, 1);
        return null;
      }
      this.mark(leg, 1);
      fresh.push(leg);
    }
    const prevWps = this.wps;
    this.legs.splice(a, bOld - a, ...fresh);
    this.wps = [...wps];
    return () => {
      for (const l of fresh) this.mark(l, -1);
      for (const l of old) this.mark(l, 1);
      this.legs.splice(a, bNew - a, ...old);
      this.wps = prevWps;
    };
  }

  restore(s: Snapshot) {
    for (const l of this.legs) this.mark(l, -1);
    this.wps = [...s.wps];
    this.legs = [...s.legs];
    for (const l of this.legs) this.mark(l, 1);
  }

  route(): EngineRoute {
    return concatRoutes(this.legs);
  }
}

// ── Búsqueda ──

interface SearchSpec {
  start: Endpoint[];
  end: Endpoint[];
  startPt: { lat: number; lon: number };
  endPt: { lat: number; lon: number };
  /** Banda del tramo que arma la ILS (sin el acceso). */
  lo: number;
  hi: number;
  target: number;
  circuit: boolean;
  /** Si los puntos de giro pueden estar fuera del núcleo principal (corredor del destino fijo). */
  anyCore?: boolean;
  blockedBase: EngineRoute[];
  inRegion: (u: number) => boolean;
}

interface SearchOutcome {
  best: Snapshot | null;
  bestObj: number;
  closest: Snapshot | null;
  iterations: number;
}

function runIls(g: CompiledGraph, weights: RouteWeights, spec: SearchSpec, budgetMs: number, rnd: () => number): SearchOutcome {
  const t0 = Date.now();
  const sol = new Solution(g, weights, spec.start, spec.end, spec.blockedBase);
  const pool = new CandidatePool(g, weights, spec.inRegion, true, spec.anyCore);
  const { lo, hi, target } = spec;
  const objective = () => {
    const len = sol.meters;
    if (sol.legs.length === 0 || len <= 0) return Infinity;
    const viol = Math.max(0, lo - len, len - hi) / target;
    return sol.cost / len + BAND_PENALTY * viol + CLOSENESS * (Math.abs(len - target) / target);
  };
  const inBand = () => sol.meters >= lo && sol.meters <= hi;
  let best: Snapshot | null = null;
  let bestObj = Infinity;
  let closest: Snapshot | null = null;
  let closestGap = Infinity;
  const record = () => {
    const o = objective();
    if (inBand() && o < bestObj) {
      bestObj = o;
      best = sol.snapshot();
    }
    const gap = Math.abs(sol.meters - target);
    if (gap < closestGap) {
      closestGap = gap;
      closest = sol.snapshot();
    }
    return o;
  };
  if (pool.nodes.length === 0) {
    if (!spec.circuit && sol.build([])) record();
    return { best, bestObj, closest, iterations: 0 };
  }

  // ── Soluciones iniciales ──
  const used = new Set<number>();
  const initial: number[][] = [];
  if (spec.circuit) {
    // Waypoints sobre una circunferencia que pasa por el ancla, en orden angular (F5: orden angular adoptado).
    for (let a = 0; a < 8; a++) {
      const k = Math.min(7, Math.max(2, Math.round(target / 14000) + (a % 3) - 1));
      const scale = [0.8, 0.65, 0.95, 0.55, 1.1, 0.7, 0.85, 1.0][a];
      const r = (target / (2 * Math.PI)) * scale;
      const brg = rnd() * 360;
      const [clat, clon] = offsetPoint(spec.startPt.lat, spec.startPt.lon, brg, r);
      const wps: number[] = [];
      const sense = a % 2 === 0 ? 1 : -1;
      for (let j = 0; j < k; j++) {
        const ang = brg + 180 + (sense * 360 * (j + 1)) / (k + 1);
        const [plat, plon] = offsetPoint(clat, clon, ang, r);
        const w = pool.near(plat, plon, r * 0.25, rnd, new Set(wps));
        if (w !== null) wps.push(w);
      }
      if (wps.length) initial.push(wps);
    }
    // 1 punto de giro (como el constructor del techo) y una cuña con 2: funcionan
    // en valles angostos, donde la circunferencia cae sobre los cerros.
    const extra: number[][] = [];
    for (let a = 0; a < 10; a++) {
      const brg = rnd() * 360;
      if (a % 2 === 0) {
        const d = target * [0.3, 0.38, 0.24, 0.45, 0.34][(a / 2) % 5];
        const [plat, plon] = offsetPoint(spec.startPt.lat, spec.startPt.lon, brg, d);
        const w = pool.near(plat, plon, d * 0.3, rnd, new Set());
        if (w !== null) extra.push([w]);
      } else {
        const d = target * 0.28;
        const ws: number[] = [];
        for (const delta of [-35, 35]) {
          const [plat, plon] = offsetPoint(spec.startPt.lat, spec.startPt.lon, brg + delta, d);
          const w = pool.near(plat, plon, d * 0.3, rnd, new Set(ws));
          if (w !== null) ws.push(w);
        }
        if (ws.length === 2) extra.push(ws);
      }
    }
    // Intercaladas con las de la circunferencia.
    const mixed: number[][] = [];
    for (let i = 0; i < Math.max(initial.length, extra.length); i++) {
      if (initial[i]) mixed.push(initial[i]);
      if (extra[i]) mixed.push(extra[i]);
    }
    initial.splice(0, initial.length, ...mixed);
  } else {
    initial.push([]);
    const direct = haversine(spec.startPt.lat, spec.startPt.lon, spec.endPt.lat, spec.endPt.lon);
    const brg = Math.atan2(
      (spec.endPt.lon - spec.startPt.lon) * Math.cos((spec.startPt.lat * Math.PI) / 180),
      spec.endPt.lat - spec.startPt.lat,
    ) * (180 / Math.PI);
    // Arco entre origen y destino con la flecha que da aproximadamente el largo pedido (las vías son ~25% más largas que la recta).
    const straightTarget = target / 1.25;
    for (let a = 0; a < 8; a++) {
      const k = Math.min(5, Math.max(1, Math.round((target - direct) / 15000) + (a % 2)));
      const side = a % 2 === 0 ? 1 : -1;
      const scale = [1, 1, 0.8, 0.8, 1.2, 1.2, 0.65, 0.65][a];
      const half = direct / 2;
      const h = Math.sqrt(Math.max(0, ((straightTarget * scale) / 2) ** 2 - half ** 2));
      const wps: number[] = [];
      for (let j = 0; j < k; j++) {
        const f = (j + 1) / (k + 1);
        const [mlat, mlon] = offsetPoint(spec.startPt.lat, spec.startPt.lon, brg, direct * f);
        const [plat, plon] = offsetPoint(mlat, mlon, brg + 90 * side, h * Math.sin(Math.PI * f));
        const w = pool.near(plat, plon, Math.max(1500, h * 0.25), rnd, new Set(wps));
        if (w !== null) wps.push(w);
      }
      if (wps.length) initial.push(wps);
    }
  }
  let bestInit: Snapshot | null = null;
  let bestInitObj = Infinity;
  let built = 0;
  for (const wps of initial) {
    if (Date.now() - t0 > budgetMs * 0.4) break;
    // Basta con unas pocas soluciones iniciales válidas si alguna ya está en la banda.
    if (built >= 4 && best) break;
    if (!sol.build(wps)) continue;
    built++;
    const o = record();
    if (o < bestInitObj) {
      bestInitObj = o;
      bestInit = sol.snapshot();
    }
  }
  if (!bestInit) return { best, bestObj, closest, iterations: 0 };
  sol.restore(bestInit);
  // Piernas del perfil demasiado largas: subir el peso del largo hasta entrar a la banda.
  if (!best && sol.meters > hi) {
    for (const lambda of [0.5, 1, 2, 4, 8]) {
      if (Date.now() - t0 > budgetMs * 0.5) break;
      const prev = sol.snapshot();
      const prevLambda = sol.lambda;
      sol.lambda = lambda;
      if (!sol.build(sol.wps)) {
        sol.lambda = prevLambda;
        sol.restore(prev);
        continue;
      }
      record();
      if (sol.meters <= hi) break;
    }
  }
  for (const w of sol.wps) used.add(w);

  // ── Búsqueda local con recocido ──
  let cur = objective();
  let iterations = 0;
  let sinceBest = 0;
  const T0 = 0.05;
  while (Date.now() - t0 < budgetMs) {
    iterations++;
    const progress = (Date.now() - t0) / budgetMs;
    const T = T0 * (1 - progress) + 0.001;
    const len = sol.meters;
    const n = sol.wps.length;
    const centroid = (() => {
      let la = spec.startPt.lat + spec.endPt.lat;
      let lo2 = spec.startPt.lon + spec.endPt.lon;
      for (const w of sol.wps) {
        la += g.nodeLat[w];
        lo2 += g.nodeLon[w];
      }
      return [la / (n + 2), lo2 / (n + 2)] as [number, number];
    })();
    const pointOf = (j: number): [number, number] =>
      j < 0 ? [spec.startPt.lat, spec.startPt.lon] : j >= n ? [spec.endPt.lat, spec.endPt.lon] : [g.nodeLat[sol.wps[j]], g.nodeLon[sol.wps[j]]];
    const outward = (p: [number, number]) => Math.atan2((p[1] - centroid[1]) * Math.cos((p[0] * Math.PI) / 180), p[0] - centroid[0]) * (180 / Math.PI);
    // Elección del movimiento según el largo actual.
    const r = rnd();
    let kind: 'insert' | 'remove' | 'replace';
    if (len < lo) kind = r < 0.6 || n === 0 ? 'insert' : 'replace';
    else if (len > hi) kind = n > 0 && r < 0.5 ? 'remove' : n > 0 ? 'replace' : 'insert';
    else kind = n === 0 ? 'insert' : r < 0.6 ? 'replace' : r < 0.8 ? 'insert' : 'remove';
    if (kind === 'remove' && n <= (spec.circuit ? 2 : 0)) kind = 'replace';
    if (kind === 'replace' && n === 0) kind = 'insert';
    let undo: (() => void) | null = null;
    const exclude = new Set(sol.wps);
    if (kind === 'insert') {
      const p = Math.floor(rnd() * (n + 1)); // entre el punto p−1 y el p
      const A = pointOf(p - 1);
      const B = pointOf(p);
      const mid: [number, number] = [(A[0] + B[0]) / 2, (A[1] + B[1]) / 2];
      const legLen = sol.legs[p]?.sums.len ?? 1000;
      const push = len < lo ? Math.min((lo - len) / 2, legLen) : legLen * 0.2 * rnd();
      const [plat, plon] = offsetPoint(mid[0], mid[1], outward(mid) + (rnd() - 0.5) * 60, push);
      const w = pool.near(plat, plon, Math.max(800, push * 0.4), rnd, exclude);
      if (w !== null) {
        const wps = [...sol.wps.slice(0, p), w, ...sol.wps.slice(p)];
        undo = sol.apply(wps, p, p + 1, p + 2);
      }
    } else if (kind === 'remove') {
      const p = Math.floor(rnd() * n);
      const wps = [...sol.wps.slice(0, p), ...sol.wps.slice(p + 1)];
      undo = sol.apply(wps, p, p + 2, p + 1);
    } else {
      const p = Math.floor(rnd() * n);
      const P = pointOf(p);
      const step = target * (0.02 + 0.08 * rnd());
      const dir = len < lo ? outward(P) : len > hi ? outward(P) + 180 : rnd() * 360;
      const [plat, plon] = offsetPoint(P[0], P[1], dir, step);
      const w = pool.near(plat, plon, Math.max(600, step * 0.5), rnd, exclude);
      if (w !== null) {
        const wps = [...sol.wps];
        wps[p] = w;
        undo = sol.apply(wps, p, p + 2, p + 2);
      }
    }
    if (!undo) continue;
    const next = record();
    if (next <= cur || rnd() < Math.exp(-(next - cur) / T)) {
      cur = next;
    } else {
      undo();
    }
    if (best && next <= bestObj) sinceBest = 0;
    else sinceBest++;
    // Reinicio desde la mejor solución si se estancó.
    if (sinceBest > 40 && best) {
      sol.restore(best);
      cur = objective();
      sinceBest = 0;
    }
    // Corte temprano: hay solución en la banda y no mejora hace rato.
    if (best && iterations > 120 && sinceBest > 30) break;
  }
  return { best, bestObj, closest, iterations };
}

// ── Ida y vuelta declarada (D18) ──

/** La misma ruta recorrida al revés, o null si algún tramo es de un solo sentido. */
export function reverseRoute(g: CompiledGraph, r: EngineRoute): EngineRoute | null {
  const pieces: { from: Position; to: Position }[] = [];
  for (let i = r.tramos.length - 1; i >= 0; i--) {
    const u = r.tramos[i];
    // dir 1: se recorrió s0→s1 (sentido de la geometría); al revés se necesita el sentido contrario.
    if (u.dir === 1 ? g.chainBwd[u.chain] < 0 : g.chainFwd[u.chain] < 0) return null;
    const a = positionAtMeters(g, u.chain, u.s0);
    const b = positionAtMeters(g, u.chain, u.s1);
    pieces.push(u.dir === 1 ? { from: b, to: a } : { from: a, to: b });
  }
  const edges = [...r.edgeIdx].reverse().map((e) => (g.edgeDir[e] === 0 ? g.chainBwd[g.edgeChain[e]] : g.chainFwd[g.edgeChain[e]]));
  const back = buildRouteResult(g, pieces, [...r.nodeIdx].reverse(), edges, r.totalCost);
  return { ...back, origin: r.dest, dest: r.origin };
}

/**
 * Vuelta de una ida y vuelta cuando la ida tiene tramos de un solo sentido: se
 * busca aparte y, si usaría algún tramo en el mismo sentido que la ida, ese
 * tramo se bloquea y se vuelve a buscar (hasta 4 veces).
 */
function separateReturn(g: CompiledGraph, weights: RouteWeights, out: EngineRoute, from: Endpoint, to: Endpoint, base: EngineRoute[]): EngineRoute | null {
  const ov = new TramoOverlay(g);
  for (const r of base) ov.addRoute(r);
  const outDir = new Map<number, number>();
  for (const u of out.tramos) outDir.set(u.chain, u.dir);
  for (let attempt = 0; attempt < 4; attempt++) {
    // La vuelta puede entrar al área privada del origen (D7).
    const back = astarMultiSource(g, [from], [to], weights, { blocked: ov, privateAccess: { origin: false, dest: true } });
    if (!back) return null;
    const both = [...out.tramos, ...back.tramos];
    if (sinRepeticionViolations(both, [...new Set(both.map((u) => u.chain))].map((chain) => ({ chain }))).length === 0) return back;
    for (const u of back.tramos) {
      if (outDir.get(u.chain) === u.dir) ov.add({ chain: u.chain, s0: 0, s1: g.geoCumLen[g.chainStart[u.chain + 1] - 1], dir: 1 });
    }
  }
  return null;
}

function outAndBack(
  g: CompiledGraph,
  weights: RouteWeights,
  anchor: CircuitAnchor,
  L: number,
  tol: number,
  rnd: () => number,
): { route: EngineRoute; turn: { lat: number; lon: number }; within: boolean; exemptChains: Set<number> } | null {
  const lo = (1 - tol) * L;
  const hi = (1 + tol) * L;
  // Largo de ida buscado (sin el acceso): (L − acceso) / 2.
  const oneWay = Math.max(300, (L - anchor.accessMeters) / 2);
  // La ida y la vuelta no pueden volver a usar el acceso (ya se recorre dos veces).
  const access = [anchor.accessOut, anchor.accessBack].filter((r): r is EngineRoute => r !== null);
  const accessOverlay = new TramoOverlay(g);
  for (const r of access) accessOverlay.addRoute(r);
  // Puntos de giro por distancia de red (en un valle, la recta no sirve): el giro
  // es un punto de un tramo a distancia de red d, no necesariamente un nodo (se
  // puede dar la vuelta a mitad de un camino).
  const dist = lengthsFrom(g, anchor.ep, oneWay * 1.5);
  const factorOf = (e: number) => costFromSums(g.edgeLen[e], g.edgeSumStraight[e], g.edgeSumUnpaved[e], g.edgeSumMinor[e], weights) / Math.max(1, g.edgeLen[e]);
  const usedChains = new Set<number>();
  /** Un punto a distancia de red d: entre unas pocas aristas que la cruzan, la más atractiva para el perfil. */
  const pickAt = (d: number): Position | null => {
    const crossing: number[] = [];
    for (let u = 0; u < g.meta.nodeCount; u++) {
      if (!(dist[u] < d)) continue;
      for (let e = g.outStart[u]; e < g.outStart[u + 1]; e++) {
        const c = g.edgeChain[e];
        if ((g.edgeFlags[e] & 1) !== 0 || accessOverlay.isUsed(c) || usedChains.has(c)) continue;
        if (dist[u] + g.edgeLen[e] >= d) crossing.push(e);
      }
    }
    if (!crossing.length) return null;
    let e = -1;
    for (let k = 0; k < 6; k++) {
      const x = crossing[Math.floor(rnd() * crossing.length)];
      if (e < 0 || factorOf(x) < factorOf(e)) e = x;
    }
    const c = g.edgeChain[e];
    usedChains.add(c);
    const into = d - dist[g.edgeFrom[e]];
    const len = g.geoCumLen[g.chainStart[c + 1] - 1];
    return positionAtMeters(g, c, g.edgeDir[e] === 0 ? into : len - into);
  };
  // La ida por el perfil suele ser más larga que la más corta: se parte de 0,85 y se
  // ajusta por bisección entre el último giro que quedó corto y el último que se pasó
  // (el largo puede saltar cuando el perfil cambia de camino).
  let center = oneWay * 0.85;
  let dShort = 0;
  let dLong = Infinity;
  let best: { route: EngineRoute; turn: Position; score: number; total: number } | null = null;
  for (let i = 0; i < 16; i++) {
    const turn = pickAt(center);
    if (!turn) {
      center *= 0.8;
      continue;
    }
    // La ida puede salir del área privada del origen (D7); el giro nunca es privado.
    const out = astarMultiSource(g, [anchor.ep], [turn], weights, { blocked: accessOverlay, privateAccess: { origin: true, dest: false } });
    if (!out || out.sums.len <= 0) continue;
    // Vuelta por el mismo camino; si algún tramo es de un solo sentido, la vuelta
    // se calcula aparte y se acepta si no repite tramos en el mismo sentido.
    const back = reverseRoute(g, out) ?? separateReturn(g, weights, out, turn, anchor.ep, access);
    if (!back) continue;
    const total = anchor.accessMeters + out.sums.len + back.sums.len;
    const c = costFromSums(out.sums.len, out.sums.straight, out.sums.unpaved, out.sums.minor, weights) / out.sums.len;
    // Dentro de la banda gana siempre; fuera, la más cercana a la banda.
    const viol = Math.max(0, lo - total, total - hi) / L;
    const score = viol > 0 ? 1000 + viol : c;
    if (!best || score < best.score) best = { route: concatRoutes([out, back]), turn, score, total };
    if (total >= lo && total <= hi && i >= 5) break; // ya hay una en la banda y se probaron varias
    const wanted = (L - anchor.accessMeters) / 2;
    const got = (out.sums.len + back.sums.len) / 2;
    if (total < lo) dShort = Math.max(dShort, center);
    else if (total > hi) dLong = Math.min(dLong, center);
    if (dLong < Infinity && dShort > 0 && dLong > dShort) center = (dShort + dLong) / 2;
    else center = Math.min(oneWay * 1.5, Math.max(100, center * (wanted / got)));
  }
  if (!best) return null;
  const parts = [anchor.accessOut, best.route, anchor.accessBack].filter((r): r is EngineRoute => r !== null);
  const route = parts.length > 1 ? concatRoutes(parts) : parts[0];
  const exemptChains = new Set(route.tramos.map((u) => u.chain));
  const t = best.turn;
  const turn = {
    lat: g.geoLat[t.point] + t.t * (g.geoLat[t.point + 1] - g.geoLat[t.point]),
    lon: g.geoLon[t.point] + t.t * (g.geoLon[t.point + 1] - g.geoLon[t.point]),
  };
  return { route, turn, within: best.total >= lo && best.total <= hi, exemptChains };
}

// ── Punto de entrada ──

export function targetLengthRoute(g: CompiledGraph, req: TargetLengthRequest): TargetLengthResult | { error: string } {
  const t0 = Date.now();
  const tol = req.tolerance ?? DEFAULT_TOLERANCE;
  const L = req.targetMeters;
  const budget = req.timeBudgetMs ?? DEFAULT_BUDGET_MS;
  const rnd = lcg(req.seed ?? 20261018);
  const share = req.maxAccessShare ?? 0.25;
  if (!req.origins.length) return { error: 'sin candidatos de origen' };
  const base = {
    targetMeters: L,
    tolerance: tol,
  };

  // ── Ruta con destino fijo ──
  if (req.dests && req.dests.length) {
    const o = req.origins[0];
    const d = req.dests[0];
    const lo = (1 - tol) * L;
    const hi = (1 + tol) * L;
    // Puntos de giro: uniones con ciclos de los bloques del corredor del árbol de puentes
    // (una ruta sin repetir tramos no puede entrar a un ramal lateral), dentro de la elipse.
    const st = networkStructure(g);
    const corridor = bridgeTreeCorridor(g, [g.chainNode0[o.chain], g.chainNode1[o.chain]], [g.chainNode0[d.chain], g.chainNode1[d.chain]]);
    const inRegion = (u: number) =>
      (!corridor || corridor.blocks.has(st.block[u])) &&
      haversine(o.lat, o.lon, g.nodeLat[u], g.nodeLon[u]) + haversine(g.nodeLat[u], g.nodeLon[u], d.lat, d.lon) <= hi;
    const out = runIls(g, req.weights, {
      start: req.origins,
      end: req.dests,
      startPt: o,
      endPt: d,
      lo,
      hi,
      target: L,
      circuit: false,
      blockedBase: [],
      inRegion,
      anyCore: true,
    }, budget, rnd);
    const pick = out.best ?? out.closest;
    if (!pick) return { error: 'no hay camino entre el origen y el destino sin pasar por vías privadas' };
    const route = concatRoutes(pick.legs);
    const achieved = route.sums.len;
    const within = achieved >= lo && achieved <= hi;
    return {
      ...base,
      kind: 'ruta',
      route: { ...route, totalCost: pick.legs.reduce((s, l) => s + costFromSums(l.sums.len, l.sums.straight, l.sums.unpaved, l.sums.minor, req.weights), 0) },
      achievedMeters: achieved,
      withinBand: within,
      repeatedMeters: 0,
      accessRepeatedMeters: 0,
      reason: within ? undefined : achieved < lo ? 'no se encontró una ruta tan larga sin repetir tramos; se entrega la más cercana' : 'no se encontró una ruta tan corta; se entrega la más cercana',
      exemptions: [],
      waypoints: pick.wps.length,
      iterations: out.iterations,
      elapsedMs: Date.now() - t0,
    };
  }

  // ── Circuito ──
  const anchor = circuitAnchor(g, req.origins[0]);
  if ('error' in anchor) return { error: anchor.error };
  const declareOutAndBack = (reason: string, certain: boolean, iterations: number): TargetLengthResult | { error: string } => {
    // D18: hacia un punto a la mitad de la longitud y de regreso, desde el origen mismo
    // (todo se recorre dos veces, así que no hace falta llegar al núcleo principal).
    const o0 = req.origins[0];
    const fromOrigin: CircuitAnchor = { ep: o0, lat: o0.lat, lon: o0.lon, nodes: [g.chainNode0[o0.chain], g.chainNode1[o0.chain]], accessOut: null, accessBack: null, accessMeters: 0 };
    const ob = outAndBack(g, req.weights, fromOrigin, L, tol, rnd);
    if (!ob) return { error: `no hay circuito ni ida y vuelta posible: ${reason}` };
    const achieved = ob.route.sums.len;
    return {
      ...base,
      kind: 'ida-y-vuelta',
      route: { ...ob.route, totalCost: costFromSums(ob.route.sums.len, ob.route.sums.straight, ob.route.sums.unpaved, ob.route.sums.minor, req.weights) },
      achievedMeters: achieved,
      withinBand: ob.within,
      repeatedMeters: achieved,
      accessRepeatedMeters: 0,
      turnaround: ob.turn,
      reason,
      certain,
      exemptions: [...ob.exemptChains].map((chain) => ({ chain })),
      waypoints: 1,
      iterations,
      elapsedMs: Date.now() - t0,
    };
  };
  const band = circuitBand(L, tol, anchor.accessMeters, share);
  if (!band) {
    return declareOutAndBack(
      `el acceso hasta la red con circuitos (${(anchor.accessMeters / 2000).toFixed(1)} km por sentido) superaría el ${Math.round(share * 100)}% del largo pedido`,
      true,
      0,
    );
  }
  // Cotas: si no hay circuito posible, ida y vuelta sin buscar.
  const bound = circuitUpperBound(g, anchor, band.hi / 2);
  if (bound.total < band.lo) return declareOutAndBack('no existe un circuito de ese largo sin repetir tramos desde este origen', true, 0);
  const cyc = minCycleThrough(g, anchor);
  if (cyc > band.hi) return declareOutAndBack('el circuito más corto posible desde este origen es más largo que lo pedido', true, 0);

  const nodes = bound.nodes!;
  const target = Math.min(band.hi, Math.max(band.lo, L - anchor.accessMeters));
  const blockedBase = [anchor.accessOut, anchor.accessBack].filter((r): r is EngineRoute => r !== null);
  const out = runIls(g, req.weights, {
    start: [anchor.ep],
    end: [anchor.ep],
    startPt: anchor,
    endPt: anchor,
    lo: band.lo,
    hi: band.hi,
    target,
    circuit: true,
    blockedBase,
    inRegion: (u) => nodes[u] === 1,
  }, budget, rnd);
  if (!out.best) return declareOutAndBack('no se encontró un circuito de ese largo sin repetir tramos', false, out.iterations);
  const best = out.best as Snapshot;
  const parts = [anchor.accessOut, ...best.legs, anchor.accessBack].filter((r): r is EngineRoute => r !== null);
  const route = concatRoutes(parts);
  const exemptions: Exencion[] = [...new Set(blockedBase.flatMap((r) => r.tramos.map((u) => u.chain)))].map((chain) => ({ chain }));
  // Garantía: el circuito nunca repite tramos fuera del acceso.
  if (sinRepeticionViolations(route.tramos, exemptions).length > 0) {
    return declareOutAndBack('el circuito encontrado no pasó el verificador de no repetición', false, out.iterations);
  }
  const achieved = route.sums.len;
  return {
    ...base,
    kind: 'circuito',
    route: { ...route, totalCost: costFromSums(route.sums.len, route.sums.straight, route.sums.unpaved, route.sums.minor, req.weights) },
    achievedMeters: achieved,
    withinBand: achieved >= (1 - tol) * L && achieved <= (1 + tol) * L,
    repeatedMeters: anchor.accessMeters,
    accessRepeatedMeters: anchor.accessMeters,
    exemptions,
    waypoints: best.wps.length,
    iterations: out.iterations,
    elapsedMs: Date.now() - t0,
  };
}

