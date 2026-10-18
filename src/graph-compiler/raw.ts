/**
 * Modelo canónico de datos crudos (contrato entre el import y el compilador).
 * Cualquier fuente (Overpass por vista, extracto PBF masivo) produce esto; el
 * compilador no sabe de dónde viene.
 */

export interface RawNode {
  osmId: string;
  lat: number;
  lon: number;
}

export interface RawWay {
  osmWayId: string;
  /** Nodos en el orden del way de OSM (puede repetir el primero si es cerrado). */
  nodeIds: string[];
  /** Subconjunto de tags de OSM, sin normalizar (ver STORED_TAGS). */
  tags: Record<string, string>;
}

/**
 * Tags que se guardan crudos. La normalización (tipo de vía, superficie,
 * sentido, exclusiones) se hace al compilar, así se puede cambiar sin
 * reimportar. `smoothness` se sigue guardando aunque el modelo de ruteo no lo
 * usa desde F0.6 (casi no está etiquetado): quitarlo haría que el próximo
 * import viera como modificados todos los ways que lo tienen.
 */
export const STORED_TAGS = [
  'highway',
  'surface',
  'tracktype',
  'smoothness',
  'service',
  'access',
  'vehicle',
  'motor_vehicle',
  'motorcar',
  'oneway',
  'junction',
  'name',
  'ref',
] as const;
