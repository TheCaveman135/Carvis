export const WHITE_TEMPERATURE_DESCRIPTION =
  'White tone in Kelvin. Use this for warm, neutral, or cool white, including lights with only HS/XY/RGB color control: Home Assistant automatically approximates the tone. Native white-temperature lights must stay within their reported Kelvin limits. Do not skip color lights just because color_temp is absent. Describe the result in plain language; color-only lights approximate the tone, not an exact calibrated temperature.';

export const APPROXIMATE_WHITE_NOTE =
  'This light uses its color controls to approximate the requested white tone.';

// Home Assistant light.turn_on converts Kelvin to the supported color mode,
// including RGBWW and device-gamut handling. Keep that conversion in HA.
// https://github.com/home-assistant/core/blob/dev/homeassistant/components/light/__init__.py
export function whiteTemperatureDetails(kelvin, attributes = {}) {
  const modes = Array.isArray(attributes.supported_color_modes)
    ? attributes.supported_color_modes : [];
  if (!Number.isInteger(kelvin) || kelvin < 1000 || kelvin > 40000)
    throw Error('White temperature must be a whole number between 1000 and 40000 K.');
  if (modes.includes('color_temp')) {
    const min = attributes.min_color_temp_kelvin;
    const max = attributes.max_color_temp_kelvin;
    if (!Number.isFinite(min) || !Number.isFinite(max))
      throw Error('This light has not reported its supported white-temperature range.');
    if (kelvin < min || kelvin > max)
      throw Error(`White temperature must be within the reported range ${min}–${max} K.`);
    return {};
  }
  if (!modes.some(mode => ['hs', 'xy', 'rgb', 'rgbw', 'rgbww'].includes(mode)))
    throw Error('This light cannot change its white tone or color.');
  return { approximate: true, note: APPROXIMATE_WHITE_NOTE };
}
