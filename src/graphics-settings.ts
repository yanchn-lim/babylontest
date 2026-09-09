export const balancedLighting: Record<string, string> = {
  "sun-intensity": "3", "environment-intensity": "0.65", "environment-diffuse": "0.65",
  "baked-intensity": "1", "ao-strength": "1", exposure: "1.9", contrast: "1",
};

export const graphicsDefaults: Record<string, string | boolean> = {
  ...balancedLighting,
  shadows: "1024", "shadow-method": "pcf", "shadow-filter": "low", "shadow-softness": "0.005",
  "sun-azimuth": "35", "sun-elevation": "58.6", shafts: true, "shaft-strength": "0.1",
  scale: "1", "bloom-enabled": true, "bloom-strength": "0.12", fxaa: true,
  "bloom-threshold": "1", "bloom-radius": "32", "shaft-scattering": "0.05",
};
const storageKey = "babylon-graphics-v1";
type Control = HTMLInputElement | HTMLSelectElement;

export function validPreference(control: Control, value: unknown): boolean {
  if (control.type === "checkbox") return typeof value === "boolean";
  if (typeof value !== "string") return false;
  if (control.tagName === "SELECT") return Array.from((control as HTMLSelectElement).options).some(option => option.value === value);
  const input = control as HTMLInputElement;
  const number = Number(value);
  return value.trim() !== "" && Number.isFinite(number) && number >= Number(input.min) && number <= Number(input.max);
}

export function attachGraphicsPreferences() {
  const controls = Object.keys(graphicsDefaults).map(id => document.getElementById(id) as Control);
  const snapshot = () => Object.fromEntries(controls.map(control =>
    [control.id, control.type === "checkbox" ? (control as HTMLInputElement).checked : control.value]));
  function apply(values: Record<string, unknown>, notify: boolean) {
    for (const control of controls) {
      const value = validPreference(control, values[control.id]) ? values[control.id] : graphicsDefaults[control.id];
      const previous = control.type === "checkbox" ? (control as HTMLInputElement).checked : control.value;
      if (control.type === "checkbox") (control as HTMLInputElement).checked = value as boolean;
      else control.value = value as string;
      if (notify && previous !== value) {
        control.dispatchEvent(new Event("input", { bubbles: true }));
        control.dispatchEvent(new Event("change", { bubbles: true }));
      }
    }
  }
  let saved: Record<string, unknown> = {};
  try { saved = JSON.parse(localStorage.getItem(storageKey) || "{}") || {}; } catch { /* Storage is optional. */ }
  apply(saved, false);
  const save = () => { try { localStorage.setItem(storageKey, JSON.stringify(snapshot())); } catch { /* Storage is optional. */ } };
  for (const control of controls) control.addEventListener("change", save);
  return {
    snapshot,
    reset() { apply(graphicsDefaults, true); save(); },
    balanceLighting() { apply({ ...snapshot(), ...balancedLighting }, true); save(); },
    dispose() { for (const control of controls) control.removeEventListener("change", save); },
  };
}
