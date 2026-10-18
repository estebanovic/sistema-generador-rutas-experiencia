import { CAMINO_A_FARELLONES_WAY_IDS, loadFixture, seededRandom } from '../../test/fixtures/graph-fixtures';
import { CURVY_THRESHOLD_DEG_PER_KM, normalizedCurviness, segmentLengths, turnDensity } from './curviness';

type Pt = { lat: number; lon: number };
const LAT0 = -33.4;
const M_LAT = 1 / 111_320;
const M_LON = 1 / (111_320 * Math.cos((LAT0 * Math.PI) / 180));
/** Punto a (x, y) metros del origen local. */
const pt = (x: number, y: number): Pt => ({ lat: LAT0 + y * M_LAT, lon: -70.6 + x * M_LON });

/** Media ponderada por metros de la densidad de giro de una polilínea. */
function meanDensity(coords: Pt[]): number {
  const d = turnDensity(coords);
  const l = segmentLengths(coords);
  let s = 0;
  let w = 0;
  for (let i = 0; i < d.length; i++) {
    s += d[i] * l[i];
    w += l[i];
  }
  return s / w;
}

/** Inserta k−1 puntos colineales en cada segmento (misma geometría, más nodos). */
function densify(coords: Pt[], k: number): Pt[] {
  const out: Pt[] = [coords[0]];
  for (let i = 0; i < coords.length - 1; i++) {
    for (let j = 1; j <= k; j++) {
      out.push({
        lat: coords[i].lat + ((coords[i + 1].lat - coords[i].lat) * j) / k,
        lon: coords[i].lon + ((coords[i + 1].lon - coords[i].lon) * j) / k,
      });
    }
  }
  return out;
}

/** Ruido de digitalización gaussiano de σ metros en los nodos interiores. */
function jitter(coords: Pt[], sigma: number, seed: number): Pt[] {
  const rnd = seededRandom(seed);
  const gauss = () => Math.sqrt(-2 * Math.log(rnd() + 1e-12)) * Math.cos(2 * Math.PI * rnd());
  return coords.map((c, i) =>
    i === 0 || i === coords.length - 1 ? c : { lat: c.lat + gauss() * sigma * M_LAT, lon: c.lon + gauss() * sigma * M_LON },
  );
}

const recta = Array.from({ length: 150 }, (_, i) => pt(i * 7, 0)); // ~1 km
// Camino sinuoso: senoide de 50 m de amplitud y 400 m de longitud de onda, 3 km, un nodo cada 15 m.
const sinuoso = Array.from({ length: 201 }, (_, i) => pt(i * 15, 50 * Math.sin((2 * Math.PI * i * 15) / 400)));

describe('sinuosidad nueva (°/km con ventana e histéresis)', () => {
  it('una recta da 0', () => {
    expect(Math.max(...turnDensity(recta))).toBe(0);
  });

  it('un arco de radio r da ≈ 57.296 / r °/km (lejos de los extremos)', () => {
    for (const r of [100, 200, 400]) {
      const arc: Pt[] = [];
      for (let s = 0; s <= 1500; s += 5) arc.push(pt(r * Math.sin(s / r), r * (1 - Math.cos(s / r))));
      const d = turnDensity(arc);
      const centro = d.slice(Math.floor(d.length * 0.3), Math.floor(d.length * 0.7));
      const media = centro.reduce((a, b) => a + b, 0) / centro.length;
      const teorico = 57_295.8 / r;
      expect(Math.abs(media - teorico) / teorico).toBeLessThan(0.1);
    }
  });

  it('densificar ×3 (mismos trazos, más nodos) cambia la media menos de 2%', () => {
    const a = meanDensity(sinuoso);
    const b = meanDensity(densify(sinuoso, 3));
    expect(Math.abs(b - a) / a).toBeLessThan(0.02);
  });

  it('ruido de digitalización de 1 m cambia la media menos de 5%', () => {
    const a = meanDensity(sinuoso);
    const b = meanDensity(jitter(sinuoso, 1, 42));
    expect(Math.abs(b - a) / a).toBeLessThan(0.05);
  });

  it('una recta con ruido de 1 m sigue siendo casi recta (< 20 °/km)', () => {
    expect(meanDensity(jitter(recta, 1, 7))).toBeLessThan(20);
  });

  it('normalizada: 0 en recta, satura en 1 desde 300 °/km', () => {
    expect(normalizedCurviness(0)).toBe(0);
    expect(normalizedCurviness(150)).toBeCloseTo(0.5, 9);
    expect(normalizedCurviness(900)).toBe(1);
  });

  describe('Camino a Farellones (G-21) en el subgrafo real', () => {
    // Reconstruye la secuencia de nodos de cada way a partir de sus aristas.
    const f = loadFixture('farellones');
    const coords = new Map(f.nodes.map((n) => [n.osmId, { lat: n.lat, lon: n.lon }]));
    const ways = new Set(CAMINO_A_FARELLONES_WAY_IDS);
    const nb = new Map<string, Map<string, Set<string>>>();
    for (const e of f.edges) {
      if (!ways.has(e.osmWayId ?? '')) continue;
      const m = nb.get(e.osmWayId!) ?? new Map<string, Set<string>>();
      nb.set(e.osmWayId!, m);
      for (const [a, b] of [[e.fromOsmId, e.toOsmId], [e.toOsmId, e.fromOsmId]]) {
        const s = m.get(a) ?? new Set<string>();
        s.add(b);
        m.set(a, s);
      }
    }
    let metros = 0;
    let curvos = 0;
    for (const m of nb.values()) {
      const start = [...m.keys()].find((k) => m.get(k)!.size === 1) ?? [...m.keys()][0];
      const seq = [start];
      const seen = new Set([start]);
      for (;;) {
        const next = [...m.get(seq[seq.length - 1])!].find((x) => !seen.has(x));
        if (!next) break;
        seq.push(next);
        seen.add(next);
      }
      const pts = seq.map((id) => coords.get(id)!);
      const d = turnDensity(pts);
      const l = segmentLengths(pts);
      for (let i = 0; i < d.length; i++) {
        metros += l[i];
        if (d[i] >= CURVY_THRESHOLD_DEG_PER_KM) curvos += l[i];
      }
    }

    it('al menos 80% de sus metros es tramo curvo (≥ 100 °/km)', () => {
      expect(metros / 1000).toBeGreaterThan(20);
      expect(curvos / metros).toBeGreaterThanOrEqual(0.8);
    });
  });
});
