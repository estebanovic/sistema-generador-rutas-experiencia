import { HighwayType } from '../dijkstra/types';
import { categoryOf, declaredSurface, inferSurfaces, SurfaceWay } from './surface';

describe('superficie (F0.5) — normalización del tag', () => {
  it.each([
    ['asphalt', 'asphalt'],
    ['paved', 'asphalt'], // antes se mapeaba a concrete
    ['concrete:plates', 'concrete'],
    ['paving_stones', 'concrete'],
    ['sett', 'cobblestone'], // antes quedaba "unknown"
    ['unhewn_cobblestone', 'cobblestone'],
    ['compacted', 'gravel'],
    ['fine_gravel', 'gravel'],
    ['unpaved', 'gravel'],
    ['ground', 'dirt'],
    ['grass', 'dirt'],
    ['sand', 'sand'],
    ['asphalt;gravel', 'asphalt'],
  ])('surface=%s → %s', (raw, expected) => {
    expect(declaredSurface({ surface: raw })?.surface).toBe(expected);
  });

  it('valores no reconocidos no cuentan como declarados', () => {
    expect(declaredSurface({ surface: 'algo_raro' })).toBeNull();
    expect(declaredSurface({})).toBeNull();
  });

  it('tracktype en pistas: grade1 pavimentada, grade2 ripio, grade3-5 tierra', () => {
    expect(declaredSurface({ highway: 'track', tracktype: 'grade1' })).toEqual({ surface: 'asphalt', source: 'tracktype' });
    expect(declaredSurface({ highway: 'track', tracktype: 'grade2' })?.surface).toBe('gravel');
    expect(categoryOf(declaredSurface({ highway: 'track', tracktype: 'grade4' })!.surface)).toBe('unpaved');
  });

  it('surface declarado manda sobre tracktype', () => {
    expect(declaredSurface({ surface: 'asphalt', tracktype: 'grade4' })).toEqual({ surface: 'asphalt', source: 'declarada' });
  });
});

describe('superficie (F0.5) — inferencia', () => {
  const way = (id: string, highway: HighwayType, nodeIds: string[], tags: Record<string, string> = {}, length = 100): SurfaceWay => ({
    id, highway, nodeIds, tags: { highway, ...tags }, length,
  });

  it('sin dato: vota la vecindad del mismo tipo de vía, ponderada por metros', () => {
    const r = inferSurfaces([
      way('a', 'residential', ['1', '2'], { surface: 'gravel' }, 300),
      way('b', 'residential', ['2', '3'], { surface: 'asphalt' }, 100),
      way('c', 'primary', ['2', '9'], { surface: 'asphalt' }, 5000), // otro tipo: no pesa si hay del mismo tipo
      way('x', 'residential', ['2', '4']),
    ]);
    expect(r.get('x')).toEqual({ surface: 'gravel', source: 'vecindad' });
  });

  it('si no hay vecinos del mismo tipo, votan los de cualquier tipo', () => {
    const r = inferSurfaces([way('c', 'primary', ['1', '2'], { surface: 'asphalt' }), way('x', 'service', ['2', '3'])]);
    expect(r.get('x')).toEqual({ surface: 'asphalt', source: 'vecindad' });
  });

  it('sin vecinos declarados: regla por tipo (track → sin pavimentar, residential → pavimentada)', () => {
    const r = inferSurfaces([way('t', 'track', ['1', '2']), way('r', 'residential', ['5', '6'])]);
    expect(r.get('t')).toEqual({ surface: 'gravel', source: 'tipo' });
    expect(r.get('r')).toEqual({ surface: 'asphalt', source: 'tipo' });
  });

  it('los inferidos no votan (no hay propagación en cadena)', () => {
    const r = inferSurfaces([
      way('d', 'track', ['1', '2'], { surface: 'dirt' }),
      way('x', 'track', ['2', '3']), // vecindad → sin pavimentar
      way('y', 'residential', ['3', '4']), // solo toca a x (inferido) → regla por tipo
    ]);
    expect(r.get('x')!.source).toBe('vecindad');
    expect(r.get('y')).toEqual({ surface: 'asphalt', source: 'tipo' });
  });
});
