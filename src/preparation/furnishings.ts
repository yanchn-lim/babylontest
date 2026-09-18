import { Mesh, PBRMaterial, TransformNode, Vector3, type AssetContainer, type Scene } from '@babylonjs/core';
import { LoadAssetContainerAsync } from '@babylonjs/core/Loading/sceneLoader.js';
import '@babylonjs/loaders/glTF/index.js';

export const layoutLabels = { single: 'One detailed sofa', two: 'Two detailed sofas', three: 'Three detailed sofas', furnished: 'IKEA furnished · 19 pieces' };
export type Layout = keyof typeof layoutLabels;

// Article, centre X/Z in metres, rotation in radians. Repeated items share source geometry.
export const furniturePlacements: [string, number, number, number][] = [
  ['80352951',10.1,-5.8,0], ['80365717',7.4,-4.2,0],
  ['10457230',6.4,-4.2,-Math.PI/2], ['10457230',8.4,-4.2,Math.PI/2],
  ['10457230',7.4,-4.95,0], ['10457230',7.4,-3.45,Math.PI],
  ...[1.4,4.4,7.2].flatMap((x): [string,number,number,number][] => [
    ['70571242',x,-7.4,0], ['10354642',x+.95,-8,0], ['10437237',x,-5.85,0],
  ]),
  ['79184893',12,-6.1,Math.PI/2], ['00483263',6.2,-1.7,Math.PI/2], ['19284999',11.4,-2.4,0],
];

interface Product { article: string; name: string; width: number; depth: number; height: number; triangles: number }

/** Original low-triangle IKEA GLBs from Interior's qualified catalogue. No generated stand-ins. */
export async function createFurnishings(scene: Scene, base: string, preparation: boolean) {
  const response = await fetch(new URL('preparation/ikea/manifest.json', base));
  if (!response.ok) throw Error('Could not load the IKEA benchmark manifest.');
  const { products } = await response.json() as { products: Product[] };
  const containers: AssetContainer[] = [], roots: TransformNode[] = [], meshes: Mesh[] = [];
  scene.onDisposeObservable.add(() => containers.forEach(container => container.dispose()));
  const eligible = (mesh: unknown): mesh is Mesh => mesh instanceof Mesh && mesh.getTotalVertices() > 0 && mesh.material instanceof PBRMaterial;
  const options = preparation ? { pluginOptions: { gltf: { useSRGBBuffers: false } } } : {};
  const assets = new Map<string, { container: AssetContainer; min: Vector3; size: Vector3; dimensions: Vector3; name: string }>();
  for (const article of new Set(furniturePlacements.map(item => item[0]))) {
    const product = products.find(product => product.article === article);
    if (!product || product.triangles > 3000) throw Error('IKEA benchmark product exceeds its 3,000-triangle budget: ' + article);
    const container = await LoadAssetContainerAsync(new URL(`preparation/ikea/${article}.glb`, base).href, scene, options);
    containers.push(container);
    const solids = container.meshes.filter(eligible);
    const triangles = solids.reduce((sum, mesh) => sum + mesh.getTotalIndices() / 3, 0);
    if (!solids.length || triangles !== product.triangles) throw Error('IKEA benchmark geometry does not match its manifest: ' + article);
    let min = new Vector3(Infinity,Infinity,Infinity), max = new Vector3(-Infinity,-Infinity,-Infinity);
    for (const mesh of solids) {
      mesh.computeWorldMatrix(true); const bounds = mesh.getBoundingInfo().boundingBox;
      min = Vector3.Minimize(min,bounds.minimumWorld); max = Vector3.Maximize(max,bounds.maximumWorld);
    }
    const size = max.subtract(min);
    if (size.asArray().some(value => !Number.isFinite(value) || value <= 0)) throw Error('Invalid IKEA model dimensions: ' + article);
    let { width, depth, height } = product;
    // Match the editor's retail-dimension axis alignment before scaling.
    const error = (w: number, d: number) => Math.abs(Math.log(w / size.x)) + Math.abs(Math.log(d / size.z));
    if (width && depth) { if (error(depth,width) + .05 < error(width,depth)) [width,depth] = [depth,width]; }
    else { width = size.x; depth = size.z; }
    assets.set(article,{ container,min,size,dimensions:new Vector3(width, height || size.y, depth),name:product.name });
  }
  for (const [index, [article,x,z,angle]] of furniturePlacements.entries()) {
    const asset = assets.get(article)!;
    const instance = asset.container.instantiateModelsToScene(name => `IKEA ${index} ${name}`, false, { doNotInstantiate:true });
    const root = new TransformNode(`${asset.name} ${article} instance ${index}`,scene);
    const normalization = new TransformNode(root.name + ' dimensions',scene); normalization.parent = root;
    normalization.scaling.copyFrom(asset.dimensions.divide(asset.size));
    normalization.position.copyFrom(asset.min.add(asset.size.multiplyByFloats(.5,0,.5)).multiply(normalization.scaling).negate());
    for (const node of instance.rootNodes) node.parent = normalization;
    root.position.set(x,0,z); root.rotation.y = angle; root.setEnabled(false);
    roots.push(root); meshes.push(...root.getChildMeshes().filter(eligible));
  }
  return { roots,meshes };
}
