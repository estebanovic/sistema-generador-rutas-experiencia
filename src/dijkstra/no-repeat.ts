import { TramoUse } from './dijkstra';

/**
 * Verificador del RNF-SinRepetición: una ruta no recorre dos veces el mismo
 * tramo, en ningún sentido (sí puede repetir intersecciones). Los usos
 * parciales de un tramo (nodos fantasma) son válidos si sus intervalos no se
 * superponen.
 *
 * `exenciones`: tramos del acceso desde un origen sin salida (puentes, D14 y
 * D19) o de una ida y vuelta declarada (D18): cada punto del tramo puede
 * recorrerse a lo sumo dos veces, en sentidos opuestos. Usos que no se
 * superponen (por ejemplo, los dos pedazos de una calle de un sentido a cada
 * lado del origen) no cuentan como repetición.
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
      // Pares que se superponen: deben ir en sentidos opuestos, y ningún punto puede cubrirse tres veces.
      let sameDir = false;
      for (let i = 0; i < uses.length; i++) {
        for (let j = i + 1; j < uses.length; j++) {
          const overlap = Math.min(uses[i].s1, uses[j].s1) - Math.max(uses[i].s0, uses[j].s0);
          if (overlap > EPS_M && uses[i].dir === uses[j].dir) sameDir = true;
        }
      }
      const events = uses.flatMap((u) => [[u.s0, 1], [u.s1, -1]] as [number, number][]).sort((a, b) => a[0] - b[0] || a[1] - b[1]);
      let depth = 0;
      let maxDepth = 0;
      for (const [, d] of events) {
        depth += d;
        maxDepth = Math.max(maxDepth, depth);
      }
      if (maxDepth > 2) errors.push(`tramo ${chain}: exento, pero recorrido ${maxDepth} veces (máximo 2)`);
      else if (sameDir) errors.push(`tramo ${chain}: exento, pero recorrido dos veces en el mismo sentido`);
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
