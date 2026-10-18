import { RawWay } from '../graph-compiler/raw';
import { BoundingBox } from '../osm/osm.types';

/** Way ya guardado cuyo rectángulo envolvente se cruza con el bbox importado. */
export interface ExistingWayRef {
  osmWayId: string;
  /** true si al menos uno de sus nodos cae dentro del bbox importado. */
  hasNodeInBbox: boolean;
}

export interface ReplacePlan {
  /** Ways a escribir completos (reemplazo por way, deduplicados por ID). */
  upserts: RawWay[];
  /** Ways a borrar: tienen un nodo dentro del bbox y Overpass ya no los devuelve. */
  deletes: string[];
}

/**
 * Plan de reemplazo por way de un import.
 *
 * Overpass devuelve todo way vial con al menos un nodo dentro del bbox. Si un
 * way guardado tiene un nodo adentro y no vino en la respuesta, en OSM fue
 * borrado o dejó de ser vial: se elimina. Los ways guardados que solo se cruzan
 * con el bbox por su rectángulo envolvente (sin nodos adentro) no se tocan.
 * La respuesta debe ser completa (el servicio OSM rechaza las cortadas).
 */
export function planReplacement(incoming: RawWay[], existing: ExistingWayRef[]): ReplacePlan {
  const byId = new Map<string, RawWay>();
  for (const w of incoming) byId.set(w.osmWayId, w);
  const deletes = existing
    .filter((e) => e.hasNodeInBbox && !byId.has(e.osmWayId))
    .map((e) => e.osmWayId);
  return { upserts: [...byId.values()], deletes };
}

export function inBbox(lat: number, lon: number, b: BoundingBox): boolean {
  return lat >= b.south && lat <= b.north && lon >= b.west && lon <= b.east;
}

/** Rectángulo envolvente de un way, para encontrar candidatos a borrar sin cargar todo. */
export function wayBbox(
  nodeIds: string[],
  coordsOf: (id: string) => { lat: number; lon: number } | undefined,
): { minLat: number; minLon: number; maxLat: number; maxLon: number } {
  let minLat = Infinity, minLon = Infinity, maxLat = -Infinity, maxLon = -Infinity;
  for (const id of nodeIds) {
    const c = coordsOf(id);
    if (!c) continue;
    if (c.lat < minLat) minLat = c.lat;
    if (c.lat > maxLat) maxLat = c.lat;
    if (c.lon < minLon) minLon = c.lon;
    if (c.lon > maxLon) maxLon = c.lon;
  }
  return { minLat, minLon, maxLat, maxLon };
}
