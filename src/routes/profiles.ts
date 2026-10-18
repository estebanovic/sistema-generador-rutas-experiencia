import { RouteWeights } from '../dijkstra/cost';

export const PROFILE_NAMES = ['4x4', 'moto-curvas', 'scenic', 'custom'] as const;
export type ProfileName = (typeof PROFILE_NAMES)[number];

/**
 * Perfiles de manejo. Recordá que mayor peso = mayor costo = más evitado.
 * - moto-curvas: prioriza curvas (curvinessWeight alto) e ignora distancia.
 * - 4x4: tolera mal terreno (surfaceWeight bajo) y busca desnivel.
 * - scenic: equilibrado, premia curvas y desnivel sin castigar la superficie.
 */
export const PROFILES: Record<Exclude<ProfileName, 'custom'>, RouteWeights> = {
  // Busca curvas a toda costa, no le importa la distancia ni el asfalto.
  'moto-curvas': {
    distanceWeight: 0.05,
    curvinessWeight: 1.0,
    elevationWeight: 0.0,
    surfaceWeight: 0.0, // indiferente a la superficie
  },
  // Prioriza llegar directo y PREFIERE caminos rurales (surfaceWeight < 0).
  '4x4': {
    distanceWeight: 0.6,
    curvinessWeight: 0.15,
    elevationWeight: 0.0,
    surfaceWeight: -0.7,
  },
  // Equilibrado y "lindo": algo de curvas, evita terreno feo y pendientes
  // fuertes, sin obsesionarse con la distancia.
  scenic: {
    distanceWeight: 0.25,
    curvinessWeight: 0.6,
    elevationWeight: 0.4,
    surfaceWeight: 0.5,
  },
};
