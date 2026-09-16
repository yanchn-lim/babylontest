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

export function skyDisplay(rgb: [number, number, number]): [number, number, number] {
  const [r, g, b] = rgb.map(value => value / .6);
  const input = [.59719 * r + .35458 * g + .04823 * b, .076 * r + .90834 * g + .01566 * b, .0284 * r + .13383 * g + .83777 * b];
  const [x, y, z] = input.map(v => (v * (v + .0245786) - .000090537) / (v * (.983729 * v + .432951) + .238081));
  return [1.60475 * x - .53108 * y - .07367 * z, -.10208 * x + 1.10813 * y - .00605 * z, -.00327 * x - .07276 * y + 1.07602 * z]
    .map(v => { const value = Math.min(1, Math.max(0, v)); return value <= .0031308 ? value * 12.92 : 1.055 * value ** (1 / 2.4) - .055; }) as [number, number, number];
}
