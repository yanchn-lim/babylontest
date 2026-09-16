import { Color4, HDRFiltering, ReflectionProbe, SphericalPolynomial, Vector3,
  type Mesh, type PBRMaterial, type Scene } from '@babylonjs/core';

export interface ReflectionRoom {
  name: string;
  center: [number, number, number];
  size: [number, number, number];
  materials: PBRMaterial[];
}

/** Static local captures: refresh with lighting, never with the walking camera. */
export class RoomReflections {
  enabled = true;
  error = '';
  private probes: ReflectionProbe[] = [];
  private busy = false;
  private disposed = false;
  private requested = '';
  private completed = '';
  private revision = 0;
  private captures = 0;
  private updateMilliseconds = 0;

  constructor(private scene: Scene, private meshes: Mesh[], private rooms: ReflectionRoom[],
    private materials: PBRMaterial[]) {}

  setEnabled(enabled: boolean) {
    this.enabled = enabled;
    this.rooms.forEach((room, i) => room.materials.forEach(material => {
      material.reflectionTexture = enabled ? this.probes[i]?.cubeTexture ?? null : null;
    }));
  }

  tick(key: string, sky: number[]) {
    this.requested = key;
    if (!this.enabled || this.busy || this.error || !key || key === this.completed || this.disposed) return;
    this.busy = true;
    void this.capture(key, sky).catch(error => {
      if (!this.disposed) { this.error = String(error); console.warn('Room reflections unavailable:', error); }
    }).finally(() => { this.busy = false; });
  }

  private async capture(key: string, sky: number[]) {
    const started = performance.now(), prepared: ReflectionProbe[] = [];
    const current = () => !this.disposed && this.enabled && this.requested === key;
    try {
      for (const room of this.rooms) {
        if (!current()) return;
        const probe = new ReflectionProbe('Reflection · ' + room.name, 128, this.scene, true, true, true);
        prepared.push(probe);
        probe.position.set(...room.center);
        probe.renderList = this.meshes;
        const texture = probe.cubeTexture;
        // Capture manually. A filtered target must never be rendered again.
        texture.isRenderTarget = false;
        probe.refreshRate = 0;
        texture.clearColor = new Color4(sky[0], sky[1], sky[2], 1);
        texture.boundingBoxPosition = new Vector3(...room.center);
        texture.boundingBoxSize = new Vector3(...room.size);
        // Diffuse illumination comes exclusively from the existing GI/lightmap.
        texture.sphericalPolynomial = new SphericalPolynomial();
        const deadline = performance.now() + 15000;
        while (true) {
          await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
          if (!current()) return;
          const intensities = this.materials.map(material => material.environmentIntensity);
          let ready = false;
          try {
            this.materials.forEach(material => { material.environmentIntensity = 0; });
            ready = texture.isReadyForRendering();
            if (ready) { texture.render(false); this.captures++; }
          } finally {
            this.materials.forEach((material, i) => { material.environmentIntensity = intensities[i]; });
          }
          if (ready) break;
          if (performance.now() > deadline) throw Error('Reflection capture shaders did not become ready.');
        }
        // GGX filtering stores the different material roughness levels in mipmaps.
        await new HDRFiltering(this.scene.getEngine(), { quality: 128 }).prefilter(texture);
        // The filtered map uses the static cubemap orientation, including in RH scenes.
        texture.invertZ = false;
        texture.sphericalPolynomial = new SphericalPolynomial();
      }
      if (!current()) return;
      const old = this.probes;
      this.probes = prepared.splice(0);
      this.setEnabled(true);
      old.forEach(probe => probe.dispose());
      this.completed = key; this.revision++;
      this.updateMilliseconds = performance.now() - started;
    } finally { prepared.forEach(probe => probe.dispose()); }
  }

  diagnostics() {
    return { enabled: this.enabled, ready: this.probes.length === this.rooms.length,
      updating: this.busy || (!!this.requested && this.requested !== this.completed && this.enabled),
      revision: this.revision, captures: this.captures, rooms: this.rooms.length, resolution: 128,
      updateMilliseconds: this.updateMilliseconds, error: this.error };
  }

  get status() {
    if (!this.enabled) return 'Reflections off';
    if (this.error) return 'Reflections unavailable';
    return this.busy ? 'Updating reflections' : this.probes.length ? 'Local reflections' : 'Waiting for reflections';
  }

  dispose() {
    this.disposed = true;
    this.setEnabled(false);
    this.probes.forEach(probe => probe.dispose()); this.probes = [];
  }
}
