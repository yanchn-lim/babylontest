import type { Vec3 } from "./controller";
export const LIGHT_SCALE = .01;
export const srgbToLinear = (v: number) => v <= .04045 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4;
export function temperature(k: number): Vec3 {
  const t = Math.min(10000, Math.max(2000, k)) / 100;
  const rgb = [t <= 66 ? 255 : 329.698727446 * (t - 60) ** -.1332047592, t <= 66 ? 99.4708025861 * Math.log(t) - 161.1195681661 : 288.1221695283 * (t - 60) ** -.0755148492, t >= 66 ? 255 : t <= 19 ? 0 : 138.5177312231 * Math.log(t - 10) - 305.0447927307].map(v => srgbToLinear(Math.min(255, Math.max(0, v)) / 255));
  const y = rgb[0] * .2126 + rgb[1] * .7152 + rgb[2] * .0722;
  return rgb.map(v => v / y) as Vec3;
}
/** Clear-sky approximation in the same linear radiance units as the preview lights.
 * The sun disk is excluded: the directional light owns direct sunlight. */
export function skyRadiance(direction: Vec3, sun: Vec3): Vec3 {
  const day = Math.max(0, Math.min(1, (sun[1] + .08) / .25));
  const y = Math.max(0, direction[1]);
  const horizon = (1 - y) ** 3;
  const forward = Math.max(0, direction.reduce((sum, v, i) => sum + v * sun[i], 0)) ** 16;
  const below = direction[1] < 0 ? .08 : 1;
  return [(.12 + .25 * horizon + .2 * forward) * day * below, (.22 + .2 * horizon + .14 * forward) * day * below, (.4 + .1 * horizon + .06 * forward) * day * below];
}
export function fixtureDirection(rotation: Vec3): Vec3 {
  const pitch = rotation[0] * Math.PI / 180, yaw = rotation[1] * Math.PI / 180;
  return [Math.sin(pitch) * Math.sin(yaw), -Math.cos(pitch), Math.sin(pitch) * Math.cos(yaw)];
}
