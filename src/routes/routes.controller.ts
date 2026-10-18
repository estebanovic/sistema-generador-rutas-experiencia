import { Body, Controller, Post } from '@nestjs/common';
import { RouteResponse, RoutesService } from './routes.service';
import { CalculateRouteDto } from './dto/calculate-route.dto';

@Controller('routes')
export class RoutesController {
  constructor(private readonly routesService: RoutesService) {}

  @Post('calculate')
  async calculate(@Body() dto: CalculateRouteDto): Promise<RouteResponse> {
    return this.routesService.calculate(dto);
  }
}
