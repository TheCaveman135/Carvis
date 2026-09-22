import { SERVICES_BY_DOMAIN } from '../guards.js';

export const str = (description, maxLength = 200) => ({ type: 'string', description, maxLength });

export const COMMAND_PROPERTIES = {
  entity_id: str('Exact Home Assistant entity id'),
  service: {
    type: 'string',
    enum: [...new Set(Object.values(SERVICES_BY_DOMAIN).flat())],
    description: 'Typed HA service. Only services explicitly supported for the entity domain are accepted.',
  },
  rgb_color: { type: 'array', minItems: 3, maxItems: 3, items: {type:'integer',minimum:0,maximum:255}, description:'RGB color [red, green, blue]. Read supported_color_modes first.' },
  color_temp_kelvin: {type:'integer',minimum:1000,maximum:40000,description:'White temperature within the light reported min/max Kelvin range.'},
  brightness_pct: { type: 'integer', minimum: 1, maximum: 100 },
  percentage: { type: 'integer', minimum: 0, maximum: 100 },
  volume_percent: { type: 'integer', minimum: 0, maximum: 100 },
  humidity: { type: 'integer', minimum: 0, maximum: 100 },
  temperature: { type: 'number' },
  value: { type: 'number' },
  source: str('Exact output source from ha.get_state source_list'),
  media_content_id: str('Spotify track, album, playlist, or artist URL/URI. Obtain a real link; never invent IDs.', 500),
  media_content_type: { type: 'string', enum: ['track', 'album', 'playlist', 'artist'] },
  option: str('An exact option exposed by a select entity'),
  effect: str('An exact light effect returned by ha.light.list_effects', 160),
};
