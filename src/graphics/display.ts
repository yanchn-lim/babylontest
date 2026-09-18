import { DefaultRenderingPipeline, ImageProcessingConfiguration, type Camera, type Scene } from '@babylonjs/core';

/** Approved display settings shared by every active viewer. */
export function configureDisplay(scene: Scene) {
  const display = scene.imageProcessingConfiguration;
  display.toneMappingEnabled = true;
  display.toneMappingType = ImageProcessingConfiguration.TONEMAPPING_ACES;
  display.exposure = 1 / .6;
  display.ditheringEnabled = true;
  display.ditheringIntensity = 1 / 255;
  return display;
}

export function createBloom(scene: Scene, camera: Camera) {
  const bloom = new DefaultRenderingPipeline('Shared bloom', true, scene, [camera], false);
  bloom.bloomEnabled = true;
  bloom.bloomWeight = .5; bloom.bloomThreshold = .7;
  bloom.bloomKernel = 32; bloom.bloomScale = .5;
  bloom.samples = 4;
  bloom.prepare();
  return bloom;
}
