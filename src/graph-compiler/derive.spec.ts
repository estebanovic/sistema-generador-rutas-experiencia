import { deriveGraph } from './derive';
import { haversine } from './geo';
import { RawWay } from './raw';

const coords: Record<string, { lat: number; lon: number }> = {
  a: { lat: -33.4, lon: -70.6 },
  b: { lat: -33.4, lon: -70.599 },
  c: { lat: -33.399, lon: -70.599 },
  d: { lat: -33.398, lon: -70.599 },
};
const coordsOf = (id: string) => coords[id];
const way = (osmWayId: string, nodeIds: string[], tags: Record<string, string>): RawWay => ({ osmWayId, nodeIds, tags });

describe('deriveGraph', () => {
  it('el largo de cada arista es la haversine de las coordenadas actuales (L == haversine)', () => {
    const g = deriveGraph([way('1', ['a', 'b', 'c'], { highway: 'residential' })], coordsOf);
    for (const e of g.edges) {
      const p = coords[e.fromOsmId];
      const q = coords[e.toOsmId];
      expect(e.distanceMeters).toBe(haversine(p.lat, p.lon, q.lat, q.lon));
    }
  });

  it('doble sentido genera ida y vuelta; oneway y rotonda solo ida', () => {
    const doble = deriveGraph([way('1', ['a', 'b'], { highway: 'residential' })], coordsOf);
    expect(doble.edges.map((e) => `${e.fromOsmId}${e.toOsmId}`).sort()).toEqual(['ab', 'ba']);
    const uno = deriveGraph([way('1', ['a', 'b'], { highway: 'residential', oneway: 'yes' })], coordsOf);
    expect(uno.edges.map((e) => `${e.fromOsmId}${e.toOsmId}`)).toEqual(['ab']);
    const rotonda = deriveGraph([way('1', ['a', 'b', 'c', 'a'], { highway: 'primary', junction: 'roundabout' })], coordsOf);
    expect(rotonda.edges).toHaveLength(3);
  });

  it('excluye por regla, cuenta km por regla y respeta reglas desactivadas', () => {
    const ways = [
      way('1', ['a', 'b'], { highway: 'residential' }),
      way('2', ['b', 'c'], { highway: 'service', service: 'parking_aisle' }),
      way('3', ['c', 'd'], { highway: 'track', access: 'agricultural' }),
    ];
    const todas = deriveGraph(ways, coordsOf);
    expect(new Set(todas.edges.map((e) => e.osmWayId))).toEqual(new Set(['1']));
    expect(todas.stats.excluded['service-subtipo']?.ways).toBe(1);
    expect(todas.stats.excluded['acceso-restringido']?.km).toBeCloseTo(haversine(-33.399, -70.599, -33.398, -70.599) / 1000, 9);

    const sinAcceso = deriveGraph(ways, coordsOf, { rules: new Set(['service-subtipo']) });
    expect(new Set(sinAcceso.edges.map((e) => e.osmWayId))).toEqual(new Set(['1', '3']));
  });

  it('ramales y calles compartidas entran con su tipo normalizado', () => {
    const g = deriveGraph(
      [way('1', ['a', 'b'], { highway: 'motorway_link', oneway: 'yes' }), way('2', ['b', 'c'], { highway: 'living_street' })],
      coordsOf,
    );
    expect(g.edges.find((e) => e.osmWayId === '1')!.highwayType).toBe('motorway');
    expect(g.edges.find((e) => e.osmWayId === '2')!.highwayType).toBe('living_street');
  });

  it('salta nodos ausentes del almacén y los informa', () => {
    const g = deriveGraph([way('1', ['a', 'x', 'b'], { highway: 'residential' })], coordsOf);
    expect(g.stats.missingNodeRefs).toBe(1);
    expect(g.edges.map((e) => `${e.fromOsmId}${e.toOsmId}`).sort()).toEqual(['ab', 'ba']);
  });

  it('las vías privadas entran marcadas como solo-origen/destino', () => {
    const g = deriveGraph(
      [way('1', ['a', 'b'], { highway: 'residential' }), way('2', ['b', 'c'], { highway: 'residential', access: 'private' })],
      coordsOf,
    );
    expect(g.edges.filter((e) => e.osmWayId === '2').every((e) => e.destinationOnly)).toBe(true);
    expect(g.edges.filter((e) => e.osmWayId === '1').every((e) => !e.destinationOnly)).toBe(true);
    expect(g.stats.destinationOnly.ways).toBe(1);
  });
});
