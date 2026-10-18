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

export class RouteWeightsDto {
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  @Max(1)
  distanceWeight: number;

  @Type(() => Number)
  @IsNumber()
  @Min(0)
  @Max(1)
  curvinessWeight: number;

  // Firmado: >0 prefiere plano, <0 prefiere montañoso (con desnivel).
  @Type(() => Number)
  @IsNumber()
  @Min(-1)
  @Max(1)
  elevationWeight: number;

  // Firmado: >0 prefiere pavimento, <0 prefiere rural/ripio.
  @Type(() => Number)
  @IsNumber()
  @Min(-1)
  @Max(1)
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
