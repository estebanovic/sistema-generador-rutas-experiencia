import { HighwayType, SmoothnessType } from '../dijkstra/types';

/**
 * Normalización de tags crudos de OSM a atributos de ruteo, y reglas de
 * exclusión (decisión D7 del plan).
 */

/** Valores de `highway` que se piden a Overpass (regex en UNA línea). */
export const OVERPASS_HIGHWAYS = [
  'motorway', 'trunk', 'primary', 'secondary', 'tertiary', 'unclassified',
  'residential', 'track', 'service', 'living_street',
  'motorway_link', 'trunk_link', 'primary_link', 'secondary_link', 'tertiary_link',
];

const HIGHWAY_MAP: Record<string, HighwayType> = {
  motorway: 'motorway',
  trunk: 'trunk',
  primary: 'primary',
  secondary: 'secondary',
  tertiary: 'tertiary',
  unclassified: 'unclassified',
  residential: 'residential',
  track: 'track',
  service: 'service',
  living_street: 'living_street',
  // Los ramales toman el tipo (y la penalización) de su vía base.
  motorway_link: 'motorway',
  trunk_link: 'trunk',
  primary_link: 'primary',
  secondary_link: 'secondary',
  tertiary_link: 'tertiary',
};

export type ExclusionRule =
  | 'highway-no-ruteable'
  | 'construccion'
  | 'service-subtipo'
  | 'acceso-restringido'
  | 'no-motorizado';

export const ALL_EXCLUSION_RULES: readonly ExclusionRule[] = [
  'highway-no-ruteable',
  'construccion',
  'service-subtipo',
  'acceso-restringido',
  'no-motorizado',
];

const EXCLUDED_SERVICE = new Set(['parking_aisle', 'driveway', 'drive-through', 'drive_through']);
const RESTRICTED_ACCESS = new Set(['private', 'no', 'agricultural', 'forestry']);

/**
 * Clasifica un valor de acceso (lista `a;b` posible):
 * - 'abierto': algún valor no restringido;
 * - 'privado': todos restringidos y al menos uno es `private` (el dueño/residente
 *   sí puede pasar → se incluye como solo-origen/destino);
 * - 'cerrado': todos restringidos y ninguno `private` (no, agricultural, forestry).
 */
function accessValueClass(value: string | undefined): 'abierto' | 'privado' | 'cerrado' {
  if (!value) return 'abierto';
  const parts = value.split(';').map((s) => s.trim().toLowerCase()).filter(Boolean);
  if (parts.length === 0 || !parts.every((p) => RESTRICTED_ACCESS.has(p))) return 'abierto';
  return parts.includes('private') ? 'privado' : 'cerrado';
}

/**
 * Acceso para autos, resuelto del tag más específico al más general
 * (motorcar → motor_vehicle → vehicle → access), como define OSM: por ejemplo,
 * `access=no` + `motor_vehicle=yes` queda permitido.
 */
function resolvedAccess(tags: Record<string, string>): { clase: 'abierto' | 'privado' | 'cerrado'; especifico: boolean } {
  const specific = tags.motorcar ?? tags.motor_vehicle;
  if (specific !== undefined) return { clase: accessValueClass(specific), especifico: true };
  return { clase: accessValueClass(tags.vehicle ?? tags.access), especifico: false };
}

/**
 * Regla de D7 que excluye el way del grafo ruteable, o null si se incluye.
 * `access=private` NO excluye: se incluye como solo-origen/destino (ver
 * `isDestinationOnly`); se excluyen `no`, `agricultural` y `forestry`.
 */
export function exclusionReason(tags: Record<string, string>): ExclusionRule | null {
  const highway = tags.highway;
  if (highway === 'construction') return 'construccion';
  if (!highway || !(highway in HIGHWAY_MAP)) return 'highway-no-ruteable';
  if (highway === 'service' && tags.service && EXCLUDED_SERVICE.has(tags.service)) {
    return 'service-subtipo';
  }
  const acc = resolvedAccess(tags);
  if (acc.clase === 'cerrado') return acc.especifico ? 'no-motorizado' : 'acceso-restringido';
  return null;
}

/**
 * Vía privada (decisión D7): se puede usar solo al comienzo o al final de una
 * ruta —para salir de / llegar a un condominio o fundo—, nunca como paso. El
 * motor aplica la restricción por consulta (ver `dijkstra.ts`).
 */
export function isDestinationOnly(tags: Record<string, string>): boolean {
  return resolvedAccess(tags).clase === 'privado';
}

export function parseHighway(value?: string): HighwayType {
  return (value && HIGHWAY_MAP[value]) || 'residential';
}

const SMOOTHNESS_VALUES: ReadonlySet<string> = new Set([
  'excellent', 'good', 'intermediate', 'bad', 'very_bad', 'impassable',
]);

export function parseSmoothness(value?: string): SmoothnessType {
  return value && SMOOTHNESS_VALUES.has(value) ? (value as SmoothnessType) : 'intermediate';
}

/**
 * Sentido de circulación. Cambio respecto del parser anterior a F0: las
 * rotondas (`junction=roundabout|circular`) son de un sentido salvo que se
 * indique lo contrario, como define OSM; antes se trataban de doble sentido.
 */
export function parseOneway(tags: Record<string, string>): 'forward' | 'backward' | 'no' {
  const v = (tags.oneway ?? '').toLowerCase();
  if (v === 'yes' || v === 'true' || v === '1') return 'forward';
  if (v === '-1' || v === 'reverse') return 'backward';
  if (v === 'no' || v === 'false' || v === '0') return 'no';
  if (tags.junction === 'roundabout' || tags.junction === 'circular') return 'forward';
  // Las autopistas suelen ser de un sentido aunque no esté etiquetado.
  if (tags.highway === 'motorway') return 'forward';
  return 'no';
}
