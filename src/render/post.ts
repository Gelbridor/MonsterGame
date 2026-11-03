// Post-processing pipeline (RenderPipeline), tiered by QualityPreset.post.
//
//   scene pass (MRT: output + emissive [+ normal, reflectivity/roughness, velocity])
//     -> GTAO (depth-aware blurred)           ambient occlusion, emissive-safe
//     -> SSR                                  wet-street reflections, edge-faded
//     -> TRAA                                 (ultra only; SMAA / FXAA run after tone mapping)
//     -> bloom                                emissive-driven + HDR overflow
//     -> chromatic fringe + tone mapping (once, here) + sRGB
//     -> SMAA / FXAA                          (high / medium)
//     -> grade: lifted teal blacks, orange highlights, contrast, saturation, vignette, grain
//
// Tone mapping and the sRGB transfer are applied exactly once, in this graph
// (RenderPipeline.outputColorTransform is off), so nothing is double mapped.

import * as THREE from 'three/webgpu';
import * as TSL from 'three/tsl';
import { bloom } from 'three/addons/tsl/display/BloomNode.js';
import { ao } from 'three/addons/tsl/display/GTAONode.js';
import { depthAwareBlur } from 'three/addons/tsl/display/depthAwareBlur.js';
import { ssr } from 'three/addons/tsl/display/SSRNode.js';
import { traa } from 'three/addons/tsl/display/TRAANode.js';
import { smaa } from 'three/addons/tsl/display/SMAANode.js';
import { fxaa } from 'three/addons/tsl/display/FXAANode.js';
import { config } from '../config';
import type { QualityPreset } from '../core/types';
import type { Sky } from './sky';

/* eslint-disable @typescript-eslint/no-explicit-any */
type N = any;

// TSL's generic typings fight dynamic graph building; the node graph is untyped here on purpose.
const {
  pass, mrt, output, emissive, normalView, velocity, metalness, roughness, vec2, vec3, vec4, float, uniform, mix, smoothstep, clamp, dot, length, max, min, pow, fract, sin, time, screenUV, screenSize, screenCoordinate, convertToTexture, renderOutput, luminance, Fn,
} = TSL as any;

export interface Post {
  /** Render one frame through the pipeline. */
  render(): void;
  dispose(): void;
}

/** Scales the (soft-knee) bloom threshold: the input is emissive-driven, so config values around 0.85 would cut most windows. */
const BLOOM_THRESHOLD_SCALE = 0.35;
/** Overall bloom gain applied on top of config.render.bloomStrength. */
const BLOOM_GAIN = 0.55;

export function createPost(
  renderer: THREE.WebGPURenderer,
  scene: THREE.Scene,
  camera: THREE.PerspectiveCamera,
  quality: QualityPreset,
  sky: Sky,
  toneMapping: THREE.ToneMapping,
): Post {
  const p = quality.post;
  const needNormal = p.ao || p.ssr;
  const useTraa = p.aa === 'traa';

  // ---- live uniforms (updated from config every frame)
  const u = {
    bloomStrength: uniform(config.render.bloomStrength),
    bloomRadius: uniform(config.render.bloomRadius),
    bloomThreshold: uniform(config.render.bloomThreshold),
    aoIntensity: uniform(config.render.aoIntensity),
    ssrStrength: uniform(config.render.ssrStrength),
    grain: uniform(config.render.filmGrain),
    vignette: uniform(config.render.vignette),
    ca: uniform(config.render.chromaticAberration),
    saturation: uniform(config.render.saturation),
    contrast: uniform(config.render.contrast),
  };

  // ---- scene pass with MRT
  const scenePass: N = pass(scene, camera, { samples: 0 });
  const trans = sky.fogTransmittance();
  const mrtNodes: Record<string, N> = {
    output,
    // Emissive light that survives the fog: distant lamps must not punch through the haze.
    emissive: vec4(emissive.mul(trans), 1),
  };
  if (needNormal) mrtNodes.normal = normalView;
  if (p.ssr) {
    // x: how mirror-like this surface is (metal, or smooth / wet), already faded by fog; y: roughness.
    const wet = float(1).sub(smoothstep(0.1, 0.55, roughness));
    mrtNodes.refl = vec2(max(metalness, wet.mul(0.9)).mul(trans), roughness);
  }
  if (useTraa) mrtNodes.velocity = velocity;
  scenePass.setMRT(mrt(mrtNodes));

  const sceneColor: N = scenePass.getTextureNode('output');
  const sceneEmissive: N = scenePass.getTextureNode('emissive');
  const sceneDepth: N = scenePass.getTextureNode('depth');
  const sceneNormal: N = needNormal ? scenePass.getTextureNode('normal') : null;

  // ---- composite in linear HDR
  let comp: N = sceneColor.rgb;
  const emisT: N = sceneEmissive.rgb;
  const disposables: { dispose(): void }[] = [];

  if (p.ao) {
    const aoNode: N = ao(sceneDepth, sceneNormal, camera);
    aoNode.resolutionScale = p.effectScale;
    aoNode.samples.value = p.effectScale < 1 ? 12 : 16;
    aoNode.distanceExponent.value = 1.4;
    aoNode.thickness.value = 1.5;
    aoNode.scale.value = 1.6;
    aoNode.useTemporalFiltering = useTraa;
    disposables.push(aoNode);
    (u as N).aoRadius = aoNode.radius;
    const aoTex: N = aoNode.getTextureNode();
    // Two cheap depth-aware blur passes at AO resolution remove the sampling noise without haloing silhouettes.
    const aoSize = screenSize.mul(p.effectScale);
    const blurOpts = { resolutionScale: p.effectScale };
    const aoH: N = convertToTexture(
      vec4(depthAwareBlur(aoTex, sceneDepth, vec2(float(1).div(aoSize.x), 0), camera, 2, 2.0), 0, 0, 1),
      null, null, blurOpts,
    );
    const aoV: N = convertToTexture(
      vec4(depthAwareBlur(aoH, sceneDepth, vec2(0, float(1).div(aoSize.y)), camera, 2, 2.0), 0, 0, 1),
      null, null, blurOpts,
    );
    // AO darkens lit surface colour but never emissive light, and fades out with the haze.
    const aoFactor = mix(float(1), aoV.sample(screenUV).r, u.aoIntensity.mul(0.9).clamp(0, 1));
    comp = emisT.add(comp.sub(emisT).max(0).mul(aoFactor));
  }

  if (p.ssr) {
    const reflTex: N = scenePass.getTextureNode('refl');
    const ssrNode: N = ssr(sceneColor, sceneDepth, sceneNormal, {
      metalnessNode: reflTex.r,
      roughnessNode: reflTex.g,
      reflectNonMetals: false, // zero-reflectivity pixels (dry, rough) are discarded early
    });
    ssrNode.resolutionScale = p.effectScale;
    ssrNode.maxDistance.value = 140;
    ssrNode.thickness.value = 0.8;
    ssrNode.quality.value = 0.6;
    ssrNode.intensity = u.ssrStrength;
    disposables.push(ssrNode);
    const ssrTex: N = ssrNode.getTextureNode();
    // Fade the reflection out towards the screen edges where rays run out of information.
    const e = min(min(screenUV.x, screenUV.x.oneMinus()), min(screenUV.y, screenUV.y.oneMinus()));
    const edgeFade = smoothstep(0.0, 0.12, e);
    comp = comp.add(ssrTex.rgb.mul(edgeFade));
  }

  // ---- AA / resolve of the HDR composite
  let hdrTex: N;
  if (useTraa) {
    const traaNode: N = traa(convertToTexture(vec4(comp, 1)), sceneDepth, scenePass.getTextureNode('velocity'), camera);
    disposables.push(traaNode);
    hdrTex = traaNode.getTextureNode();
  } else if (p.ao || p.ssr) {
    hdrTex = convertToTexture(vec4(comp, 1));
  } else {
    hdrTex = sceneColor;
  }

  // ---- bloom: emissive (windows, lamps, signs, lava) plus HDR overflow (moon, flames, glints)
  let bloomTex: N = null;
  let bloomNode: N = null;
  if (p.bloom) {
    const overflow = comp.sub(1.5).max(0).mul(0.5);
    const bloomInput = vec4(max(emisT, overflow), 1);
    bloomNode = bloom(bloomInput, u.bloomStrength, u.bloomRadius, u.bloomThreshold);
    bloomNode.smoothWidth.value = 0.6;
    bloomNode.setResolutionScale(0.5);
    disposables.push(bloomNode);
    bloomTex = bloomNode.getTextureNode();
  }

  // ---- fringe + tone mapping + sRGB
  const toLDR = Fn(() => {
    const uv = screenUV;
    let hdr: N;
    if (p.filmic) {
      const v = uv.sub(0.5);
      const shift = v.mul(dot(v, v)).mul(u.ca.mul(3.0));
      hdr = vec3(hdrTex.sample(uv.add(shift)).r, hdrTex.sample(uv).g, hdrTex.sample(uv.sub(shift)).b);
    } else {
      hdr = hdrTex.sample(uv).rgb;
    }
    if (bloomTex) hdr = hdr.add(bloomTex.sample(uv).rgb);
    return renderOutput(vec4(hdr, 1), toneMapping, THREE.SRGBColorSpace).rgb;
  });

  // ---- grade (display-referred)
  const grade = (ldr: N): N => {
    if (!p.filmic) return vec4(ldr, 1);
    const uv = screenUV;
    let c: N = ldr;
    // Lift the blacks towards teal so shadows never crush to dead grey-black.
    const lift = vec3(0.004, 0.011, 0.016);
    c = c.add(lift.mul(float(1).sub(c).max(0).pow(3.0)));
    // Contrast around a low pivot (a night image lives in the shadows), then saturation.
    c = c.sub(0.22).mul(u.contrast).add(0.22).max(0);
    const l = dot(c, vec3(0.2126, 0.7152, 0.0722));
    c = mix(vec3(l), c, u.saturation);
    // Split tone: cool shadows, warm highlights. Kept subtle.
    const shadowAmt = float(1).sub(smoothstep(0.0, 0.4, l));
    const hiAmt = smoothstep(0.45, 1.0, l);
    c = c.mul(mix(vec3(1), vec3(0.93, 1.0, 1.07), shadowAmt.mul(0.5)));
    c = c.mul(mix(vec3(1), vec3(1.06, 1.0, 0.92), hiAmt.mul(0.6)));
    // Vignette.
    const aspect = screenSize.x.div(screenSize.y);
    const q = uv.sub(0.5).mul(vec2(aspect.mul(0.55).add(0.45), 1.0));
    const vig = float(1).sub(smoothstep(0.25, 0.95, length(q).mul(1.25)).mul(u.vignette));
    c = c.mul(vig);
    // Film grain (stronger in the mids), also dithers dark gradients so the sky does not band.
    const n1 = fract(sin(dot(screenCoordinate.xy.add(fract(time).mul(97.0)), vec2(12.9898, 78.233))).mul(43758.5453));
    const n2 = fract(sin(dot(screenCoordinate.xy.add(fract(time.add(0.37)).mul(61.0)), vec2(39.3468, 11.135))).mul(24634.6345));
    const tri = n1.add(n2).sub(1.0);
    const lumW = float(0.35).add(smoothstep(0.0, 0.5, l).mul(0.65));
    c = c.add(tri.mul(u.grain.mul(0.36).mul(lumW)).add(tri.mul(1.0 / 255.0)));
    return vec4(c.max(0), 1);
  };

  let outNode: N;
  const ldr = vec4(toLDR(), 1);
  if (p.aa === 'smaa') outNode = grade((smaa(ldr) as N).rgb);
  else if (p.aa === 'fxaa') outNode = grade((fxaa(ldr) as N).rgb);
  else outNode = grade(ldr.rgb);

  const pipeline = new THREE.RenderPipeline(renderer);
  pipeline.outputColorTransform = false;
  pipeline.outputNode = outNode;

  // Draw-call stats should cover the whole frame, not just the last full-screen quad.
  renderer.info.autoReset = false;

  const aoRadiusUniform: N = (u as N).aoRadius;
  void luminance; void pow; void clamp;

  return {
    render(): void {
      renderer.info.reset();
      u.bloomStrength.value = config.render.bloomStrength * BLOOM_GAIN;
      u.bloomRadius.value = config.render.bloomRadius;
      u.bloomThreshold.value = config.render.bloomThreshold * BLOOM_THRESHOLD_SCALE;
      u.aoIntensity.value = config.render.aoIntensity;
      if (aoRadiusUniform) aoRadiusUniform.value = config.render.aoRadius;
      u.ssrStrength.value = config.render.ssrStrength;
      u.grain.value = config.render.filmGrain;
      u.vignette.value = config.render.vignette;
      u.ca.value = config.render.chromaticAberration;
      u.saturation.value = config.render.saturation;
      u.contrast.value = config.render.contrast;
      pipeline.render();
    },
    dispose(): void {
      for (const d of disposables) {
        try {
          d.dispose();
        } catch {
          // ignore
        }
      }
      pipeline.dispose();
    },
  };
}
