import { HighwayType, SurfaceType } from '../dijkstra/types';

/**
 * Superficie (F0.5): normalización del tag crudo `surface`, `tracktype` en las
 * pistas e inferencia cuando falta (vecindad → tipo de vía). Ver plan, §1.3.
 */
export type SurfaceSource = 'declarada' | 'tracktype' | 'vecindad' | 'tipo';
export const SURFACE_SOURCES: readonly SurfaceSource[] = ['declarada', 'tracktype', 'vecindad', 'tipo'];

type Cat = 'paved' | 'unpaved';

const SURFACE_MAP: Record<string, SurfaceType> = {
  // Pavimentadas
  asphalt: 'asphalt',
  paved: 'asphalt',
  chipseal: 'asphalt',
  concrete: 'concrete',
  'concrete:plates': 'concrete',
  'concrete:lanes': 'concrete',
  paving_stones: 'concrete',
  metal: 'concrete',
  wood: 'concrete',
  sett: 'cobblestone',
  cobblestone: 'cobblestone',
  'cobblestone:flattened': 'cobblestone',
  unhewn_cobblestone: 'cobblestone',
  bricks: 'cobblestone',
  // Sin pavimentar
  unpaved: 'gravel',
  compacted: 'gravel',
  fine_gravel: 'gravel',
  gravel: 'gravel',
  pebblestone: 'gravel',
  rock: 'gravel',
  shells: 'gravel',
  ground: 'dirt',
  dirt: 'dirt',
  earth: 'dirt',
  soil: 'dirt',
  mud: 'dirt',
  grass: 'dirt',
  grass_paver: 'dirt',
  sand: 'sand',
};

const TRACKTYPE_MAP: Record<string, SurfaceType> = {
  grade1: 'asphalt',
  grade2: 'gravel',
  grade3: 'dirt',
  grade4: 'dirt',
  grade5: 'dirt',
};

/** Regla por tipo de vía (mayoría en los datos declarados, §1.3). */
const TYPE_RULE: Record<HighwayType, Cat> = {
  motorway: 'paved',
  trunk: 'paved',
  primary: 'paved',
  secondary: 'paved',
  tertiary: 'paved',
  residential: 'paved',
  service: 'paved',
  living_street: 'paved',
  unclassified: 'unpaved',
  track: 'unpaved',
  path: 'unpaved',
};

export function categoryOf(s: SurfaceType): Cat | null {
  if (s === 'asphalt' || s === 'concrete' || s === 'cobblestone') return 'paved';
  if (s === 'gravel' || s === 'dirt' || s === 'sand') return 'unpaved';
  return null;
}

/** Superficie que se usa cuando solo se conoce la categoría (inferida). */
const REPRESENTATIVE: Record<Cat, SurfaceType> = { paved: 'asphalt', unpaved: 'gravel' };

/** Superficie declarada en los tags (surface, o tracktype en pistas), o null. */
export function declaredSurface(tags: Record<string, string>): { surface: SurfaceType; source: SurfaceSource } | null {
  const raw = tags.surface?.trim().toLowerCase();
  if (raw) {
    // Valores múltiples (`asphalt;gravel`): manda el primero reconocido.
    for (const v of raw.split(';')) {
      const s = SURFACE_MAP[v.trim()];
      if (s) return { surface: s, source: 'declarada' };
    }
  }
  const tt = tags.tracktype?.trim().toLowerCase();
  if (tt && TRACKTYPE_MAP[tt]) return { surface: TRACKTYPE_MAP[tt], source: 'tracktype' };
  return null;
}

export interface SurfaceWay {
  id: string;
  highway: HighwayType;
  nodeIds: string[];
  tags: Record<string, string>;
  /** Largo del way en metros (para ponderar los votos). */
  length: number;
}

/**
 * Superficie de cada way: la declarada si existe; si no, la mayoría (por
 * metros) entre los ways vecinos (que comparten un nodo) con superficie
 * declarada —prefiriendo los del mismo tipo de vía—; si no hay vecinos
 * declarados, la regla por tipo de vía.
 */
export function inferSurfaces(ways: SurfaceWay[]): Map<string, { surface: SurfaceType; source: SurfaceSource }> {
  const out = new Map<string, { surface: SurfaceType; source: SurfaceSource }>();
  // Votos de los ways declarados en cada uno de sus nodos.
  const votes = new Map<string, { cat: Cat; hw: HighwayType; len: number }[]>();
  for (const w of ways) {
    const d = declaredSurface(w.tags);
    if (!d) continue;
    out.set(w.id, d);
    const cat = categoryOf(d.surface);
    if (!cat) continue;
    for (const n of w.nodeIds) {
      const l = votes.get(n);
      const v = { cat, hw: w.highway, len: w.length };
      if (l) l.push(v);
      else votes.set(n, [v]);
    }
  }
  for (const w of ways) {
    if (out.has(w.id)) continue;
    const all = { paved: 0, unpaved: 0 };
    const same = { paved: 0, unpaved: 0 };
    for (const n of w.nodeIds) {
      for (const v of votes.get(n) ?? []) {
        all[v.cat] += v.len;
        if (v.hw === w.highway) same[v.cat] += v.len;
      }
    }
    const use = same.paved + same.unpaved > 0 ? same : all;
    if (use.paved + use.unpaved > 0) {
      out.set(w.id, { surface: REPRESENTATIVE[use.paved >= use.unpaved ? 'paved' : 'unpaved'], source: 'vecindad' });
    } else {
      out.set(w.id, { surface: REPRESENTATIVE[TYPE_RULE[w.highway] ?? 'paved'], source: 'tipo' });
    }
  }
  return out;
}
