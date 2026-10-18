import { haversine } from './geo';

/**
 * Sinuosidad (desde F0.4): densidad de giro en °/km, calculada sobre la
 * geometría de cada way. Ver plan, §1.1.
 *
 * 1. Se remuestrea el way cada `step` metros.
 * 2. El rumbo en cada punto es el de una cuerda de largo `W` centrada en él
 *    (recortada en los extremos del way): suaviza el ruido de digitalización.
 * 3. Histéresis: solo se cuenta giro cuando el rumbo se aparta al menos
 *    `theta` grados del último rumbo de referencia; el giro acumulado de una
 *    curva suave igual se cuenta completo, pero el zigzag de ±1–2 m no.
 * 4. La densidad de cada segmento crudo es la suma de los giros dentro de
 *    ±`R` metros de su punto medio, dividida por 2R (denominador fijo: un
 *    segmento corto no infla el valor).
 *
 * Propiedad clave: es invariante a la densidad de nodos (agregar nodos
 * colineales no la cambia) y robusta al ruido, a diferencia de la métrica
 * anterior a F0.4, que dividía el giro de cada vértice por el largo de UN
 * segmento.
 */
export interface CurvatureParams {
  /** Largo de la cuerda para el rumbo (m). */
  W: number;
  /** Histéresis: giro mínimo que se cuenta (°). */
  theta: number;
  /** Paso de remuestreo (m). */
  step: number;
  /** Semiancho de la ventana de densidad (m). */
  R: number;
}

export const CURVATURE_PARAMS: CurvatureParams = { W: 100, theta: 5, step: 10, R: 150 };

/** Umbral de "tramo curvo" (°/km): Ruta 68 ≈ 2% de sus metros, Farellones ≈ 86%. */
export const CURVY_THRESHOLD_DEG_PER_KM = 100;

/** Densidad que satura la sinuosidad normalizada en 1 (nivel de Cuesta Barriga/Farellones). */
export const CURVATURE_SATURATION_DEG_PER_KM = 300;

/** Sinuosidad normalizada [0,1] que usa el costo (`straightness = 1 − esto`). */
export function normalizedCurviness(degPerKm: number): number {
  return Math.min(1, Math.max(0, degPerKm / CURVATURE_SATURATION_DEG_PER_KM));
}

const R_EARTH = 6371000;
const D2R = Math.PI / 180;

/** Densidad de giro (°/km) de cada segmento de la polilínea (largo n−1). */
export function turnDensity(
  coords: { lat: number; lon: number }[],
  params: CurvatureParams = CURVATURE_PARAMS,
): Float64Array {
  const n = coords.length;
  const dens = new Float64Array(Math.max(0, n - 1));
  if (n < 2) return dens;
  const { W, theta, step, R } = params;

  // Plano local (equirectangular) en metros y abscisa curvilínea.
  const cos0 = Math.cos(coords[0].lat * D2R);
  const x = new Float64Array(n);
  const y = new Float64Array(n);
  const s = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    x[i] = R_EARTH * coords[i].lon * D2R * cos0;
    y[i] = R_EARTH * coords[i].lat * D2R;
    if (i) s[i] = s[i - 1] + Math.hypot(x[i] - x[i - 1], y[i] - y[i - 1]);
  }
  const L = s[n - 1];
  if (!(L > 0)) return dens;

  const at = (q: number): [number, number] => {
    let lo = 0;
    let hi = n - 1;
    while (hi - lo > 1) {
      const m = (lo + hi) >> 1;
      if (s[m] <= q) lo = m;
      else hi = m;
    }
    const t = s[hi] > s[lo] ? (q - s[lo]) / (s[hi] - s[lo]) : 0;
    return [x[lo] + t * (x[hi] - x[lo]), y[lo] + t * (y[hi] - y[lo])];
  };

  // Giros (posición, magnitud) con histéresis.
  const evQ: number[] = [];
  const evM: number[] = [];
  let ref: number | null = null;
  const half = W / 2;
  for (let q = 0; q <= L + 1e-9; q += step) {
    const a = Math.max(0, q - half);
    const b = Math.min(L, q + half);
    if (b - a < step) continue;
    const pa = at(a);
    const pb = at(b);
    const h = Math.atan2(pb[0] - pa[0], pb[1] - pa[1]) / D2R;
    if (ref === null) {
      ref = h;
      continue;
    }
    let d = h - ref;
    d = ((d + 540) % 360) - 180;
    if (Math.abs(d) >= theta) {
      evQ.push(q);
      evM.push(Math.abs(d));
      ref = h;
    }
  }

  // Densidad por segmento: giros dentro de ±R de su punto medio / 2R.
  let lo = 0;
  let hi = 0;
  let sum = 0;
  for (let i = 0; i < n - 1; i++) {
    const m = (s[i] + s[i + 1]) / 2;
    while (hi < evQ.length && evQ[hi] <= m + R) sum += evM[hi++];
    while (lo < hi && evQ[lo] < m - R) sum -= evM[lo++];
    dens[i] = sum / ((2 * R) / 1000);
  }
  return dens;
}

/** Largo haversine de cada segmento (útil para ponderar por metros). */
export function segmentLengths(coords: { lat: number; lon: number }[]): Float64Array {
  const out = new Float64Array(Math.max(0, coords.length - 1));
  for (let i = 0; i < coords.length - 1; i++) {
    out[i] = haversine(coords[i].lat, coords[i].lon, coords[i + 1].lat, coords[i + 1].lon);
  }
  return out;
}
