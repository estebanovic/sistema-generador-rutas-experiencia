import { exclusionReason, isDestinationOnly, parseHighway, parseOneway } from './normalize';

describe('normalize — reglas de exclusión (D7)', () => {
  it.each([
    [{ highway: 'service', service: 'parking_aisle' }, 'service-subtipo'],
    [{ highway: 'service', service: 'driveway' }, 'service-subtipo'],
    [{ highway: 'service', service: 'drive-through' }, 'service-subtipo'],
    [{ highway: 'track', access: 'agricultural' }, 'acceso-restringido'],
    [{ highway: 'track', access: 'forestry' }, 'acceso-restringido'],
    [{ highway: 'tertiary', access: 'no' }, 'acceso-restringido'],
    [{ highway: 'track', motor_vehicle: 'no' }, 'no-motorizado'],
    [{ highway: 'residential', motorcar: 'no' }, 'no-motorizado'],
    [{ highway: 'construction' }, 'construccion'],
    [{ highway: 'footway' }, 'highway-no-ruteable'],
  ])('%j → %s', (tags, rule) => {
    expect(exclusionReason(tags as Record<string, string>)).toBe(rule);
  });

  it.each([
    [{ highway: 'service' }],
    [{ highway: 'service', service: 'alley' }],
    [{ highway: 'living_street' }],
    [{ highway: 'track', tracktype: 'grade3' }],
    [{ highway: 'motorway_link' }],
    [{ highway: 'residential', access: 'destination' }],
    // El tag más específico manda: acceso general prohibido pero motorizados sí.
    [{ highway: 'residential', access: 'no', motor_vehicle: 'yes' }],
    [{ highway: 'track', access: 'private', motorcar: 'permissive' }],
  ])('%j se incluye', (tags) => {
    expect(exclusionReason(tags as Record<string, string>)).toBeNull();
  });

  it('access=private se incluye como solo-origen/destino (decisión D7)', () => {
    const casos: Record<string, string>[] = [
      { highway: 'residential', access: 'private' },
      { highway: 'track', access: 'private' },
      { highway: 'service', motor_vehicle: 'private' },
      { highway: 'track', access: 'private;agricultural' },
    ];
    for (const tags of casos) {
      expect(exclusionReason(tags)).toBeNull();
      expect(isDestinationOnly(tags)).toBe(true);
    }
    expect(isDestinationOnly({ highway: 'residential' })).toBe(false);
    expect(isDestinationOnly({ highway: 'residential', access: 'destination' })).toBe(false);
    // El tag específico abierto prevalece sobre access=private.
    expect(isDestinationOnly({ highway: 'track', access: 'private', motorcar: 'yes' })).toBe(false);
  });

  it('el tag específico también puede restringir aunque access permita', () => {
    expect(exclusionReason({ highway: 'track', access: 'yes', motor_vehicle: 'agricultural;forestry' })).toBe('no-motorizado');
  });
});

describe('normalize — atributos', () => {
  it('los ramales toman el tipo de su vía base', () => {
    expect(parseHighway('motorway_link')).toBe('motorway');
    expect(parseHighway('primary_link')).toBe('primary');
    expect(parseHighway('living_street')).toBe('living_street');
  });

  it('rotondas de un sentido salvo indicación contraria', () => {
    expect(parseOneway({ highway: 'primary', junction: 'roundabout' })).toBe('forward');
    expect(parseOneway({ highway: 'primary', junction: 'roundabout', oneway: 'no' })).toBe('no');
    expect(parseOneway({ highway: 'motorway' })).toBe('forward');
    expect(parseOneway({ highway: 'residential', oneway: '-1' })).toBe('backward');
    expect(parseOneway({ highway: 'residential' })).toBe('no');
  });
});
