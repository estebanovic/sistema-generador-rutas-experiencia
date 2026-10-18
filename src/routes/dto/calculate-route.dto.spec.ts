import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { CalculateRouteDto } from './calculate-route.dto';

/** Valida como el ValidationPipe global (main.ts): whitelist y campos extra prohibidos. */
async function errores(body: Record<string, unknown>): Promise<string[]> {
  const dto = plainToInstance(CalculateRouteDto, body);
  const errs = await validate(dto, { whitelist: true, forbidNonWhitelisted: true });
  const out: string[] = [];
  const walk = (es: typeof errs, prefix = '') => {
    for (const e of es) {
      if (e.constraints) out.push(`${prefix}${e.property}`);
      if (e.children?.length) walk(e.children, `${prefix}${e.property}.`);
    }
  };
  walk(errs);
  return out;
}

const base = { origin: { lat: -33.4, lon: -70.6 }, destination: { lat: -33.5, lon: -70.7 } };

describe('CalculateRouteDto: pesos del perfil custom (F2)', () => {
  it('acepta pesos de 0 a 6 (superficie de -6 a 6)', async () => {
    expect(await errores({ ...base, profile: 'custom', customWeights: { curvinessWeight: 6, surfaceWeight: -6 } })).toEqual([]);
    expect(await errores({ ...base, profile: 'custom', customWeights: { curvinessWeight: 4.5, surfaceWeight: 5 } })).toEqual([]);
    expect(await errores({ ...base, profile: 'custom', customWeights: { curvinessWeight: 0, surfaceWeight: 2.5 } })).toEqual([]);
  });

  it('rechaza pesos fuera de rango', async () => {
    expect(await errores({ ...base, profile: 'custom', customWeights: { curvinessWeight: 6.5, surfaceWeight: 0 } })).toEqual([
      'customWeights.curvinessWeight',
    ]);
    expect(await errores({ ...base, profile: 'custom', customWeights: { curvinessWeight: 1, surfaceWeight: -7 } })).toEqual([
      'customWeights.surfaceWeight',
    ]);
    expect(await errores({ ...base, profile: 'custom', customWeights: { curvinessWeight: -1, surfaceWeight: 0 } })).toEqual([
      'customWeights.curvinessWeight',
    ]);
  });

  it.each(['distanceWeight', 'elevationWeight'])('rechaza el campo retirado %s', async (campo) => {
    expect(
      await errores({ ...base, profile: 'custom', customWeights: { curvinessWeight: 1, surfaceWeight: 0, [campo]: 0.5 } }),
    ).toEqual([`customWeights.${campo}`]);
  });
});

describe('CalculateRouteDto: campos retirados en F0.6', () => {
  it('rechaza tripLength (la vuelta con waypoints desviados ya no existe)', async () => {
    expect(await errores({ ...base, profile: 'moto-curvas', tripLength: 'direct' })).toEqual(['tripLength']);
  });

  it('acepta el pedido mínimo', async () => {
    expect(await errores({ ...base, profile: '4x4' })).toEqual([]);
  });
});

describe('CalculateRouteDto: presupuesto de desvío (F4)', () => {
  it.each([1, 1.5, 2.25, 3])('acepta maxDetourRatio = %s', async (v) => {
    expect(await errores({ ...base, profile: '4x4', maxDetourRatio: v })).toEqual([]);
  });

  it.each([0.9, 3.5, -1])('rechaza maxDetourRatio = %s (rango 1–3)', async (v) => {
    expect(await errores({ ...base, profile: '4x4', maxDetourRatio: v })).toEqual(['maxDetourRatio']);
  });

  it('no acepta un mínimo de desvío (solo hay límite superior)', async () => {
    expect(await errores({ ...base, profile: '4x4', minDetourRatio: 1.2 })).toEqual(['minDetourRatio']);
  });
});
