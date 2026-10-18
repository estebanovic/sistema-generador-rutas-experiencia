/** Utilidades geográficas puras (sin dependencias de Nest). */

const R = 6371000; // radio terrestre en metros
const toRad = (d: number) => (d * Math.PI) / 180;

/** Distancia haversine en metros entre dos coordenadas. */
export function haversine(
  lat1: number,
  lon1: number,
  lat2: number,
  lon2: number,
): number {
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

/**
 * Cuerda (línea recta por dentro de la esfera) en metros entre dos
 * coordenadas: 2R·sen(θ/2) ≤ R·θ (la haversine), así que es una cota inferior
 * del largo, la que usa A* (F3). Se calcula con el mismo término `a` que la
 * haversine (2R·√a), que es estable en segmentos de centímetros; la diferencia
 * de vectores unitarios pierde precisión por cancelación a esa escala.
 */
export function chord(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.sqrt(Math.min(1, a));
}

/** Vector unitario (x, y, z) de una coordenada sobre la esfera. */
export function unitVector(lat: number, lon: number): [number, number, number] {
  const φ = toRad(lat);
  const λ = toRad(lon);
  return [Math.cos(φ) * Math.cos(λ), Math.cos(φ) * Math.sin(λ), Math.sin(φ)];
}

export const EARTH_RADIUS_M = R;

/** Rumbo inicial (grados, 0-360) del trayecto de (lat1,lon1) a (lat2,lon2). */
export function bearing(
  lat1: number,
  lon1: number,
  lat2: number,
  lon2: number,
): number {
  const φ1 = toRad(lat1);
  const φ2 = toRad(lat2);
  const Δλ = toRad(lon2 - lon1);
  const y = Math.sin(Δλ) * Math.cos(φ2);
  const x =
    Math.cos(φ1) * Math.sin(φ2) -
    Math.sin(φ1) * Math.cos(φ2) * Math.cos(Δλ);
  return ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360;
}

/** Diferencia angular mínima (0-180°) entre dos rumbos. */
export function angleDiff(b1: number, b2: number): number {
  const d = Math.abs(b1 - b2) % 360;
  return d > 180 ? 360 - d : d;
}
