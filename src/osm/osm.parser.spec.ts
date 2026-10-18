import { OsmParser } from './osm.parser';
import { OverpassResponse } from './osm.types';

/**
 * Respuesta mínima de Overpass: un way que cruza el borde del bbox (sus nodos
 * fuera del bbox también vienen, porque la query usa `>;`), un ramal, una
 * rotonda cerrada y un way con un nodo faltante.
 */
const response: OverpassResponse = {
  elements: [
    { type: 'way', id: 10, nodes: [1, 2, 3], tags: { highway: 'secondary', name: 'Camino X', surface: 'asphalt', lanes: '2' } },
    { type: 'way', id: 11, nodes: [3, 4], tags: { highway: 'motorway_link', oneway: 'yes' } },
    { type: 'way', id: 12, nodes: [5, 6, 7, 5], tags: { highway: 'primary', junction: 'roundabout' } },
    { type: 'way', id: 13, nodes: [8, 99], tags: { highway: 'residential' } },
    { type: 'node', id: 1, lat: -33.0, lon: -70.0 },
    { type: 'node', id: 2, lat: -33.1, lon: -70.0 },
    { type: 'node', id: 3, lat: -33.2, lon: -70.0 },
    { type: 'node', id: 4, lat: -33.3, lon: -70.0 },
    { type: 'node', id: 5, lat: -33.0, lon: -70.1 },
    { type: 'node', id: 6, lat: -33.0, lon: -70.2 },
    { type: 'node', id: 7, lat: -33.1, lon: -70.2 },
    { type: 'node', id: 8, lat: -33.5, lon: -70.5 },
    { type: 'node', id: 50, lat: 0, lon: 0 }, // no referenciado por ningún way
  ],
};

describe('OsmParser', () => {
  const parsed = new OsmParser().parse(response);
  const byId = new Map(parsed.ways.map((w) => [w.osmWayId, w]));

  it('conserva el way completo (todos sus nodos, en orden)', () => {
    expect(byId.get('10')!.nodeIds).toEqual(['1', '2', '3']);
    expect(byId.get('12')!.nodeIds).toEqual(['5', '6', '7', '5']);
  });

  it('guarda solo los tags de STORED_TAGS, sin normalizar', () => {
    expect(byId.get('10')!.tags).toEqual({ highway: 'secondary', name: 'Camino X', surface: 'asphalt' });
    expect(byId.get('11')!.tags).toEqual({ highway: 'motorway_link', oneway: 'yes' });
    expect(byId.get('12')!.tags.junction).toBe('roundabout');
  });

  it('descarta ways con menos de 2 nodos presentes', () => {
    expect(byId.has('13')).toBe(false);
  });

  it('solo devuelve nodos referenciados por algún way', () => {
    expect(parsed.nodes.map((n) => n.osmId).sort()).toEqual(['1', '2', '3', '4', '5', '6', '7']);
  });
});
