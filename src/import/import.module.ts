import { Module } from '@nestjs/common';
import { ImportService } from './import.service';
import { ImportController } from './import.controller';
import { GraphModule } from '../graph/graph.module';
import { OsmModule } from '../osm/osm.module';
import { ElevationModule } from '../elevation/elevation.module';

@Module({
  imports: [GraphModule, OsmModule, ElevationModule],
  controllers: [ImportController],
  providers: [ImportService],
})
export class ImportModule {}
