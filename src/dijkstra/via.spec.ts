import { RouteWeights } from './cost';
import { CompiledGraph, EDGE_FLAG_DESTINATION_ONLY, geoOsmIdString, nodeIndex, nodeOsmIdString } from './compiled-graph';
import { Endpoint, Position, dijkstra, dijkstraMultiSource, endpointOfRawNode } from './dijkstra';
import { assertSinRepeticion, sinRepeticionViolations } from './no-repeat';
import { TramoOverlay } from './overlay';
import { routeVia } from './via';
import { loadFixture, synthetic, toGraph } from '../../test/fixtures/graph-fixtures';

const SOLO_DISTANCIA: RouteWeights = { curvinessWeight: 0, surfaceWeight: 0 };

function ep(g: CompiledGraph, id: string): Endpoint {
  const e = endpointOfRawNode(g, id);
  if (!e) throw new Error(`nodo ${id} no está en el grafo`);
  return e;
}

/** routeVia sobre IDs de fixture (un candidato por punto); verifica siempre el RNF-SinRepetición. */
const via = (g: CompiledGraph, ids: (string | Position)[], overlay?: TramoOverlay) => {
  const r = routeVia(g, ids.map((x) => [typeof x === 'string' ? ep(g, x) : x]), SOLO_DISTANCIA, overlay);
  if (r) assertSinRepeticion(r);
  return r;
};

/** Posición a una fracción `t` del segmento a→b, esté como esté orientado en su tramo. */
function pos(g: CompiledGraph, a: string, b: string, t: number): Position {
  for (let c = 0; c < g.meta.chainCount; c++) {
    for (let p = g.chainStart[c]; p < g.chainStart[c + 1] - 1; p++) {
      const x = geoOsmIdString(g, p);
      const y = geoOsmIdString(g, p + 1);
      if (x === a && y === b) return { chain: c, point: p, t };
      if (x === b && y === a) return { chain: c, point: p, t: 1 - t };
    }
  }
  throw new Error(`segmento ${a}—${b} no encontrado`);
}

describe('routeVia: bloqueo duro de tramos entre piernas (§1.11)', () => {
  it('arista inversa: ir S→T bloquea volver T→S por el mismo tramo', () => {
    // S—T directo (1000 m) y S—U—T (1500 m): dos tramos paralelos entre S y T.
    const g = toGraph(
      synthetic({ S: [0, 0], U: [0.006, 0.0045], T: [0, 0.009] }, [
        { from: 'S', to: 'T', length: 1000 },
        { from: 'S', to: 'U', length: 750, way: 'u' },
        { from: 'U', to: 'T', length: 750, way: 'u' },
      ]),
    );
    const r = via(g, ['S', 'T', 'S'])!;
    expect(r.stats.distanceMeters).toBeCloseTo(2500, 9);
    expect(r.path).toEqual(['S', 'T', 'U', 'S']);
    assertSinRepeticion(r);
    // Sin bloqueo, la vuelta repetiría el tramo directo.
    const ida = dijkstra(g, ep(g, 'S'), ep(g, 'T'), SOLO_DISTANCIA)!;
    const vuelta = dijkstra(g, ep(g, 'T'), ep(g, 'S'), SOLO_DISTANCIA)!;
    expect(sinRepeticionViolations([...ida.tramos, ...vuelta.tramos])).toHaveLength(1);
  });

  it('calzadas paralelas: dos ways entre las mismas intersecciones son tramos distintos (D13)', () => {
    const g = toGraph(
      synthetic({ S: [0, 0], T: [0, 0.009] }, [
        { from: 'S', to: 'T', length: 1000, way: 'oriente' },
        { from: 'S', to: 'T', length: 1100, way: 'poniente' },
      ]),
    );
    const r = via(g, ['S', 'T', 'S'])!;
    expect(r.stats.distanceMeters).toBeCloseTo(2100, 9);
    expect(new Set(r.tramos.map((u) => u.chain)).size).toBe(2);
    assertSinRepeticion(r);
  });

  describe('nodos fantasma: intervalos sobre un mismo tramo', () => {
    // Calle W—E (1000 m) y vuelta W—N—E (1000 + 400 m); W y E son uniones (ramales ciegos).
    const g = toGraph(
      synthetic({ Ws: [0, -0.001], W: [0, 0], E: [0, 0.009], Es: [0, 0.01], N: [0.005, 0.0065] }, [
        { from: 'W', to: 'E', length: 1000 },
        { from: 'W', to: 'N', length: 1000, way: 'n' },
        { from: 'N', to: 'E', length: 400, way: 'n' },
        { from: 'Ws', to: 'W', length: 100 },
        { from: 'E', to: 'Es', length: 100 },
      ]),
    );

    it('sale hacia el este y vuelve por la mitad oeste: intervalos disjuntos, válido', () => {
      const r = via(g, [pos(g, 'W', 'E', 0.5), 'N', pos(g, 'W', 'E', 0.5)])!;
      // 500 hasta E + 400 hasta N; luego 1000 hasta W + 500 hasta el punto de partida.
      expect(r.stats.distanceMeters).toBeCloseTo(2400, 9);
      expect(r.path).toEqual(['E', 'N', 'W']);
      assertSinRepeticion(r);
    });

    it('si la única vuelta se superpone con un pedazo ya usado, no hay ruta', () => {
      // Ida por [250, 750] del tramo W—E; cualquier vuelta al punto 500 pisa ese intervalo.
      expect(via(g, [pos(g, 'W', 'E', 0.25), pos(g, 'W', 'E', 0.75), pos(g, 'W', 'E', 0.5)])).toBeNull();
    });
  });

  it('el overlay se reinicia por época: una consulta no ve los bloqueos de la anterior', () => {
    const g = toGraph(
      synthetic({ S: [0, 0], X: [0.001, 0.005], B: [-0.001, 0.005], T: [0, 0.01] }, [
        { from: 'S', to: 'X', length: 500 },
        { from: 'X', to: 'T', length: 500 },
        { from: 'S', to: 'B', length: 550, way: 'b' },
        { from: 'B', to: 'T', length: 550, way: 'b' },
      ]),
    );
    const overlay = new TramoOverlay(g);
    const ida = via(g, ['S', 'T'], overlay)!;
    expect(ida.path).toEqual(['S', 'X', 'T']);
    expect(via(g, ['S', 'T'], overlay)!.path).toEqual(['S', 'B', 'T']);
    overlay.reset();
    expect(via(g, ['S', 'T'], overlay)!.path).toEqual(['S', 'X', 'T']);
    // remove deshace exactamente un add (movimientos de la ILS).
    overlay.reset();
    overlay.addRoute(ida);
    overlay.removeRoute(ida);
    const libre = dijkstra(g, ep(g, 'S'), ep(g, 'T'), SOLO_DISTANCIA, { blocked: overlay })!;
    expect(libre.path).toEqual(['S', 'X', 'T']);
    assertSinRepeticion(libre);
  });

  describe('vías privadas solo en el acceso desde el origen y hacia el destino (D7, F5)', () => {
    // Calle pública S—A—B—T; condominio H—K—A (privado) y condominio D—E—B (privado).
    const g = toGraph(
      synthetic({ S: [0, 0], A: [0, 0.01], B: [0, 0.04], T: [0, 0.05], H: [0.004, 0.008], K: [0.002, 0.009], D: [0.004, 0.042], E: [0.002, 0.041] }, [
        { from: 'S', to: 'A', length: 1000 },
        { from: 'A', to: 'B', length: 3000 },
        { from: 'B', to: 'T', length: 1000 },
        { from: 'H', to: 'K', length: 200, destinationOnly: true },
        { from: 'K', to: 'A', length: 200, destinationOnly: true },
        { from: 'D', to: 'E', length: 200, destinationOnly: true },
        { from: 'E', to: 'B', length: 200, destinationOnly: true },
      ]),
    );

    it('la primera pierna sale del condominio del origen y la última entra al del destino', () => {
      const r = via(g, ['H', 'A', 'B', 'D'])!;
      expect(r.path).toEqual(['H', 'K', 'A', 'B', 'E', 'D']);
      assertSinRepeticion(r);
    });

    it('un waypoint dentro de un condominio no abre el área privada', () => {
      expect(via(g, ['S', 'K', 'T'])).toBeNull();
      expect(via(g, ['S', 'E', 'T'])).toBeNull();
    });
  });

  it('propiedad: con waypoints al azar sobre el subgrafo de Farellones, nunca repite tramos y solo falla si no hay camino', () => {
    const g = toGraph(loadFixture('farellones'));
    // Waypoints en el núcleo (nodos con al menos dos tramos que no son puente):
    // en un ramal ciego no se puede entrar y salir sin repetir.
    const nucleo: string[] = [];
    for (let n = 0; n < g.meta.nodeCount; n++) {
      const tramos = new Set<number>();
      for (let e = g.outStart[n]; e < g.outStart[n + 1]; e++) tramos.add(g.edgeChain[e]);
      for (let p = g.inStart[n]; p < g.inStart[n + 1]; p++) tramos.add(g.edgeChain[g.inEdge[p]]);
      if ([...tramos].filter((c) => !g.chainIsBridge[c]).length >= 2) nucleo.push(nodeOsmIdString(g, n));
    }
    let seed = 99;
    const azar = () => nucleo[(seed = (seed * 1103515245 + 12345) % 2147483648) % nucleo.length];
    /** ¿Se llega de s a t por aristas públicas, sin tramos usados? */
    const alcanzable = (s: number, t: number, usados: TramoOverlay) => {
      const vistos = new Set([s]);
      const pila = [s];
      while (pila.length) {
        const u = pila.pop()!;
        if (u === t) return true;
        for (let e = g.outStart[u]; e < g.outStart[u + 1]; e++) {
          if (usados.isUsed(g.edgeChain[e]) || g.edgeFlags[e] & EDGE_FLAG_DESTINATION_ONLY) continue;
          const v = g.edgeTo[e];
          if (!vistos.has(v)) {
            vistos.add(v);
            pila.push(v);
          }
        }
      }
      return false;
    };
    let conRuta = 0;
    for (let i = 0; i < 60; i++) {
      const ids = Array.from({ length: 3 + (i % 2) }, azar);
      const r = via(g, ids);
      if (r) {
        conRuta++;
        expect(sinRepeticionViolations(r.tramos)).toEqual([]);
        // Las estadísticas de la ruta unida suman las de sus tramos.
        const metros = r.tramos.reduce((s, u) => s + (u.s1 - u.s0), 0);
        expect(Math.abs(r.stats.distanceMeters - metros)).toBeLessThan(1e-6 * Math.max(1, metros));
        continue;
      }
      // Sin ruta: la pierna que falla de verdad no tiene camino con los tramos
      // ya usados por las anteriores (routeVia es voraz; reordenar es tarea de la ILS).
      const usados = new TramoOverlay(g);
      let from = [ep(g, ids[0])];
      for (let k = 1; k < ids.length; k++) {
        const leg = dijkstraMultiSource(g, from, [ep(g, ids[k])], SOLO_DISTANCIA, {
          blocked: usados,
          privateAccess: { origin: k === 1, dest: k === ids.length - 1 },
        });
        if (!leg) {
          expect(alcanzable(nodeIndex(g, ids[k - 1]), nodeIndex(g, ids[k]), usados)).toBe(false);
          break;
        }
        usados.addRoute(leg);
        from = [leg.dest!];
      }
    }
    expect(conRuta).toBeGreaterThanOrEqual(5);
  });
});
