import { angleDiff, bearing, haversine } from './geo';

/**
 * Sinuosidad LOCAL por segmento, basada en el giro real del camino (métrica
 * vigente hasta F0.4, idéntica a la que calculaba el parser al importar).
 *
 * Para cada segmento medimos cuántos grados gira la traza por kilómetro
 * (densidad de giro). Mapeo a [0,1]: ~10°/km → 0 (recto), ~130°/km → 1.
 * Conocido: es sensible a segmentos cortos (ver plan, §1.1).
 */
export function computeSegmentCurviness(
  coords: { lat: number; lon: number }[],
): number[] {
  const n = coords.length;
  const result = new Array(Math.max(0, n - 1)).fill(0);
  if (n < 3) return result; // un solo segmento: sin giro medible

  const bearings: number[] = [];
  for (let i = 0; i < n - 1; i++) {
    bearings.push(
      bearing(coords[i].lat, coords[i].lon, coords[i + 1].lat, coords[i + 1].lon),
    );
  }

  for (let i = 0; i < n - 1; i++) {
    // Giro en el vértice de fin del segmento (entre este segmento y el
    // siguiente); el último segmento toma el giro de su vértice de inicio.
    const turnDeg =
      i < n - 2
        ? angleDiff(bearings[i], bearings[i + 1])
        : angleDiff(bearings[i - 1], bearings[i]);
    const segLenKm =
      haversine(coords[i].lat, coords[i].lon, coords[i + 1].lat, coords[i + 1].lon) / 1000;
    const degPerKm = segLenKm > 0 ? turnDeg / segLenKm : 0;
    result[i] = Math.min(1, Math.max(0, (degPerKm - 10) / 120));
  }
  return result;
}
