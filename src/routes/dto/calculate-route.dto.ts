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
import { PROFILE_NAMES, ProfileName } from '../profiles';

export const TRIP_LENGTHS = ['direct', 'short', 'medium', 'long'] as const;
export type TripLength = (typeof TRIP_LENGTHS)[number];

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

  // Largo de la "vuelta": direct = óptima; short/medium/long = desvíos crecientes.
  @IsOptional()
  @IsIn(TRIP_LENGTHS)
  tripLength?: TripLength;
}
