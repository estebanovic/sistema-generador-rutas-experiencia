import { Module } from '@nestjs/common';
import { OsmService } from './osm.service';
import { OsmParser } from './osm.parser';

@Module({
  providers: [OsmService, OsmParser],
  exports: [OsmService, OsmParser],
})
export class OsmModule {}
