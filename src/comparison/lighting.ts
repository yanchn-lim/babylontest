export type SwitchMode = 'auto' | 'on' | 'off';

// Keep this controlled sun path identical to prepare-comparison.py.
export function lighting(hour: number, mode: SwitchMode) {
  const phase = (hour - 6) / 12 * Math.PI;
  const elevation = Math.max(0, Math.sin(phase));
  const raw = [Math.cos(phase) * .8, elevation, -.65];
  const length = Math.hypot(...raw);
  const warm = Math.min(1, elevation * 2);
  return {
    direction: raw.map(v => v / length),
    sun: hour > 6 && hour < 18 ? 3 * Math.min(1, elevation * 4) : 0,
    color: [1, .65 + .3 * warm, .38 + .52 * warm],
    sky: hour >= 6 && hour <= 18 ? .015 + .55 * elevation : .015,
    on: mode === 'on' || (mode === 'auto' && (hour < 7 || hour >= 18)),
  };
}

export function sunInterval(hour: number, hours: number[]) {
  const clamped = Math.max(hours[0], Math.min(hours[hours.length - 1], hour));
  const upper = hours.findIndex(value => value >= clamped);
  const lower = Math.max(0, upper - 1);
  return { lower, upper, blend: lower === upper ? 0 : (clamped - hours[lower]) / (hours[upper] - hours[lower]) };
}
