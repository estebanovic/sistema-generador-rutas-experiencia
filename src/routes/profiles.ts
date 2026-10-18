import { RouteWeights } from '../dijkstra/cost';

export const PROFILE_NAMES = ['4x4', 'moto-curvas', 'scenic', 'custom'] as const;
export type ProfileName = (typeof PROFILE_NAMES)[number];

/**
 * Perfiles de manejo (F2). Mayor peso = el perfil evita más esa incomodidad
 * (ver cost.ts). Pesos ajustados para maximizar el % del máximo alcanzable de
 * cada criterio (D1, D2) en los dos conjuntos de pares de la línea base.
 * - moto-curvas: evita las rectas.
 * - 4x4: evita el pavimento (prefiere ripio y tierra).
 * - scenic: evita las rectas y lo sin pavimentar (curvas pavimentadas, D8).
 */
export const PROFILES: Record<Exclude<ProfileName, 'custom'>, RouteWeights> = {
  'moto-curvas': { curvinessWeight: 3, surfaceWeight: 0 },
  '4x4': { curvinessWeight: 0, surfaceWeight: -4 },
  scenic: { curvinessWeight: 4, surfaceWeight: 2 },
};

/**
 * Presupuesto de desvío por defecto de cada perfil (D5): largo máximo de la
 * ruta / distancia mínima. Lo usa la línea base para el máximo alcanzable y lo
 * impondrá el motor en F4. 4x4 necesita más margen para llegar a caminos sin
 * pavimentar; para curvas, más de 1,5 no aporta.
 */
export const PROFILE_DETOUR_BUDGET: Record<ProfileName, number> = {
  'moto-curvas': 1.5,
  '4x4': 2.0,
  scenic: 1.5,
  custom: 1.5,
};
