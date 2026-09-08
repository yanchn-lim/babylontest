import type { DirectionalLight, UniversalCamera, ShadowGenerator, AbstractMesh } from "@babylonjs/core";

export function bindSurfaceShadow(light: DirectionalLight, camera: UniversalCamera, generator: ShadowGenerator) {
  const generators = light.getShadowGenerators();
  if (!generators) throw new Error("Surface shadow generator is unavailable.");
  generators.set(null, generator);
  generators.set(camera, generator);
}

export function trackShadowCasters(meshes: AbstractMesh[], states: Map<AbstractMesh, string>) {
  let changed = false;
  for (const mesh of meshes) {
    const matrix = mesh.computeWorldMatrix();
    const key = [matrix.updateFlag, mesh.isEnabled(), mesh.isVisible, mesh.visibility].join(":");
    if (states.get(mesh) !== key) {
      states.set(mesh, key);
      changed = true;
    }
  }
  return changed;
}
