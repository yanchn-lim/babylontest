const smooth = (low: number, high: number, value: number) => {
  const t = Math.max(0, Math.min(1, (value - low) / (high - low)));
  return t * t * (3 - 2 * t);
};

// A continuous, tilted orbit with sunrise at 06:00 and sunset at 18:00.
export function daylightAt(hour: number) {
  const angle = (hour - 6) * Math.PI / 12;
  const tilt = 65 * Math.PI / 180;
  const x = Math.cos(angle), y = Math.sin(angle) * Math.sin(tilt), z = Math.sin(angle) * Math.cos(tilt);
  const elevation = Math.asin(y) * 180 / Math.PI;
  const daylight = smooth(-6, 15, elevation);
  return {
    azimuth: (Math.atan2(z, x) * 180 / Math.PI + 360) % 360,
    elevation,
    sun: smooth(0, 12, elevation),
    ambient: 0.015 + 0.985 * daylight,
    sky: 0.06 + 0.94 * smooth(-12, 5, elevation),
    warmth: 1 - smooth(0, 30, elevation),
  };
}

export function advanceDay(hour: number, seconds: number, minutesPerDay: number) {
  return ((hour + Math.max(0, seconds) * 24 / (minutesPerDay * 60)) % 24 + 24) % 24;
}

export function attachDayNight() {
  const enabled = document.querySelector<HTMLInputElement>("#day-cycle")!;
  const time = document.querySelector<HTMLInputElement>("#day-time")!;
  const speed = document.querySelector<HTMLInputElement>("#day-length")!;
  const play = document.querySelector<HTMLButtonElement>("#day-play")!;
  const abort = new AbortController(), options = { signal: abort.signal };
  let playing = false, previous: number | undefined, elapsed = 0;
  function show() {
    const minutes = Math.floor(Number(time.value) * 60) % 1440;
    document.querySelector<HTMLOutputElement>("#day-time-value")!.value =
      String(Math.floor(minutes / 60)).padStart(2, "0") + ":" + String(minutes % 60).padStart(2, "0");
    document.querySelector<HTMLOutputElement>("#day-length-value")!.value = speed.value + " min";
    play.textContent = playing ? "Pause cycle" : "Play cycle";
    play.setAttribute("aria-pressed", String(playing));
    for (const id of ["sun-azimuth", "sun-elevation", "sun-warmth"]) {
      document.querySelector<HTMLInputElement>("#" + id)!.disabled = enabled.checked;
    }
    time.disabled = !enabled.checked;
    const state = daylightAt(Number(time.value));
    document.querySelector("#day-phase")!.textContent = !enabled.checked ? "Manual sun direction"
      : (state.elevation < -6 ? "Night" : state.elevation < 6 ? "Twilight" : "Daylight")
        + " · " + (playing ? "Playing" : "Paused") + " · sun " + state.elevation.toFixed(1) + "°";
  }
  enabled.addEventListener("change", () => { if (!enabled.checked) playing = false; elapsed = 0; show(); }, options);
  time.addEventListener("input", show, options);
  speed.addEventListener("input", show, options);
  play.addEventListener("click", () => {
    if (!enabled.checked) { enabled.checked = true; enabled.dispatchEvent(new Event("change", { bubbles: true })); }
    playing = !playing; elapsed = 0; previous = undefined; show();
    time.dispatchEvent(new Event("change", { bubbles: true }));
  }, options);
  for (const button of Array.from(document.querySelectorAll<HTMLButtonElement>("[data-hour]"))) {
    button.addEventListener("click", () => {
      playing = false; elapsed = 0; enabled.checked = true;
      time.value = button.dataset.hour!;
      enabled.dispatchEvent(new Event("change", { bubbles: true }));
      time.dispatchEvent(new Event("input", { bubbles: true }));
      time.dispatchEvent(new Event("change", { bubbles: true }));
      show();
    }, options);
  }
  document.addEventListener("visibilitychange", () => { previous = undefined; elapsed = 0; }, options);
  window.addEventListener("pagehide", () => time.dispatchEvent(new Event("change", { bubbles: true })), options);
  show();
  return {
    get playing() { return playing; },
    sample: () => enabled.checked ? daylightAt(Number(time.value)) : null,
    tick(now: number, paused: boolean) {
      const delta = previous === undefined ? 0 : Math.min(0.25, Math.max(0, (now - previous) / 1000));
      previous = now;
      if (!playing || !enabled.checked || paused || document.hidden) { elapsed = 0; return; }
      elapsed += delta;
      if (elapsed < 0.1) return;
      time.value = advanceDay(Number(time.value), elapsed, Number(speed.value)).toFixed(3);
      elapsed = 0;
      time.dispatchEvent(new Event("input", { bubbles: true }));
    },
    dispose() { abort.abort(); },
  };
}
