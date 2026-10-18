import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { MongooseModule } from '@nestjs/mongoose';
import { GraphModule } from './graph/graph.module';
import { OsmModule } from './osm/osm.module';
import { ElevationModule } from './elevation/elevation.module';
import { ImportModule } from './import/import.module';
import { RoutesModule } from './routes/routes.module';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    MongooseModule.forRoot(
      process.env.MONGO_URI ?? 'mongodb://localhost:27017/generador-rutas',
    ),
    GraphModule,
    OsmModule,
    ElevationModule,
    ImportModule,
    RoutesModule,
  ],
})
export class AppModule {}
