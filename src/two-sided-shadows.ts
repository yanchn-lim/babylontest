import type { ShadowGenerator } from "@babylonjs/core";

const configured = new WeakSet<ShadowGenerator>();

export function enableTwoSidedShadows(generator: ShadowGenerator) {
  if (configured.has(generator)) return;
  configured.add(generator);
  const engine = generator.getLight().getScene().getEngine();
  generator.onBeforeShadowMapRenderObservable.add(() => engine.setState(false));
}