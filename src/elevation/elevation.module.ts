import { Module } from '@nestjs/common';
import { ElevationService } from './elevation.service';

@Module({
  providers: [ElevationService],
  exports: [ElevationService],
})
export class ElevationModule {}
