import { IsLatitude, IsLongitude, IsNumber } from 'class-validator';
import { Type } from 'class-transformer';

export class ImportBboxDto {
  @Type(() => Number)
  @IsNumber()
  @IsLatitude()
  south: number;

  @Type(() => Number)
  @IsNumber()
  @IsLongitude()
  west: number;

  @Type(() => Number)
  @IsNumber()
  @IsLatitude()
  north: number;

  @Type(() => Number)
  @IsNumber()
  @IsLongitude()
  east: number;
}
