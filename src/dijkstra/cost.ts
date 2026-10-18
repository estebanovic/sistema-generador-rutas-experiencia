import { GraphEdge, HighwayType, SurfaceType } from './types';

/**
 * Función de costo (F2): costo = L · (1 + Σ wᵢ · pᵢ), más una penalización
 * estructural fija para las vías menores (D7).
 *
 * - L es el largo: con todos los pesos en 0 el costo es la distancia y la ruta
 *   es la más corta (ya no hay `distanceWeight`: la distancia es la base).
 * - Cada pᵢ es una "incomodidad" normalizada en [0,1] del segmento (1 = lo que
 *   el perfil quiere evitar) y wᵢ ∈ [0, W_MAX] su peso. Con wᵢ = W_MAX, un
 *   metro que el perfil evita cuesta hasta 1 + W_MAX metros: una ruta más larga
 *   gana si ahorra al menos 1 m evitado por cada W_MAX m extra.
 * - Todos los términos son ≥ 0, así que costo ≥ L (lo exige A*, F3) y Dijkstra
 *   recibe costos positivos.
 * - Elevación y smoothness salieron del costo (no hay datos de elevación y
 *   smoothness casi no está etiquetado; plan, §1.4).
 */

/** Peso máximo de cada criterio (D4). */
export const W_MAX = 4;

export interface RouteWeights {
  /** 0..W_MAX: cuánto se evitan los tramos rectos (preferencia por curvas). */
  curvinessWeight: number;
  /**
   * -W_MAX..W_MAX, firmado: > 0 evita lo sin pavimentar (prefiere pavimento);
   * < 0 evita lo pavimentado (prefiere ripio y tierra). Nunca resta: solo
   * encarece el extremo no deseado.
   */
  surfaceWeight: number;
}

/**
 * Densidad de giro (°/km) desde la que un segmento cuenta como curvo del todo
 * para el costo: rectitud = 1 − min(1, densidad / este valor). Coincide con el
 * umbral de tramo curvo (D1). Al ajustar los perfiles (F2) rindió más que 150,
 * 200 o 300 °/km en moto-curvas y scenic.
 */
export const STRAIGHTNESS_SATURATION_DEG_PER_KM = 100;

/**
 * Grado de "sin pavimentar" de cada superficie: 0 = pavimento, 1 = ripio,
 * tierra o arena. El ripio cuenta entero, igual que en el criterio de 4x4
 * (D1): con 0,8, 4x4 llegaba al 70% del máximo en 12 de 19 pares de referencia
 * en vez de 18 (ajuste de F2). El adoquín queda intermedio.
 */
const UNPAVED: Record<SurfaceType, number> = {
  asphalt: 0,
  concrete: 0,
  cobblestone: 0.3,
  gravel: 1,
  dirt: 1,
  sand: 1,
  unknown: 0.5,
};
const DEFAULT_UNPAVED = 0.5;

/**
 * Vías menores con penalización fija (D7): calles compartidas y `service` sin
 * subtipo (los subtipos de estacionamiento y entrada ya se excluyen). No
 * depende del perfil.
 */
const MINOR_ROAD: Partial<Record<HighwayType, number>> = {
  living_street: 1,
  service: 1,
};
/** Recargo por metro de vía menor: cuesta 1,5 veces su largo con los pesos en 0. */
export const MINOR_ROAD_PENALTY = 0.5;

const clamp01 = (x: number) => Math.min(1, Math.max(0, x));

/** Incomodidades normalizadas de un segmento (0 = ideal, 1 = lo que se evita). Se precalculan al compilar. */
export interface EdgeFeatures {
  /** Rectitud: 1 en una recta, 0 desde la densidad de saturación. */
  straightness: number;
  /** Sin pavimentar: 0 asfalto u hormigón, 1 tierra o arena. */
  unpaved: number;
  /** 1 si es una vía menor penalizada (D7), 0 si no. */
  minorRoad: number;
}

export function edgeFeatures(
  edge: Pick<GraphEdge, 'curviness' | 'curvatureDegPerKm' | 'highwayType' | 'surface'>,
): EdgeFeatures {
  // Las colecciones legacy no traen °/km: se aproxima desde la sinuosidad normalizada (300 °/km = 1).
  const deg = edge.curvatureDegPerKm ?? edge.curviness * 300;
  return {
    straightness: 1 - clamp01(deg / STRAIGHTNESS_SATURATION_DEG_PER_KM),
    unpaved: UNPAVED[edge.surface] ?? DEFAULT_UNPAVED,
    minorRoad: MINOR_ROAD[edge.highwayType] ?? 0,
  };
}

/**
 * Costo de un tramo compactado (o de un pedazo, para los nodos fantasma) a
 * partir de su largo y de las sumas Σ largo × feature de sus segmentos. Como
 * el costo es lineal en las features, es exactamente la suma de los costos de
 * sus segmentos (salvo el redondeo de punto flotante).
 */
export function costFromSums(
  len: number,
  sumStraight: number,
  sumUnpaved: number,
  sumMinor: number,
  weights: RouteWeights,
): number {
  const sw = weights.surfaceWeight;
  const surfaceTerm = sw >= 0 ? sw * sumUnpaved : -sw * (len - sumUnpaved);
  return len + weights.curvinessWeight * sumStraight + surfaceTerm + MINOR_ROAD_PENALTY * sumMinor;
}

/** Costo de un segmento con features conocidas (mismo cálculo que el motor). */
export function costFromFeatures(distanceMeters: number, f: EdgeFeatures, weights: RouteWeights): number {
  return costFromSums(distanceMeters, distanceMeters * f.straightness, distanceMeters * f.unpaved, distanceMeters * f.minorRoad, weights);
}

/** Costo de una arista suelta. */
export function calculateEdgeCost(edge: GraphEdge, weights: RouteWeights): number {
  return costFromFeatures(edge.distanceMeters, edgeFeatures(edge), weights);
}
