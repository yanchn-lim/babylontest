import { Vector3, type UniversalCamera } from '@babylonjs/core';

export function navigation(camera: UniversalCamera, canvas: HTMLCanvasElement, moved: () => void) {
  const abort = new AbortController();
  const options = { signal: abort.signal };
  const keys = new Set<string>();
  const stick = document.querySelector<HTMLElement>('#move-stick')!;
  const thumb = document.querySelector<HTMLElement>('#stick-thumb')!;
  let look: { id: number; x: number; y: number } | undefined;
  let stickId: number | undefined;
  let x = 0, z = 0;
  const reset = () => { keys.clear(); look = undefined; stickId = undefined; x = z = 0; thumb.style.transform = ''; };
  canvas.addEventListener('keydown', event => {
    if (!['KeyW', 'KeyA', 'KeyS', 'KeyD', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(event.code)) return;
    event.preventDefault(); keys.add(event.code);
  }, options);
  window.addEventListener('keyup', event => keys.delete(event.code), options);
  window.addEventListener('blur', reset, options);
  document.addEventListener('visibilitychange', reset, options);
  document.addEventListener('focusin', event => { if (event.target !== canvas) keys.clear(); }, options);
  canvas.addEventListener('pointerdown', event => {
    if (event.button !== 0 || look) return;
    canvas.focus(); canvas.setPointerCapture(event.pointerId);
    look = { id: event.pointerId, x: event.clientX, y: event.clientY };
  }, options);
  canvas.addEventListener('pointermove', event => {
    if (look?.id !== event.pointerId) return;
    camera.rotation.y -= (event.clientX - look.x) * .003;
    camera.rotation.x = Math.max(-1.45, Math.min(1.45, camera.rotation.x - (event.clientY - look.y) * .003));
    look.x = event.clientX; look.y = event.clientY; moved();
  }, options);
  const moveStick = (event: PointerEvent) => {
    const box = stick.getBoundingClientRect();
    const dx = (event.clientX - box.left - box.width / 2) / 28;
    const dz = -(event.clientY - box.top - box.height / 2) / 28;
    const length = Math.max(1, Math.hypot(dx, dz));
    x = dx / length; z = dz / length;
    thumb.style.transform = `translate(${x * 28}px, ${-z * 28}px)`;
  };
  stick.addEventListener('pointerdown', event => {
    if (stickId !== undefined) return;
    event.preventDefault(); canvas.focus(); stickId = event.pointerId;
    stick.setPointerCapture(event.pointerId); moveStick(event);
  }, options);
  stick.addEventListener('pointermove', event => { if (event.pointerId === stickId) moveStick(event); }, options);
  for (const name of ['pointerup', 'pointercancel', 'lostpointercapture'] as const) {
    canvas.addEventListener(name, event => { if (event.pointerId === look?.id) look = undefined; }, options);
    stick.addEventListener(name, event => { if (event.pointerId === stickId) { stickId = undefined; x = z = 0; thumb.style.transform = ''; } }, options);
  }
  const pressed = (...codes: string[]) => Number(codes.some(code => keys.has(code)));
  const observer = camera.getScene().onBeforeRenderObservable.add(() => {
    const forward = camera.getDirection(new Vector3(0, 0, -1));
    const right = camera.getDirection(Vector3.Right());
    forward.y = right.y = 0; forward.normalize(); right.normalize();
    const delta = forward.scale(z + pressed('KeyW', 'ArrowUp') - pressed('KeyS', 'ArrowDown'))
      .add(right.scale(x + pressed('KeyD', 'ArrowRight') - pressed('KeyA', 'ArrowLeft')));
    if (!delta.lengthSquared()) return;
    if (delta.lengthSquared() > 1) delta.normalize();
    camera.cameraDirection.copyFrom(delta.scale(1.6 * Math.min(50, camera.getEngine().getDeltaTime()) / 1000));
    moved();
  });
  camera.getScene().onDisposeObservable.add(() => { abort.abort(); camera.getScene().onBeforeRenderObservable.remove(observer); });
}
