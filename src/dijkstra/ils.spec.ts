import { CompiledGraph } from './compiled-graph';
import { targetLengthRoute, TargetLengthResult } from './ils';
import { assertSinRepeticion, sinRepeticionViolations } from './no-repeat';
import { snapCandidates } from './snap';
import { circuitAnchor, circuitBand, circuitUpperBound, networkStructure } from './structure';
import { PROFILES } from '../routes/profiles';
import { grilla, loadFixture, randomPairs, synthetic, toGraph } from '../../test/fixtures/graph-fixtures';

const W = PROFILES['moto-curvas'];
const FAST = { timeBudgetMs: 400, seed: 7 };

const snapAt = (g: CompiledGraph, lat: number, lon: number) => {
  const c = snapCandidates(g, lat, lon);
  if (!c.length) throw new Error('sin snap');
  return c;
};

function ok(r: ReturnType<typeof targetLengthRoute>): TargetLengthResult {
  if ('error' in r) throw new Error(r.error);
  return r;
}

describe('ILS (F5): circuitos con longitud objetivo', () => {
  it('cuesta sin salida (§1.11, caso 1): nunca se entrega como circuito; es una ida y vuelta declarada', () => {
    // Lazo S–A–B (3 km) y una cuesta ciega A–C de 5 km. Pedidos 12 km: el único
    // modo de llegar es subir y bajar la cuesta.
    const g = toGraph(
      synthetic({ S: [0, 0], A: [0, 0.01], B: [0.006, 0.005], C: [0, 0.06] }, [
        { from: 'S', to: 'A', length: 1000 },
        { from: 'A', to: 'B', length: 1000 },
        { from: 'B', to: 'S', length: 1000 },
        { from: 'A', to: 'C', length: 5000 },
      ]),
    );
    const r = ok(targetLengthRoute(g, { origins: snapAt(g, 0, 0.002), weights: W, targetMeters: 12000, ...FAST }));
    expect(r.kind).toBe('ida-y-vuelta');
    expect(r.certain).toBe(true);
    expect(r.withinBand).toBe(true);
    expect(r.repeatedMeters).toBeCloseTo(r.achievedMeters, 6);
    assertSinRepeticion(r.route, r.exemptions);
    // Sin la exención declarada no pasa: la ida y vuelta repite tramos.
    expect(sinRepeticionViolations(r.route.tramos).length).toBeGreaterThan(0);
  });

  it('figura de 8 (§1.11, caso 2): pasar dos veces por la misma intersección sin repetir tramos es un circuito', () => {
    // Dos lazos de 5 km que comparten la intersección X. P y R tienen un ramal
    // corto para ser uniones (los waypoints de la ILS son nodos de unión).
    const g = toGraph(
      synthetic({ X: [0, 0], P: [0.01, 0.01], Q: [0.01, -0.01], R: [-0.01, 0.01], T: [-0.01, -0.01], P2: [0.011, 0.011], R2: [-0.011, 0.011] }, [
        { from: 'X', to: 'P', length: 1700, way: 'a' },
        { from: 'P', to: 'Q', length: 1600, way: 'a' },
        { from: 'Q', to: 'X', length: 1700, way: 'a' },
        { from: 'X', to: 'R', length: 1700, way: 'b' },
        { from: 'R', to: 'T', length: 1600, way: 'b' },
        { from: 'T', to: 'X', length: 1700, way: 'b' },
        { from: 'P', to: 'P2', length: 50, way: 'p' },
        { from: 'R', to: 'R2', length: 50, way: 'r' },
      ]),
    );
    const r = ok(targetLengthRoute(g, { origins: snapAt(g, 0.01, 0.01), weights: W, targetMeters: 10000, ...FAST }));
    expect(r.kind).toBe('circuito');
    expect(r.withinBand).toBe(true);
    expect(r.achievedMeters).toBeCloseTo(10000, 0);
    assertSinRepeticion(r.route); // sin exenciones
  });

  it('D19: si el acceso repetido supera el 25% del largo, se entrega una ida y vuelta declarada', () => {
    // Lazo de 6 km y un camino ciego de 4 km hasta el origen (acceso repetido: 8 km).
    const g = toGraph(
      synthetic({ O: [0, -0.04], X: [0, 0], P: [0.01, 0.01], Q: [0.01, -0.01] }, [
        { from: 'O', to: 'X', length: 4000 },
        { from: 'X', to: 'P', length: 2000 },
        { from: 'P', to: 'Q', length: 2000 },
        { from: 'Q', to: 'X', length: 2000 },
      ]),
    );
    const origins = snapAt(g, 0, -0.04);
    // 14 km: acceso 8 km = 57% → ida y vuelta, por el tope.
    const r = ok(targetLengthRoute(g, { origins, weights: W, targetMeters: 14000, ...FAST }));
    expect(r.kind).toBe('ida-y-vuelta');
    expect(r.certain).toBe(true);
    expect(r.reason).toMatch(/25%/);
    // La banda del circuito queda vacía con el tope y existe sin él.
    expect(circuitBand(14000, 0.15, 8000, 0.25)).toBeNull();
    expect(circuitBand(14000, 0.15, 8000, 1)).not.toBeNull();
  });

  it('el acceso cuenta para la banda y se exime solo en el acceso', () => {
    // Igual que arriba, pero con un lazo grande: 4 km de acceso (8 repetidos) y un
    // lazo de 30 km. P y Q tienen un ramal corto para ser uniones (los waypoints
    // de la ILS son nodos de unión; un lazo sin ninguna unión no se recorre).
    const g = toGraph(
      synthetic({ O: [0, -0.04], X: [0, 0], P: [0.1, 0.1], Q: [0.1, -0.1], P2: [0.101, 0.1], Q2: [0.101, -0.1] }, [
        { from: 'O', to: 'X', length: 4000 },
        { from: 'X', to: 'P', length: 10000 },
        { from: 'P', to: 'Q', length: 10000 },
        { from: 'Q', to: 'X', length: 10000 },
        { from: 'P', to: 'P2', length: 50 },
        { from: 'Q', to: 'Q2', length: 50 },
      ]),
    );
    const r = ok(targetLengthRoute(g, { origins: snapAt(g, 0, -0.04), weights: W, targetMeters: 38000, ...FAST }));
    expect(r.kind).toBe('circuito');
    expect(r.accessRepeatedMeters).toBeGreaterThan(7000);
    expect(r.accessRepeatedMeters / r.achievedMeters).toBeLessThanOrEqual(0.25);
    assertSinRepeticion(r.route, r.exemptions);
    // Las exenciones son solo los tramos del acceso.
    expect(r.exemptions).toHaveLength(1);
  });

  it('es reproducible con la misma semilla', () => {
    const plain = loadFixture('farellones');
    const g = toGraph(plain);
    const [a] = randomPairs(plain, 1, 3)[0];
    const n = plain.nodes.find((x) => x.osmId === a)!;
    const req = { origins: snapAt(g, n.lat, n.lon), weights: W, targetMeters: 8000, timeBudgetMs: 10_000, seed: 11 };
    const r1 = ok(targetLengthRoute(g, req));
    const r2 = ok(targetLengthRoute(g, req));
    expect(r2.kind).toBe(r1.kind);
    expect(r2.route.path).toEqual(r1.route.path);
  });
});

describe('ILS (F5): ruta con destino fijo y longitud objetivo', () => {
  it('en una grilla, alarga la ruta hasta la banda sin repetir tramos', () => {
    const g = toGraph(grilla(8)); // cuadras de 100 m
    const o = snapAt(g, 0, 0);
    const d = snapAt(g, 0.0063, 0.0063);
    const r = ok(targetLengthRoute(g, { origins: o, dests: d, weights: W, targetMeters: 3000, ...FAST }));
    expect(r.kind).toBe('ruta');
    expect(r.withinBand).toBe(true);
    assertSinRepeticion(r.route);
  });

  it('si la longitud pedida es menor que la distancia mínima, entrega la más cercana marcada fuera de la banda', () => {
    const g = toGraph(grilla(8));
    const r = ok(targetLengthRoute(g, { origins: snapAt(g, 0, 0), dests: snapAt(g, 0.0063, 0.0063), weights: W, targetMeters: 400, ...FAST }));
    expect(r.kind).toBe('ruta');
    expect(r.withinBand).toBe(false);
    expect(r.reason).toBeDefined();
  });
});

describe('estructura de la red (F5)', () => {
  it('los puentes se calculan sobre la red pública: un ciclo cerrado solo por una calle privada no cuenta', () => {
    // A–B–C–A: el tramo C–A es privado, así que A–B y B–C son puentes de la red pública.
    const g = toGraph(
      synthetic({ A: [0, 0], B: [0, 0.01], C: [0.01, 0.005], D: [0, -0.01] }, [
        { from: 'A', to: 'B', length: 1000 },
        { from: 'B', to: 'C', length: 1000 },
        { from: 'C', to: 'A', length: 1000, destinationOnly: true },
        { from: 'A', to: 'D', length: 1000 },
      ]),
    );
    const st = networkStructure(g);
    let publicNonBridge = 0;
    for (let c = 0; c < g.meta.chainCount; c++) if ((g.chainFlags[c] & 1) === 0 && !st.publicBridge[c]) publicNonBridge++;
    expect(publicNonBridge).toBe(0);
  });

  it('propiedad sobre Farellones: nunca viola el verificador y nunca entrega un circuito donde la cota demuestra que no existe', () => {
    const plain = loadFixture('farellones');
    const g = toGraph(plain);
    for (const [a] of randomPairs(plain, 12, 21)) {
      const n = plain.nodes.find((x) => x.osmId === a)!;
      const origins = snapCandidates(g, n.lat, n.lon);
      if (!origins.length) continue;
      for (const km of [5, 12]) {
        const res = targetLengthRoute(g, { origins, weights: W, targetMeters: km * 1000, timeBudgetMs: 250, seed: 5 });
        if ('error' in res) continue;
        expect(sinRepeticionViolations(res.route.tramos, res.exemptions)).toEqual([]);
        const anchor = circuitAnchor(g, origins[0]);
        if ('error' in anchor) continue;
        const band = circuitBand(km * 1000, 0.15, anchor.accessMeters);
        if (!band || circuitUpperBound(g, anchor, band.hi / 2).total < band.lo) expect(res.kind).not.toBe('circuito');
        if (res.kind === 'circuito') expect(res.withinBand).toBe(true);
      }
    }
  });
});
