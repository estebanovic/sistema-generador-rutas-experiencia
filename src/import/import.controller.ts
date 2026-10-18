import { Body, Controller, Post } from '@nestjs/common';
import { ImportService, ImportResult } from './import.service';
import { ImportBboxDto } from './dto/import-bbox.dto';

@Controller('import')
export class ImportController {
  constructor(private readonly importService: ImportService) {}

  @Post()
  async import(@Body() bbox: ImportBboxDto): Promise<ImportResult> {
    return this.importService.import(bbox);
  }
}
