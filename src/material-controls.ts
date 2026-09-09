import { PBRMaterial, type AbstractMesh } from "@babylonjs/core";

export function attachMaterialControls(meshes: AbstractMesh[], sceneKey: string) {
  const materials = [...new Set(meshes.map(mesh => mesh.material))]
    .filter((material): material is PBRMaterial => material instanceof PBRMaterial);
  const select = document.querySelector<HTMLSelectElement>("#material-select")!;
  const fields = ["roughness", "normal", "reflection", "metallic"] as const;
  type Values = Record<typeof fields[number], number>;
  const inputs = Object.fromEntries(fields.map(field => [field,
    document.querySelector<HTMLInputElement>("#material-" + field)!])) as Record<typeof fields[number], HTMLInputElement>;
  const originals = materials.map(material => ({ roughness: material.roughness ?? 1,
    normal: material.bumpTexture?.level ?? 1, reflection: material.environmentIntensity,
    metallic: material.metallic ?? 0 }));
  const defaults = (index: number): Values => ({ roughness: 1, normal: 1, reflection: 1, metallic: originals[index].metallic });
  const key = "babylon-materials-v1-" + sceneKey;
  let saved: Record<string, Partial<Values>> = {};
  try { saved = JSON.parse(localStorage.getItem(key) || "{}") || {}; } catch { /* Storage is optional. */ }
  const values = materials.map((material, index) => {
    const value = defaults(index);
    for (const field of fields) {
      const candidate = saved[index + ":" + material.name]?.[field];
      if (typeof candidate === "number" && Number.isFinite(candidate)
        && candidate >= Number(inputs[field].min) && candidate <= Number(inputs[field].max)) value[field] = candidate;
    }
    return value;
  });
  const snapshot = () => Object.fromEntries(materials.map((material, index) => [index + ":" + material.name, { ...values[index] }]));
  const save = () => { try { localStorage.setItem(key, JSON.stringify(snapshot())); } catch { /* Storage is optional. */ } };
  function apply(index: number) {
    const material = materials[index], original = originals[index], value = values[index];
    material.roughness = Math.min(1, original.roughness * value.roughness);
    material.environmentIntensity = original.reflection * value.reflection;
    material.metallic = value.metallic;
    if (material.bumpTexture) material.bumpTexture.level = original.normal * value.normal;
  }
  function show() {
    const index = Number(select.value), material = materials[index];
    if (!material) return;
    for (const field of fields) {
      inputs[field].value = String(values[index][field]);
      document.querySelector<HTMLOutputElement>("#material-" + field + "-value")!.value = values[index][field].toFixed(2);
    }
    inputs.normal.disabled = !material.bumpTexture;
    const count = meshes.filter(mesh => mesh.material === material).length;
    document.querySelector("#material-description")!.textContent = `${count} surface${count === 1 ? "" : "s"} · ${material.bumpTexture ? "Normal map available" : "No normal map"}`;
  }
  materials.forEach((material, index) => {
    select.add(new Option(material.name || "Material " + (index + 1), String(index)));
    // Isolate per-material normal strength when source textures are shared.
    if (material.bumpTexture) material.bumpTexture = material.bumpTexture.clone();
    apply(index);
  });
  select.addEventListener("change", show);
  for (const field of fields) inputs[field].addEventListener("input", () => {
    const index = Number(select.value);
    values[index][field] = Number(inputs[field].value);
    apply(index); show();
  });
  for (const input of Object.values(inputs)) input.addEventListener("change", save);
  document.querySelector("#reset-material")!.addEventListener("click", () => {
    const index = Number(select.value);
    values[index] = defaults(index); apply(index); show(); save();
    inputs.roughness.dispatchEvent(new Event("change", { bubbles: true }));
  });
  show();
  return { snapshot, reset() {
    materials.forEach((_, index) => { values[index] = defaults(index); apply(index); });
    show(); save();
    inputs.roughness.dispatchEvent(new Event("change", { bubbles: true }));
  } };
}
