import { Type } from 'class-transformer';
import {
  IsIn,
  IsLatitude,
  IsLongitude,
  IsNumber,
  IsOptional,
  Max,
  Min,
  ValidateNested,
} from 'class-validator';
import { W_MAX } from '../../dijkstra/cost';
import { MAX_DETOUR_RATIO, MIN_DETOUR_RATIO, PROFILE_NAMES, ProfileName } from '../profiles';

export class LatLonDto {
  @Type(() => Number)
  @IsNumber()
  @IsLatitude()
  lat: number;

  @Type(() => Number)
  @IsNumber()
  @IsLongitude()
  lon: number;
}

/**
 * Pesos del perfil `custom` (F2): de 0 a W_MAX (4). Desde F2 ya no existen
 * `distanceWeight` (la distancia es la base del costo) ni `elevationWeight`
 * (sin datos de elevación); enviarlos es un error de validación.
 */
export class RouteWeightsDto {
  // Cuánto se evitan las rectas.
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  @Max(W_MAX)
  curvinessWeight: number;

  // Firmado: >0 evita lo sin pavimentar, <0 evita el pavimento (prefiere ripio/tierra).
  @Type(() => Number)
  @IsNumber()
  @Min(-W_MAX)
  @Max(W_MAX)
  surfaceWeight: number;
}

/**
 * Desde F0.6 no existe `tripLength` (la "vuelta" con waypoints desviados): la
 * modalidad con longitud objetivo se hará con la ILS. Enviarlo es un error.
 */
export class CalculateRouteDto {
  @ValidateNested()
  @Type(() => LatLonDto)
  origin: LatLonDto;

  @ValidateNested()
  @Type(() => LatLonDto)
  destination: LatLonDto;

  // `@IsIn` es lo correcto para validar contra un array de literales.
  @IsIn(PROFILE_NAMES)
  profile: ProfileName;

  @IsOptional()
  @ValidateNested()
  @Type(() => RouteWeightsDto)
  customWeights?: RouteWeightsDto;

  /**
   * Presupuesto de desvío (F4, D5): largo máximo de la ruta / distancia mínima.
   * Por defecto el del perfil (moto-curvas ×1,5, 4x4 ×2,0, scenic ×1,5,
   * custom ×1,5). Solo hay límite superior.
   */
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(MIN_DETOUR_RATIO)
  @Max(MAX_DETOUR_RATIO)
  maxDetourRatio?: number;
}
