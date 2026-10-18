import { TramoUse } from './dijkstra';

/**
 * Verificador del RNF-SinRepetición: una ruta no recorre dos veces el mismo
 * tramo, en ningún sentido (sí puede repetir intersecciones). Los usos
 * parciales de un tramo (nodos fantasma) son válidos si sus intervalos no se
 * superponen.
 *
 * `exenciones`: tramos del acceso desde un origen sin salida (puentes, D14),
 * que pueden usarse exactamente dos veces, una en cada sentido.
 */
export interface Exencion {
  chain: number;
}

const EPS_M = 1e-6;

export function sinRepeticionViolations(tramos: TramoUse[], exenciones: Exencion[] = []): string[] {
  const exentos = new Set(exenciones.map((e) => e.chain));
  const byChain = new Map<number, TramoUse[]>();
  for (const u of tramos) {
    if (u.s1 - u.s0 <= EPS_M) continue; // pedazo de largo cero (origen = destino en un extremo)
    const l = byChain.get(u.chain);
    if (l) l.push(u);
    else byChain.set(u.chain, [u]);
  }
  const errors: string[] = [];
  for (const [chain, uses] of byChain) {
    if (exentos.has(chain)) {
      if (uses.length > 2) errors.push(`tramo ${chain}: exento, pero usado ${uses.length} veces (máximo 2)`);
      else if (uses.length === 2 && uses[0].dir === uses[1].dir) errors.push(`tramo ${chain}: exento, pero usado dos veces en el mismo sentido`);
      continue;
    }
    uses.sort((a, b) => a.s0 - b.s0);
    for (let i = 1; i < uses.length; i++) {
      if (uses[i].s0 < uses[i - 1].s1 - EPS_M) {
        errors.push(`tramo ${chain}: [${uses[i - 1].s0.toFixed(1)}, ${uses[i - 1].s1.toFixed(1)}] se superpone con [${uses[i].s0.toFixed(1)}, ${uses[i].s1.toFixed(1)}] m`);
      }
    }
  }
  return errors;
}

/** Lanza un error si la ruta repite algún tramo (ver `sinRepeticionViolations`). */
export function assertSinRepeticion(route: { tramos: TramoUse[] }, exenciones: Exencion[] = []): void {
  const errors = sinRepeticionViolations(route.tramos, exenciones);
  if (errors.length > 0) throw new Error(`RNF-SinRepetición: ${errors.join('; ')}`);
}
