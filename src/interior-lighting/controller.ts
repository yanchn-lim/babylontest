import { solarPosition, singaporeDaylight, candela, type DaylightState } from "./solar";
export type Vec3 = [number, number, number];
export interface Fixture {
  id: string; kind: "spot" | "point"; position: Vec3; rotation: Vec3;
  enabled: boolean; lumens: number; kelvin: number; beamDegrees: number;
}
export interface Bounds { min: Vec3; max: Vec3 }
export interface LightingChanges {
  geometry: number; material: number; lighting: number;
  regions: Bounds[]; reset: boolean;
}
export class LightingController {
  private daylightValue = { ...singaporeDaylight };
  private fixtureValues = new Map<string, Fixture>();
  private pending = false;
  private regions = new Map<string, Bounds>();
  private resetPending = false;
  private revisions = { geometry: 0, material: 0, lighting: 0 };
  private exposureValue = 1;
  private qualityValue = { spacing: .75, probes: 512, rays: 64, updates: 128 };
  status = { phase: "preparing" as "preparing" | "refining" | "settled" | "error", preparationProgress: 0, inactiveProbes: 0, converged: false, progress: 0, gpuMs: null as number | null, error: "" };
  get daylight() { return { ...this.daylightValue }; }
  get exposure() { return this.exposureValue; }
  get quality() { return { ...this.qualityValue }; }
  get fixtures() { return [...this.fixtureValues.values()].map(f => ({ ...f, position: [...f.position] as Vec3, rotation: [...f.rotation] as Vec3 })); }
  setDaylight(value: DaylightState) {
    solarPosition(value);
    this.daylightValue = { ...value };
    this.invalidate("lighting");
  }
  setExposure(value: number) {
    if (!Number.isFinite(value) || value <= 0) throw new Error("Exposure must be positive");
    this.exposureValue = value;
  }
  addFixture(fixture: Fixture) {
    if (this.fixtureValues.has(fixture.id)) throw new Error("Fixture ID already exists");
    this.validateFixture(fixture);
    this.fixtureValues.set(fixture.id, structuredClone(fixture));
    this.invalidate("lighting");
  }
  updateFixture(id: string, patch: Partial<Omit<Fixture, "id" | "kind">>) {
    const original = this.fixtureValues.get(id);
    if (!original) throw new Error("Unknown fixture");
    const next = { ...original, ...patch };
    this.validateFixture(next);
    this.fixtureValues.set(id, structuredClone(next));
    this.invalidate("lighting");
  }
  removeFixture(id: string) {
    if (this.fixtureValues.delete(id)) this.invalidate("lighting");
  }
  notifyFurnitureTransform(id: string, previous: Bounds, next: Bounds) {
    this.addRegion(id, previous); this.addRegion(id, next);
    this.invalidate("geometry", false);
  }
  notifyMaterialChange(id: string, bounds: Bounds) {
    this.addRegion(id, bounds);
    this.invalidate("material", false);
  }
  setQuality(value: Partial<typeof this.qualityValue>) {
    const next = { ...this.qualityValue, ...value };
    if (!Number.isFinite(next.spacing) || next.spacing < .25 || ![next.probes, next.rays, next.updates].every(Number.isInteger) || next.probes < 1 || next.probes > 512 || next.rays < 1 || next.rays > 64 || next.updates < 1 || next.updates > 128) throw new Error("Quality exceeds prototype budget");
    if (next.spacing !== this.qualityValue.spacing || next.probes !== this.qualityValue.probes || next.rays !== this.qualityValue.rays) throw new Error("Probe layout and ray count are fixed in this prototype");
    this.qualityValue = next;
    this.reset();
  }
  reset() { this.invalidate("lighting"); }
  consumeChanges(): LightingChanges | null {
    if (!this.pending) return null;
    const changes = { ...this.revisions, regions: [...this.regions.values()], reset: this.resetPending };
    this.pending = false; this.resetPending = false; this.regions.clear();
    return changes;
  }
  private validateFixture(f: Fixture) {
    if (!f.id || !["spot", "point"].includes(f.kind) || typeof f.enabled !== "boolean" || ![...f.position, ...f.rotation].every(Number.isFinite) || f.position.length !== 3 || f.rotation.length !== 3 || !Number.isFinite(f.kelvin) || f.kelvin < 2000 || f.kelvin > 10000) throw new Error("Invalid fixture");
    candela(f.lumens, f.kind === "spot" ? f.beamDegrees : undefined);
    const enabled = [...this.fixtureValues.values()].filter(x => x.id !== f.id && x.enabled).length;
    if (f.enabled && enabled >= 8) throw new Error("Prototype supports eight enabled fixtures");
  }
  private invalidate(kind: keyof typeof this.revisions, full = true) {
    this.revisions[kind]++; this.pending = true; this.resetPending ||= full;
    this.status.converged = false; this.status.progress = 0;
  }
  private addRegion(id: string, bounds: Bounds) {
    if (![...bounds.min, ...bounds.max].every(Number.isFinite) || bounds.min.some((v, i) => v > bounds.max[i])) throw new Error("Invalid bounds");
    const prior = this.regions.get(id);
    this.regions.set(id, { min: bounds.min.map((v, i) => Math.min(v, prior?.min[i] ?? v)) as Vec3, max: bounds.max.map((v, i) => Math.max(v, prior?.max[i] ?? v)) as Vec3 });
  }
}
