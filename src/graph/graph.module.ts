import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { GraphService } from './graph.service';
import { OsmStoreService } from './osm-store.service';
import { Node, NodeSchema } from './schemas/node.schema';
import { Edge, EdgeSchema } from './schemas/edge.schema';
import {
  GraphMeta,
  GraphMetaSchema,
  OsmImport,
  OsmImportSchema,
  OsmNode,
  OsmNodeSchema,
  OsmWay,
  OsmWaySchema,
} from './schemas/osm.schemas';

@Module({
  imports: [
    MongooseModule.forFeature([
      // Anteriores a F0.1 (solo lectura, GRAPH_SOURCE=legacy).
      { name: Node.name, schema: NodeSchema },
      { name: Edge.name, schema: EdgeSchema },
      // Almacén canónico por way.
      { name: OsmWay.name, schema: OsmWaySchema },
      { name: OsmNode.name, schema: OsmNodeSchema },
      { name: OsmImport.name, schema: OsmImportSchema },
      { name: GraphMeta.name, schema: GraphMetaSchema },
    ]),
  ],
  providers: [GraphService, OsmStoreService],
  exports: [GraphService, OsmStoreService],
})
export class GraphModule {}
