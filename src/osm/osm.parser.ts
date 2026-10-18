import { Injectable } from '@nestjs/common';
import { RawNode, RawWay, STORED_TAGS } from '../graph-compiler/raw';
import { OsmNodeElement, OsmWayElement, OverpassResponse } from './osm.types';

export interface ParsedOsm {
  ways: RawWay[];
  nodes: RawNode[];
}

/**
 * Convierte la respuesta de Overpass al modelo canónico (ways crudos + nodos).
 * No normaliza ni filtra por tipo de vía o acceso: eso lo hace el compilador
 * (`src/graph-compiler/`), para poder cambiar las reglas sin reimportar.
 */
@Injectable()
export class OsmParser {
  parse(data: OverpassResponse): ParsedOsm {
    const osmNodes = new Map<number, OsmNodeElement>();
    const wayEls: OsmWayElement[] = [];
    for (const el of data.elements ?? []) {
      if (el.type === 'node') osmNodes.set((el as OsmNodeElement).id, el as OsmNodeElement);
      else if (el.type === 'way') wayEls.push(el as OsmWayElement);
    }

    const ways: RawWay[] = [];
    const referenced = new Set<number>();
    for (const w of wayEls) {
      const nodeIds = (w.nodes ?? []).filter((id) => osmNodes.has(id));
      if (nodeIds.length < 2) continue;
      const tags: Record<string, string> = {};
      for (const k of STORED_TAGS) {
        const v = w.tags?.[k];
        if (v !== undefined) tags[k] = v;
      }
      for (const id of nodeIds) referenced.add(id);
      ways.push({ osmWayId: String(w.id), nodeIds: nodeIds.map(String), tags });
    }

    const nodes: RawNode[] = [];
    for (const id of referenced) {
      const n = osmNodes.get(id)!;
      nodes.push({ osmId: String(n.id), lat: n.lat, lon: n.lon });
    }
    return { ways, nodes };
  }
}
