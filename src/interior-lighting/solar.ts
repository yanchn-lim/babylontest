export interface DaylightState {
  latitude: number;
  longitude: number;
  /** ISO timestamp with an explicit UTC offset. */
  instant: string;
  /** Clockwise angle from scene -Z to geographic north. Null means uncalibrated. */
  northDegrees: number | null;
}
export const singaporeDaylight: DaylightState = {
  latitude: 1.3521, longitude: 103.8198,
  instant: "2026-03-20T12:00:00+08:00", northDegrees: null,
};
const rad = Math.PI / 180;
const wrap = (x: number) => (x % 360 + 360) % 360;
/** NOAA solar geometry. Geometric elevation; refraction is deliberately excluded. */
export function solarPosition(state: DaylightState) {
  const time = Date.parse(state.instant);
  if (!Number.isFinite(time) || !/(Z|[+-]\d\d:\d\d)$/.test(state.instant)) throw new Error("Time needs an explicit UTC offset");
  if (!Number.isFinite(state.latitude) || Math.abs(state.latitude) > 90 || !Number.isFinite(state.longitude) || Math.abs(state.longitude) > 180) throw new Error("Invalid geographic coordinates");
  if (state.northDegrees !== null && !Number.isFinite(state.northDegrees)) throw new Error("Invalid north orientation");
  const t = (time / 86400000 + 2440587.5 - 2451545) / 36525;
  const meanLongitude = wrap(280.46646 + t * (36000.76983 + t * .0003032));
  const anomaly = (357.52911 + t * (35999.05029 - .0001537 * t)) * rad;
  const eccentricity = .016708634 - t * (.000042037 + .0000001267 * t);
  const centre = Math.sin(anomaly) * (1.914602 - t * (.004817 + .000014 * t)) + Math.sin(2 * anomaly) * (.019993 - .000101 * t) + Math.sin(3 * anomaly) * .000289;
  const omega = (125.04 - 1934.136 * t) * rad;
  const apparent = (meanLongitude + centre - .00569 - .00478 * Math.sin(omega)) * rad;
  const obliquity = (23 + (26 + (21.448 - t * (46.815 + t * (.00059 - t * .001813))) / 60) / 60 + .00256 * Math.cos(omega)) * rad;
  const declination = Math.asin(Math.sin(obliquity) * Math.sin(apparent));
  const y = Math.tan(obliquity / 2) ** 2;
  const l = meanLongitude * rad;
  const equationMinutes = 4 / rad * (y * Math.sin(2 * l) - 2 * eccentricity * Math.sin(anomaly) + 4 * eccentricity * y * Math.sin(anomaly) * Math.cos(2 * l) - .5 * y * y * Math.sin(4 * l) - 1.25 * eccentricity ** 2 * Math.sin(2 * anomaly));
  const date = new Date(time);
  const utcMinutes = date.getUTCHours() * 60 + date.getUTCMinutes() + date.getUTCSeconds() / 60;
  const hourAngle = (wrap((utcMinutes + equationMinutes + 4 * state.longitude) / 4) - 180) * rad;
  const latitude = state.latitude * rad;
  const elevation = Math.asin(Math.sin(latitude) * Math.sin(declination) + Math.cos(latitude) * Math.cos(declination) * Math.cos(hourAngle));
  const azimuth = wrap(Math.atan2(Math.sin(hourAngle), Math.cos(hourAngle) * Math.sin(latitude) - Math.tan(declination) * Math.cos(latitude)) / rad + 180);
  const a = (azimuth + (state.northDegrees ?? 0)) * rad;
  return { elevation: elevation / rad, azimuth, toSun: [Math.sin(a) * Math.cos(elevation), Math.sin(elevation), -Math.cos(a) * Math.cos(elevation)] as [number, number, number] };
}
/** Photometric conversion for a uniform cone, with full cone angle in degrees. */
export function candela(lumens: number, beamDegrees?: number) {
  if (!Number.isFinite(lumens) || lumens < 0) throw new Error("Lumens must be finite and nonnegative");
  if (beamDegrees !== undefined && (!Number.isFinite(beamDegrees) || beamDegrees < 1 || beamDegrees > 179)) throw new Error("Beam angle must be between 1 and 179 degrees");
  return lumens / (beamDegrees === undefined ? 4 * Math.PI : 2 * Math.PI * (1 - Math.cos(beamDegrees * rad / 2)));
}
