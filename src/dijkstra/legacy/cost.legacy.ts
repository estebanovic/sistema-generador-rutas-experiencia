// COPIA CONGELADA de la función de costo anterior a F0 (oráculo de tests). NO
// modificar ni importar desde código de producción.

import { GraphEdge, HighwayType, SmoothnessType, SurfaceType } from './types.legacy';

export interface RouteWeights {
  distanceWeight: number; // 0-1, importancia de distancia corta
  curvinessWeight: number; // 0-1, preferencia por curvas
  elevationWeight: number; // -1..1: >0 prefiere plano, <0 prefiere montañoso
  surfaceWeight: number; // -1..1: >0 prefiere pavimento, <0 prefiere rural
}

const SURFACE_PENALTY: Record<SurfaceType, number> = {
  asphalt: 1.0,
  concrete: 1.1,
  cobblestone: 1.4,
  gravel: 1.8,
  dirt: 2.2,
  sand: 3.0,
  unknown: 1.5,
};

const HIGHWAY_PENALTY: Record<HighwayType, number> = {
  motorway: 0.8,
  trunk: 0.9,
  primary: 1.0,
  secondary: 1.1,
  tertiary: 1.2,
  unclassified: 1.4,
  residential: 1.5,
  track: 2.0,
  path: 3.0,
  service: 1.6,
};

const SMOOTHNESS_PENALTY: Record<SmoothnessType, number> = {
  excellent: 1.0,
  good: 1.1,
  intermediate: 1.3,
  bad: 1.7,
  very_bad: 2.4,
  impassable: 6.0,
};

const DEFAULT_SURFACE_PENALTY = 1.5;
const DEFAULT_HIGHWAY_PENALTY = 1.4;
const DEFAULT_SMOOTHNESS_PENALTY = 1.3;

const clamp01 = (x: number) => Math.min(1, Math.max(0, x));

/**
 * Modelo de costo por "experiencia de manejo".
 *
 * costo = distancia × factor
 *
 * El `factor` es un costo por metro: cuanto más bajo, más atractiva es la
 * arista. Cada preferencia se expresa como una "incomodidad" normalizada en
 * [0,1] (1 = lo peor para esa preferencia) multiplicada por su peso y por un
 * coeficiente lo bastante grande como para que una preferencia fuerte DOMINE
 * sobre la distancia. Así un camino curvo más largo puede ganarle a uno recto
 * más corto (antes era imposible: el premio por curvas era demasiado débil).
 */
export function calculateEdgeCost(
  edge: GraphEdge,
  weights: RouteWeights,
): number {
  const surfacePenalty = SURFACE_PENALTY[edge.surface] ?? DEFAULT_SURFACE_PENALTY;
  const highwayPenalty =
    HIGHWAY_PENALTY[edge.highwayType] ?? DEFAULT_HIGHWAY_PENALTY;
  const smoothnessPenalty =
    SMOOTHNESS_PENALTY[edge.smoothness] ?? DEFAULT_SMOOTHNESS_PENALTY;

  // Incomodidades normalizadas (0 = ideal, 1 = pésimo) ---------------------
  // Recto: malo para quien busca curvas.
  const straightness = 1 - clamp01(edge.curviness);
  // Rugosidad: combina superficie y smoothness. asphalt/good ≈ 0, sand/bad ≈ 1.
  const roughness = clamp01((surfacePenalty * smoothnessPenalty - 1) / 3);
  // Pendiente: desnivel por metro. ~15% de gradiente ya satura a 1.
  const grade =
    edge.distanceMeters > 0
      ? clamp01(
          (edge.elevationGain + edge.elevationLoss) /
            edge.distanceMeters /
            0.15,
        )
      : 0;
  // Jerarquía de vía: motorway ≈ 0 (rápida/aburrida), path ≈ 1 (chica/lenta).
  const minorRoad = clamp01((highwayPenalty - 0.8) / (3.0 - 0.8));

  // surfaceWeight FIRMADO:
  //   > 0  → preferir pavimento: penaliza lo rugoso.
  //   < 0  → preferir rural: penaliza lo liso/pavimentado (el ripio/tierra sale
  //          más barato y el router lo elige donde exista en los datos).
  // En ambos casos el término es ≥ 0 (Dijkstra exige costos positivos): nunca
  // "premiamos" con costo negativo, solo encarecemos el extremo no deseado.
  const sw = weights.surfaceWeight;
  const surfaceTerm =
    sw >= 0 ? sw * 2.0 * roughness : -sw * 2.0 * (1 - roughness);

  // elevationWeight FIRMADO (misma idea que surfaceWeight):
  //   > 0  → preferir plano: penaliza la pendiente.
  //   < 0  → preferir montañoso: penaliza lo llano (las subidas/bajadas salen
  //          más baratas y el router busca rutas con cambios de altura).
  const ew = weights.elevationWeight;
  const elevationTerm =
    ew >= 0 ? ew * 2.0 * grade : -ew * 2.0 * (1 - grade);

  // Factor por metro: piso bajo + términos ponderados y amplificados --------
  const factor =
    0.15 + // piso: garantiza costo > 0 y algo de presión por distancia
    weights.distanceWeight * 0.6 + // querer ruta corta sube el piso uniforme
    weights.curvinessWeight * 2.6 * straightness + // evitar tramos rectos
    surfaceTerm + // preferir pavimento (>0) o rural (<0)
    elevationTerm + // preferir plano (>0) o montañoso (<0)
    0.3 * minorRoad; // leve preferencia estructural por vías principales

  return edge.distanceMeters * Math.max(factor, 0.05);
}
