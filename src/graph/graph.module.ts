import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { GraphService } from './graph.service';
import { Node, NodeSchema } from './schemas/node.schema';
import { Edge, EdgeSchema } from './schemas/edge.schema';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: Node.name, schema: NodeSchema },
      { name: Edge.name, schema: EdgeSchema },
    ]),
  ],
  providers: [GraphService],
  exports: [GraphService],
})
export class GraphModule {}
