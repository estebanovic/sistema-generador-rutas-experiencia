import { synthetic, toGraph } from '../../test/fixtures/graph-fixtures';
import { haversine } from '../graph-compiler/geo';
import { geoOsmIdString } from './compiled-graph';
import { dijkstra } from './dijkstra';
import { assertSinRepeticion } from './no-repeat';
import { chainInMainScc, spatialIndex } from './snap';
import { PROFILES } from '../routes/profiles';

describe('snap con nodos fantasma (índice espacial en memoria)', () => {
  // Calle recta este-oeste A—B—C a lo largo del ecuador local (lat −33,4) y una
  // paralela D—E 150 m al norte. Una isla F—G de un sentido, lejos.
  const lat0 = -33.4;
  const dLat150 = 150 / 111_320;
  const g = toGraph(
    synthetic(
      {
        A: [lat0, -70.6], B: [lat0, -70.59], C: [lat0, -70.58],
        D: [lat0 + dLat150, -70.6], E: [lat0 + dLat150, -70.58],
        X: [lat0 + dLat150 / 2, -70.6], // une las dos calles por el oeste (A–X–D)
        // Ramales para que B y D sean uniones (si no, todo sería un solo tramo-lazo).
        B2: [lat0 - dLat150, -70.59], D2: [lat0 + 2 * dLat150, -70.6],
        F: [lat0 + 0.02, -70.6], G: [lat0 + 0.02, -70.599],
      },
      [
        { from: 'A', to: 'B', length: haversine(lat0, -70.6, lat0, -70.59) },
        { from: 'B', to: 'C', length: haversine(lat0, -70.59, lat0, -70.58) },
        { from: 'D', to: 'E', length: haversine(lat0 + dLat150, -70.6, lat0 + dLat150, -70.58) },
        { from: 'A', to: 'X', length: 75 },
        { from: 'X', to: 'D', length: 75 },
        { from: 'B', to: 'B2', length: 150 },
        { from: 'D', to: 'D2', length: 150 },
        { from: 'F', to: 'G', length: 90, oneway: true },
      ],
    ),
  );
  const idx = spatialIndex(g);

  it('proyecta sobre el tramo más cercano; la distancia es la perpendicular', () => {
    // 30 m al norte del punto medio entre A y B.
    const [c] = idx.nearest(lat0 + 30 / 111_320, -70.595, 1, 5000);
    expect(c.dist).toBeCloseTo(30, 0);
    expect(['A', 'B']).toContain(geoOsmIdString(g, c.point));
    expect(c.t).toBeGreaterThan(0.4);
    expect(c.t).toBeLessThan(0.6);
  });

  it('devuelve k tramos distintos ordenados por distancia (ambas calzadas)', () => {
    const cs = idx.nearest(lat0 + 50 / 111_320, -70.595, 2, 5000);
    expect(cs).toHaveLength(2);
    expect(cs[0].chain).not.toBe(cs[1].chain);
    expect(cs[0].dist).toBeCloseTo(50, 0);
    expect(cs[1].dist).toBeCloseTo(100, 0);
  });

  it('respeta el filtro de la componente fuertemente conexa mayor', () => {
    const cerca = (lat: number, lon: number) => idx.nearest(lat, lon, 1, 5000, (ch) => chainInMainScc(g, ch));
    // Junto a la isla F→G el más cercano es la isla, pero se descarta.
    const [c] = cerca(lat0 + 0.02, -70.5995);
    expect(chainInMainScc(g, c.chain)).toBe(true);
    expect(c.dist).toBeGreaterThan(1000);
  });

  it('sin vías dentro del radio no devuelve nada', () => {
    expect(idx.nearest(lat0 + 1, -70.6, 1, 5000)).toEqual([]);
  });

  it('rutear desde una proyección a mitad de tramo cuesta exactamente el pedazo', () => {
    const [o] = idx.nearest(lat0 + 10 / 111_320, -70.595, 1, 5000);
    const [d] = idx.nearest(lat0 - 10 / 111_320, -70.585, 1, 5000);
    const r = dijkstra(g, o, d, PROFILES['moto-curvas'])!;
    const esperado = haversine(lat0, -70.595, lat0, -70.585);
    expect(Math.abs(r.stats.distanceMeters - esperado)).toBeLessThan(1);
    expect(r.path).toEqual(['B']); // pasa por el único nodo crudo entre ambas proyecciones
    assertSinRepeticion(r);
  });
});
