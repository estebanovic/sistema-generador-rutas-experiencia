import { snapCandidates } from '../dijkstra/snap';
import { synthetic, toGraph } from '../../test/fixtures/graph-fixtures';
import { IlsPool } from './ils-pool';
import { PROFILES } from './profiles';

describe('IlsPool (F5)', () => {
  it('sin grafo en memoria compartida (o sin el worker compilado) calcula en el hilo principal', async () => {
    const g = toGraph(
      synthetic({ S: [0, 0], A: [0, 0.01], B: [0.006, 0.005], C: [0, 0.06] }, [
        { from: 'S', to: 'A', length: 1000 },
        { from: 'A', to: 'B', length: 1000 },
        { from: 'B', to: 'S', length: 1000 },
        { from: 'A', to: 'C', length: 5000 },
      ]),
    );
    const pool = new IlsPool();
    const r = await pool.run(g, {
      origins: snapCandidates(g, 0, 0.002),
      weights: PROFILES['moto-curvas'],
      targetMeters: 12000,
      timeBudgetMs: 400,
      seed: 7,
    });
    if ('error' in r) throw new Error(r.error);
    expect(r.kind).toBe('ida-y-vuelta');
    expect(r.withinBand).toBe(true);
    await pool.onModuleDestroy();
  });
});
