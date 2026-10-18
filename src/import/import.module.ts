import { Module } from '@nestjs/common';
import { ImportService } from './import.service';
import { ImportController } from './import.controller';
import { GraphModule } from '../graph/graph.module';
import { OsmModule } from '../osm/osm.module';

@Module({
  imports: [GraphModule, OsmModule],
  controllers: [ImportController],
  providers: [ImportService],
  exports: [ImportService],
})
export class ImportModule {}
