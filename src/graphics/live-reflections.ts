import { PBRMaterial, Vector3, type Mesh, type Scene } from '@babylonjs/core';
import { RoomReflections, type ReflectionRoom } from '../comparison/reflections';
import { ApartmentReflectionBlend } from '../apartment/reflection-blend';

export interface ReflectionRegion {
  name: string;
  center: [number, number, number];
  size: [number, number, number];
  bounds?: number[];
}

/** Keep editable geometry and its lighting UVs intact; give receivers independent probe bindings. */
export class LiveReflections {
  private captures?: RoomReflections;
  private materials = new Map<Mesh, PBRMaterial>();
  private hall = 0;
  constructor(private scene: Scene) {}

  reset(meshes: Mesh[], layout?: ReflectionRegion[]) {
    this.captures?.dispose(); this.captures = undefined;
    if (!meshes.length) return;
    const minimum = new Vector3(Infinity, Infinity, Infinity), maximum = minimum.negate();
    meshes.forEach(mesh => {
      mesh.computeWorldMatrix(true);
      const box = mesh.getBoundingInfo().boundingBox;
      minimum.minimizeInPlace(box.minimumWorld); maximum.maximizeInPlace(box.maximumWorld);
    });
    const fallback: ReflectionRegion = { name: 'Scene', center: minimum.add(maximum).scale(.5).asArray() as [number, number, number],
      size: maximum.subtract(minimum).maximizeInPlaceFromFloats(.01, .01, .01).asArray() as [number, number, number] };
    const regions = layout?.length ? layout : [fallback];
    const rooms: ReflectionRoom[] = regions.map(region => ({ ...region, materials: [] }));
    this.hall = rooms.length - 1;
    for (const mesh of meshes) {
      if (!(mesh.material instanceof PBRMaterial)) continue;
      let material = this.materials.get(mesh);
      if (!material) {
        material = mesh.material.clone(mesh.material.name + ' · ' + mesh.uniqueId)!;
        this.materials.set(mesh, material); mesh.material = material;
        new ApartmentReflectionBlend(material, [], () => this.captures?.texture(this.hall) ?? null);
      }
      const box = mesh.getBoundingInfo().boundingBox;
      // A receiver spanning rooms uses the shared capture; no mesh cuts or atlas changes.
      const index = regions.findIndex(region => region.bounds && box.minimumWorld.x >= region.bounds[0] && box.maximumWorld.x <= region.bounds[1]
        && box.minimumWorld.z >= region.bounds[2] && box.maximumWorld.z <= region.bounds[3]);
      const selected = index < 0 ? this.hall : index;
      rooms[selected].materials.push(material);
      (material.pluginManager!.getPlugin('ApartmentReflectionBlend') as ApartmentReflectionBlend).setBounds(regions[selected].bounds ?? []);
    }
    const materials = [...new Set(rooms.flatMap(room => room.materials))];
    this.captures = new RoomReflections(this.scene, meshes, rooms, materials);
  }
  tick(key: string, sky: number[]) { this.captures?.tick(key, sky); }
  diagnostics() { return this.captures?.diagnostics(); }
  dispose() { this.captures?.dispose(); this.materials.forEach(material => material.dispose(false, false)); this.materials.clear(); }
}
