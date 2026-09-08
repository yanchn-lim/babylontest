import { Vector3 } from "@babylonjs/core";
import type { UniversalCamera } from "@babylonjs/core";

export function attachFlyControls(camera: UniversalCamera, canvas: HTMLCanvasElement) {
  const scene = camera.getScene();
  const abort = new AbortController();
  const options = { signal: abort.signal };
  const stick = document.querySelector<HTMLElement>("#move-stick")!;
  const thumb = document.querySelector<HTMLElement>("#stick-thumb")!;
  const capture = document.querySelector<HTMLButtonElement>("#capture-mouse")!;
  const up = document.querySelector<HTMLButtonElement>("#fly-up")!;
  const down = document.querySelector<HTMLButtonElement>("#fly-down")!;
  const keys = new Set<string>();
  const vertical = new Map<number, number>();
  const movementKeys = new Set(["KeyW", "KeyA", "KeyS", "KeyD", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "KeyQ", "KeyE", "ShiftLeft", "ShiftRight"]);
  let stickPointer: number | undefined;
  let lookPointer: number | undefined;
  let stickX = 0;
  let stickY = 0;
  let lastX = 0;
  let lastY = 0;

  function reset() {
    keys.clear();
    vertical.clear();
    stickPointer = undefined;
    lookPointer = undefined;
    stickX = stickY = 0;
    thumb.style.transform = "";
    up.classList.remove("held");
    down.classList.remove("held");
    camera.cameraDirection.setAll(0);
    camera.cameraRotation.setAll(0);
  }
  function look(dx: number, dy: number) {
    camera.rotation.y += dx * 0.003;
    camera.rotation.x = Math.max(-Math.PI / 2 + 0.02, Math.min(Math.PI / 2 - 0.02, camera.rotation.x + dy * 0.003));
  }
  canvas.addEventListener("keydown", event => {
    if (!movementKeys.has(event.code)) return;
    event.preventDefault();
    keys.add(event.code);
  }, options);
  window.addEventListener("keyup", event => keys.delete(event.code), options);
  window.addEventListener("blur", reset, options);
  document.addEventListener("visibilitychange", reset, options);
  document.addEventListener("focusin", event => {
    if (event.target !== canvas) reset();
  }, options);
  document.addEventListener("pointerlockchange", () => {
    reset();
    capture.textContent = document.pointerLockElement === canvas ? "Release mouse · Esc" : "Capture mouse";
  }, options);
  capture.addEventListener("click", async () => {
    if (document.pointerLockElement === canvas) {
      document.exitPointerLock();
      return;
    }
    canvas.focus();
    try {
      await canvas.requestPointerLock();
    } catch {
      capture.textContent = "Mouse capture unavailable · drag to look";
    }
  }, options);
  document.addEventListener("mousemove", event => {
    if (document.pointerLockElement === canvas) look(event.movementX, event.movementY);
  }, options);
  canvas.addEventListener("pointerdown", event => {
    if (event.button !== 0 || lookPointer !== undefined || document.pointerLockElement === canvas) return;
    event.preventDefault();
    canvas.focus();
    lookPointer = event.pointerId;
    lastX = event.clientX;
    lastY = event.clientY;
    canvas.setPointerCapture(event.pointerId);
  }, options);
  canvas.addEventListener("pointermove", event => {
    if (event.pointerId !== lookPointer || document.pointerLockElement === canvas) return;
    look(event.clientX - lastX, event.clientY - lastY);
    lastX = event.clientX;
    lastY = event.clientY;
  }, options);
  const endLook = (event: PointerEvent) => {
    if (event.pointerId === lookPointer) lookPointer = undefined;
  };
  canvas.addEventListener("pointerup", endLook, options);
  canvas.addEventListener("pointercancel", endLook, options);
  canvas.addEventListener("lostpointercapture", endLook, options);

  function moveStick(event: PointerEvent) {
    const rect = stick.getBoundingClientRect();
    const radius = rect.width * 0.32;
    const x = (event.clientX - rect.left - rect.width / 2) / radius;
    const y = (event.clientY - rect.top - rect.height / 2) / radius;
    const length = Math.max(1, Math.hypot(x, y));
    stickX = x / length;
    stickY = -y / length;
    thumb.style.transform = "translate(" + stickX * radius + "px, " + -stickY * radius + "px)";
  }
  stick.addEventListener("pointerdown", event => {
    if (stickPointer !== undefined) return;
    event.preventDefault();
    canvas.focus();
    stickPointer = event.pointerId;
    stick.setPointerCapture(event.pointerId);
    moveStick(event);
  }, options);
  stick.addEventListener("pointermove", event => {
    if (event.pointerId === stickPointer) moveStick(event);
  }, options);
  const endStick = (event: PointerEvent) => {
    if (event.pointerId !== stickPointer) return;
    stickPointer = undefined;
    stickX = stickY = 0;
    thumb.style.transform = "";
  };
  stick.addEventListener("pointerup", endStick, options);
  stick.addEventListener("pointercancel", endStick, options);
  stick.addEventListener("lostpointercapture", endStick, options);

  for (const [button, direction] of [[up, 1], [down, -1]] as const) {
    button.addEventListener("pointerdown", event => {
      event.preventDefault();
      canvas.focus();
      vertical.set(event.pointerId, direction);
      button.classList.add("held");
      button.setPointerCapture(event.pointerId);
    }, options);
    const release = (event: PointerEvent) => {
      vertical.delete(event.pointerId);
      if (![...vertical.values()].includes(direction)) button.classList.remove("held");
    };
    button.addEventListener("pointerup", release, options);
    button.addEventListener("pointercancel", release, options);
    button.addEventListener("lostpointercapture", release, options);
  }

  const pressed = (...codes: string[]) => Number(codes.some(code => keys.has(code)));
  const observer = scene.onBeforeRenderObservable.add(() => {
    const x = stickX + pressed("KeyD", "ArrowRight") - pressed("KeyA", "ArrowLeft");
    const z = stickY + pressed("KeyW", "ArrowUp") - pressed("KeyS", "ArrowDown");
    const y = pressed("KeyE") - pressed("KeyQ") + Number([...vertical.values()].includes(1)) - Number([...vertical.values()].includes(-1));
    const direction = camera.getDirection(Vector3.Forward()).scale(z)
      .add(camera.getDirection(Vector3.Right()).scale(x)).add(new Vector3(0, y, 0));
    const length = direction.length();
    if (length > 1) direction.scaleInPlace(1 / length);
    const speed = pressed("ShiftLeft", "ShiftRight") ? 9 : 3;
    const seconds = Math.min(scene.getEngine().getDeltaTime(), 50) / 1000;
    camera.position.addInPlace(direction.scale(speed * seconds));
  });
  scene.onDisposeObservable.add(() => {
    abort.abort();
    reset();
    scene.onBeforeRenderObservable.remove(observer);
    if (document.pointerLockElement === canvas) document.exitPointerLock();
  });
  return reset;
}
