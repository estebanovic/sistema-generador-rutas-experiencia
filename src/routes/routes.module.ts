import { Module } from '@nestjs/common';
import { RoutesService } from './routes.service';
import { IlsPool } from './ils-pool';
import { RoutesController } from './routes.controller';
import { GraphModule } from '../graph/graph.module';

@Module({
  imports: [GraphModule],
  controllers: [RoutesController],
  providers: [RoutesService, IlsPool],
})
export class RoutesModule {}
