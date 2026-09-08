import {
  EffectWrapper, FrameGraphImageProcessingTask, FrameGraphRenderPass,
  type FrameGraph, type FrameGraphBloomTask,
} from "@babylonjs/core";

export function addBloomToImageProcessing(shaderType: string, code: string) {
  if (shaderType !== "fragment") return code;
  const sample = "vec4 result=texture2D(textureSampler,vUV);";
  const declarations = "#define CUSTOM_FRAGMENT_DEFINITIONS";
  if (!code.includes(sample) || !code.includes(declarations)) {
    throw new Error("Babylon image-processing shader changed; bloom fusion needs review.");
  }
  return code.replace(declarations, "uniform sampler2D bloomBlur; uniform float bloomWeight;")
    .replace(sample, sample + "if(bloomWeight>0.){result.rgb+=texture2D(bloomBlur,vUV).rgb*bloomWeight;}");
}

// Retain Babylon's bloom extraction/blur and ACES processing, but combine their final passes.
export class BloomToneMappingTask extends FrameGraphImageProcessingTask {
  private readonly bloomTask: FrameGraphBloomTask;

  constructor(name: string, graph: FrameGraph, bloom: FrameGraphBloomTask) {
    EffectWrapper.RegisterShaderCodeProcessing(name, {
      processCodeAfterIncludes: (_name, shaderType, code) => addBloomToImageProcessing(shaderType, code),
      defineCustomBindings: (_name, defines, uniforms, samplers) => {
        uniforms.push("bloomWeight");
        samplers.push("bloomBlur");
        return defines;
      },
    });
    super(name, graph);
    this.bloomTask = bloom;
  }

  record() {
    const bloom = this.bloomTask;
    const blur = bloom.passes.find(pass => pass.name === bloom.name + " Blur Y");
    const merge = bloom.passes.find(pass => pass.name === bloom.name + " Merge");
    if (!blur || !FrameGraphRenderPass.IsRenderPass(blur) || typeof blur.renderTarget !== "number" || !merge) {
      throw new Error("Babylon bloom passes changed; bloom fusion needs review.");
    }
    const blurTexture = blur.renderTarget;
    merge.disabled = true;
    for (const pass of bloom.passesDisabled) pass.disabled = true;
    const pass = super.record(false, undefined, context => {
      const effect = this.drawWrapper.effect!;
      effect.setFloat("bloomWeight", bloom.disabled ? 0 : bloom.bloom.weight);
      context.bindTextureHandle(effect, "bloomBlur", blurTexture);
    });
    pass.addDependencies(blurTexture);
    return pass;
  }

  dispose() {
    EffectWrapper.RegisterShaderCodeProcessing(this.name);
    super.dispose();
  }
}
