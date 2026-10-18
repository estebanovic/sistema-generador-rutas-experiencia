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
  it('acepta pesos de 0 a 4 (superficie de -4 a 4)', async () => {
    expect(await errores({ ...base, profile: 'custom', customWeights: { curvinessWeight: 4, surfaceWeight: -4 } })).toEqual([]);
    expect(await errores({ ...base, profile: 'custom', customWeights: { curvinessWeight: 0, surfaceWeight: 2.5 } })).toEqual([]);
  });

  it('rechaza pesos fuera de rango', async () => {
    expect(await errores({ ...base, profile: 'custom', customWeights: { curvinessWeight: 4.5, surfaceWeight: 0 } })).toEqual([
      'customWeights.curvinessWeight',
    ]);
    expect(await errores({ ...base, profile: 'custom', customWeights: { curvinessWeight: 1, surfaceWeight: -5 } })).toEqual([
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
