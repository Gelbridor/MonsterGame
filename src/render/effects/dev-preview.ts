// DEV-ONLY harness: adds the weather effects to a running game without touching main.ts.
//   node scripts/shot.cjs "...?webgl&quality=ultra" out.png --eval \
//     "return import('/src/render/effects/dev-preview.ts').then(m => m.installFxPreview(mb, {}))"
// Not imported by the game.

import * as THREE from 'three/webgpu';
import { createRain } from './rain';
import { collectLampPositions, setWeatherLamps, weatherLamps } from './weather-common';

export const dbg = { weatherLamps };

type Mb = {
  ctx: { scene: THREE.Scene; camera: THREE.PerspectiveCamera; quality: unknown; render: () => void };
  town: { group: THREE.Group };
  config: { weather: { rain: number } };
};

export interface PreviewOptions {
  rain?: boolean;
  splashes?: boolean;
  cones?: boolean;
  /** Fixed camera: [px,py,pz, tx,ty,tz]. */
  cam?: number[];
  /** Extra PointLights at lamp positions so ground/walls are lit by the lamps. */
  lights?: boolean;
  fov?: number;
  sheets?: boolean;
  near?: boolean;
}

export async function installFxPreview(mb: Mb, opts: PreviewOptions = {}): Promise<string> {
  const { scene, camera } = mb.ctx;
  const quality = mb.ctx.quality as never;
  const lamps = collectLampPositions(mb.town.group);
  setWeatherLamps(lamps);

  const updaters: ((dt: number) => void)[] = [];
  if (opts.rain !== false) {
    const rain = createRain(scene, camera, quality, { sheets: opts.sheets, near: opts.near });
    updaters.push((dt) => rain.update(dt));
  }
  if (opts.splashes !== false) {
    try {
      const m = await import('./splashes');
      const s = m.createSplashes(scene, camera, quality);
      updaters.push((dt) => s.update(dt));
    } catch (e) {
      console.warn('splashes unavailable', e);
    }
  }
  if (opts.cones !== false) {
    try {
      const m = await import('./light-cones');
      const c = m.createLightCones(scene, lamps, undefined, quality);
      updaters.push((dt) => c.update(dt, camera));
    } catch (e) {
      console.warn('cones unavailable', e);
    }
  }

  if (opts.cam) camera.position.set(opts.cam[0], opts.cam[1], opts.cam[2]);
  if (opts.lights) {
    // Temporary real lights so the street shows pools under the lamps.
    const order = lamps
      .map((l) => ({ l }))
      .sort((a, b) => a.l.distanceTo(camera.position) - b.l.distanceTo(camera.position))
      .slice(0, 8);
    for (const { l } of order) {
      const pl = new THREE.PointLight(0xff9a40, 2500, 40, 2);
      pl.position.copy(l).add(new THREE.Vector3(0, -0.5, 0));
      scene.add(pl);
    }
  }

  if (opts.fov) {
    mb.ctx.camera.fov = opts.fov;
    mb.ctx.camera.updateProjectionMatrix();
  }

  const origRender = mb.ctx.render;
  let last = performance.now();
  mb.ctx.render = () => {
    const now = performance.now();
    const dt = Math.min(0.25, (now - last) / 1000);
    last = now;
    if (opts.cam) {
      camera.position.set(opts.cam[0], opts.cam[1], opts.cam[2]);
      camera.lookAt(opts.cam[3], opts.cam[4], opts.cam[5]);
      camera.updateMatrixWorld();
    }
    for (const u of updaters) u(dt);
    origRender();
  };
  return `fxpreview: ${lamps.length} lamps, ${updaters.length} effects`;
}
