import { Body, Controller, Post } from '@nestjs/common';
import { RoutesService } from './routes.service';
import { CalculateRouteDto } from './dto/calculate-route.dto';
import { RouteResult } from '../dijkstra/types';

@Controller('routes')
export class RoutesController {
  constructor(private readonly routesService: RoutesService) {}

  @Post('calculate')
  async calculate(@Body() dto: CalculateRouteDto): Promise<RouteResult> {
    return this.routesService.calculate(dto);
  }
}
