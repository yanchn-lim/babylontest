import { Vector3, type UniversalCamera } from "@babylonjs/core";

export const WALK_ROUTE = { id: "turning-walk-v1", speed: 0.8, turnRate: Math.PI / 15 };

export function createWalkingRoute(camera: UniversalCamera) {
  const displacement = new Vector3();
  return (seconds: number) => {
    if (!(seconds > 0) || !Number.isFinite(seconds)) return;
    const from = camera.rotation.y;
    const to = from + WALK_ROUTE.turnRate * seconds;
    const radius = WALK_ROUTE.speed / WALK_ROUTE.turnRate;
    displacement.set(radius * (Math.cos(from) - Math.cos(to)), 0,
      radius * (Math.sin(to) - Math.sin(from)));
    camera.rotation.y = to;
    camera.cameraDirection.copyFrom(displacement);
  };
}
