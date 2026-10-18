import { CompiledGraph } from './compiled-graph';
import type { TramoUse } from './dijkstra';

const EPS_M = 1e-6;

/**
 * Overlay duro de ocupación de tramos (RNF-SinRepetición, plan §1.11): los
 * tramos —o los pedazos de tramo, en los nodos fantasma— que ya usó una ruta
 * no se pueden volver a recorrer, en ningún sentido. Es una prohibición, no una
 * penalización (a diferencia del overlay blando de las alternativas, F5).
 *
 * - Usos completos: un contador por tramo con sello de época, así `reset()`
 *   cuesta O(1) aunque el overlay se reutilice en miles de consultas (ILS).
 * - Usos parciales: intervalos [s0, s1] en metros desde el inicio de la
 *   geometría del tramo. Dos usos que solo se tocan en un punto (un waypoint a
 *   mitad de tramo) no se superponen.
 * - `add` y `remove` son simétricos: la ILS deshace una pierna restando sus tramos.
 */
export class TramoOverlay {
  private readonly count: Uint16Array;
  private readonly stamp: Uint32Array;
  private epoch = 1;
  private readonly partial = new Map<number, [number, number][]>();

  constructor(private readonly g: CompiledGraph) {
    this.count = new Uint16Array(g.meta.chainCount);
    this.stamp = new Uint32Array(g.meta.chainCount);
  }

  /** Vacía el overlay. */
  reset(): void {
    this.epoch++;
    this.partial.clear();
  }

  private chainLength(c: number): number {
    return this.g.geoCumLen[this.g.chainStart[c + 1] - 1];
  }

  private fullUses(c: number): number {
    return this.stamp[c] === this.epoch ? this.count[c] : 0;
  }

  private isFull(u: TramoUse): boolean {
    return u.s0 <= EPS_M && u.s1 >= this.chainLength(u.chain) - EPS_M;
  }

  add(u: TramoUse): void {
    if (u.s1 - u.s0 <= EPS_M) return; // pedazo de largo cero
    const c = u.chain;
    if (this.isFull(u)) {
      if (this.stamp[c] !== this.epoch) {
        this.stamp[c] = this.epoch;
        this.count[c] = 0;
      }
      this.count[c]++;
      return;
    }
    const l = this.partial.get(c);
    if (l) l.push([u.s0, u.s1]);
    else this.partial.set(c, [[u.s0, u.s1]]);
  }

  remove(u: TramoUse): void {
    if (u.s1 - u.s0 <= EPS_M) return;
    const c = u.chain;
    if (this.isFull(u)) {
      if (this.fullUses(c) > 0) this.count[c]--;
      return;
    }
    const l = this.partial.get(c);
    if (!l) return;
    const i = l.findIndex(([a, b]) => Math.abs(a - u.s0) <= EPS_M && Math.abs(b - u.s1) <= EPS_M);
    if (i >= 0) l.splice(i, 1);
    if (l.length === 0) this.partial.delete(c);
  }

  addRoute(r: { tramos: TramoUse[] }): void {
    for (const u of r.tramos) this.add(u);
  }

  removeRoute(r: { tramos: TramoUse[] }): void {
    for (const u of r.tramos) this.remove(u);
  }

  /** ¿El tramo tiene algún uso? Entonces no se puede recorrer completo. */
  isUsed(c: number): boolean {
    return this.fullUses(c) > 0 || this.partial.has(c);
  }

  /** ¿Se puede recorrer el pedazo [s0, s1] del tramo c sin superponerse con lo ya usado? */
  isFree(c: number, s0: number, s1: number): boolean {
    if (s1 - s0 <= EPS_M) return true;
    if (this.fullUses(c) > 0) return false;
    const l = this.partial.get(c);
    if (!l) return true;
    for (const [a, b] of l) if (s0 < b - EPS_M && a < s1 - EPS_M) return false;
    return true;
  }
}
