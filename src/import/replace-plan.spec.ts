import { RawWay } from '../graph-compiler/raw';
import { BoundingBox } from '../osm/osm.types';
import { inBbox, planReplacement } from './replace-plan';

const bbox: BoundingBox = { south: 0, west: 0, north: 1, east: 1 };
const way = (osmWayId: string, nodeIds: string[], tags: Record<string, string> = { highway: 'residential' }): RawWay => ({ osmWayId, nodeIds, tags });

/**
 * Almacén en memoria que aplica el plan igual que OsmStoreService
 * (reemplazo por way + borrados), para probar idempotencia sin Mongo.
 */
class MemoryStore {
  ways = new Map<string, RawWay>();
  coords = new Map<string, { lat: number; lon: number }>();

  apply(b: BoundingBox, incoming: RawWay[], incomingCoords: Record<string, [number, number]>) {
    for (const [id, [lat, lon]] of Object.entries(incomingCoords)) this.coords.set(id, { lat, lon });
    const existing = [...this.ways.values()].map((w) => ({
      osmWayId: w.osmWayId,
      hasNodeInBbox: w.nodeIds.some((id) => {
        const c = this.coords.get(id);
        return !!c && inBbox(c.lat, c.lon, b);
      }),
    }));
    const plan = planReplacement(incoming, existing);
    for (const w of plan.upserts) this.ways.set(w.osmWayId, w);
    for (const id of plan.deletes) this.ways.delete(id);
    return plan;
  }

  hash(): string {
    return JSON.stringify([...this.ways.values()].sort((a, b) => a.osmWayId.localeCompare(b.osmWayId)));
  }
}

describe('planReplacement', () => {
  it('borra un way con nodo dentro del bbox que Overpass ya no devuelve', () => {
    const plan = planReplacement([way('1', ['a', 'b'])], [
      { osmWayId: '1', hasNodeInBbox: true },
      { osmWayId: '2', hasNodeInBbox: true },
    ]);
    expect(plan.deletes).toEqual(['2']);
  });

  it('no borra un way ausente sin nodos dentro del bbox (solo cruza su rectángulo)', () => {
    const plan = planReplacement([], [{ osmWayId: '3', hasNodeInBbox: false }]);
    expect(plan.deletes).toEqual([]);
  });

  it('deduplica por ID de OSM (ways repetidos entre teselas)', () => {
    const plan = planReplacement([way('1', ['a', 'b']), way('1', ['a', 'b'])], []);
    expect(plan.upserts).toHaveLength(1);
  });
});

describe('reemplazo por way — idempotencia y bordes de tesela', () => {
  const coords: Record<string, [number, number]> = {
    a: [0.5, 0.5], b: [0.5, 0.9], c: [0.5, 1.5], // c fuera del bbox: way 1 cruza el borde
    d: [0.2, 0.2], e: [0.3, 0.3],
  };

  it('importar dos veces el mismo bbox deja el almacén idéntico', () => {
    const s = new MemoryStore();
    const ways = [way('1', ['a', 'b', 'c']), way('2', ['d', 'e'])];
    s.apply(bbox, ways, coords);
    const h1 = s.hash();
    s.apply(bbox, ways, coords);
    expect(s.hash()).toBe(h1);
  });

  it('un way que cruza el borde queda completo y la tesela vecina no lo corta ni lo borra', () => {
    const s = new MemoryStore();
    s.apply(bbox, [way('1', ['a', 'b', 'c'])], coords);
    // Tesela vecina (al este): Overpass devuelve el mismo way completo.
    const vecina: BoundingBox = { south: 0, west: 1, north: 1, east: 2 };
    s.apply(vecina, [way('1', ['a', 'b', 'c'])], coords);
    expect(s.ways.get('1')!.nodeIds).toEqual(['a', 'b', 'c']);
  });

  it('un way borrado en OSM desaparece al reimportar su zona', () => {
    const s = new MemoryStore();
    s.apply(bbox, [way('1', ['a', 'b', 'c']), way('2', ['d', 'e'])], coords);
    s.apply(bbox, [way('1', ['a', 'b', 'c'])], coords);
    expect([...s.ways.keys()]).toEqual(['1']);
  });

  it('un way re-nodeado en OSM se reemplaza entero (sin restos del trazado anterior)', () => {
    const s = new MemoryStore();
    s.apply(bbox, [way('2', ['d', 'e'])], coords);
    s.apply(bbox, [way('2', ['d', 'x', 'e'])], { ...coords, x: [0.25, 0.26] });
    expect(s.ways.get('2')!.nodeIds).toEqual(['d', 'x', 'e']);
  });
});
