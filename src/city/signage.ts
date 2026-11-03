// Procedural sign atlas: shop fascias, pub signs, clock dial. Drawn once on a
// 2D canvas at start-up (no image files). Generic shop types only.
//
// Atlas is 1024 x 1024. Fascia slots are 512 x 128 (2 columns), the bottom
// row holds four 256 x 256 cells (clock dial, hanging pub sign, ...).

import * as THREE from 'three/webgpu';

export type SignName =
  | 'chippy' | 'news' | 'offLicence' | 'launderette' | 'kebab' | 'chemist' | 'takeaway'
  | 'cafe' | 'butcher' | 'pub' | 'pawn' | 'carPark' | 'clock' | 'pubHang' | 'blank';

export type UvRect = [number, number, number, number]; // [u0, vBottom, u1, vTop] (flipY = false)

const W = 1024;
const H = 1024;

interface SignDef { name: SignName; x: number; y: number; w: number; h: number }

const SLOTS: SignDef[] = [
  { name: 'chippy', x: 0, y: 0, w: 512, h: 128 },
  { name: 'news', x: 512, y: 0, w: 512, h: 128 },
  { name: 'offLicence', x: 0, y: 128, w: 512, h: 128 },
  { name: 'launderette', x: 512, y: 128, w: 512, h: 128 },
  { name: 'kebab', x: 0, y: 256, w: 512, h: 128 },
  { name: 'chemist', x: 512, y: 256, w: 512, h: 128 },
  { name: 'takeaway', x: 0, y: 384, w: 512, h: 128 },
  { name: 'cafe', x: 512, y: 384, w: 512, h: 128 },
  { name: 'butcher', x: 0, y: 512, w: 512, h: 128 },
  { name: 'pub', x: 512, y: 512, w: 512, h: 128 },
  { name: 'pawn', x: 0, y: 640, w: 512, h: 128 },
  { name: 'carPark', x: 512, y: 640, w: 512, h: 128 },
  { name: 'clock', x: 0, y: 768, w: 256, h: 256 },
  { name: 'pubHang', x: 256, y: 768, w: 256, h: 256 },
  { name: 'blank', x: 512, y: 768, w: 256, h: 256 },
];

export interface SignAtlas {
  texture: THREE.Texture;
  rect(name: SignName): UvRect;
}

function fitText(ctx: CanvasRenderingContext2D, text: string, maxW: number, maxPx: number, font: string): number {
  let px = maxPx;
  for (; px > 10; px -= 2) {
    ctx.font = `${font.replace('PX', String(px))}`;
    if (ctx.measureText(text).width <= maxW) break;
  }
  return px;
}

export function createSignAtlas(): SignAtlas {
  const rects = new Map<SignName, UvRect>();
  for (const s of SLOTS) rects.set(s.name, [s.x / W, (s.y + s.h) / H, (s.x + s.w) / W, s.y / H]);

  if (typeof document === 'undefined') {
    const tex = new THREE.DataTexture(new Uint8Array([20, 20, 20, 255]), 1, 1);
    tex.needsUpdate = true;
    return { texture: tex, rect: (n) => rects.get(n)! };
  }

  const canvas = document.createElement('canvas');
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext('2d')!;
  ctx.fillStyle = '#060606';
  ctx.fillRect(0, 0, W, H);

  const FONT = 'bold PXpx Impact, "Arial Black", "Helvetica Neue", Arial, sans-serif';

  const fascia = (
    d: SignDef, text: string, bg: string, fg: string, opts: { edge?: string; neon?: boolean; sub?: string; font?: string; glow?: string } = {},
  ): void => {
    ctx.save();
    ctx.translate(d.x, d.y);
    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, d.w, d.h);
    if (opts.edge) {
      ctx.strokeStyle = opts.edge;
      ctx.lineWidth = 8;
      ctx.strokeRect(6, 6, d.w - 12, d.h - 12);
    }
    const font = opts.font ?? FONT;
    const px = fitText(ctx, text, d.w - 60, d.h * (opts.sub ? 0.6 : 0.72), font);
    ctx.font = font.replace('PX', String(px));
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    const ty = d.h * (opts.sub ? 0.4 : 0.52);
    if (opts.neon) {
      ctx.shadowColor = opts.glow ?? fg;
      ctx.shadowBlur = 22;
      ctx.fillStyle = fg;
      ctx.fillText(text, d.w / 2, ty);
      ctx.shadowBlur = 8;
      ctx.fillText(text, d.w / 2, ty);
    } else {
      ctx.fillStyle = 'rgba(0,0,0,0.35)';
      ctx.fillText(text, d.w / 2 + 3, ty + 3);
      ctx.fillStyle = fg;
      ctx.fillText(text, d.w / 2, ty);
    }
    if (opts.sub) {
      ctx.shadowBlur = 0;
      ctx.font = 'bold 26px Arial, sans-serif';
      ctx.fillStyle = fg;
      ctx.fillText(opts.sub, d.w / 2, d.h * 0.86);
    }
    ctx.restore();
  };

  const slot = (n: SignName): SignDef => SLOTS.find((s) => s.name === n)!;

  fascia(slot('chippy'), 'CHIPPY', '#b3141b', '#fff3c4', { edge: '#ffe28a', sub: 'FISH & CHIPS' });
  fascia(slot('news'), 'NEWS', '#12408f', '#ffffff', { edge: '#f2c230', sub: 'PAPERS  LOTTERY  TOBACCO' });
  fascia(slot('offLicence'), 'OFF LICENCE', '#0f5a2c', '#f4f0d0', { edge: '#d9b84a' });
  fascia(slot('launderette'), 'LAUNDERETTE', '#0f6e78', '#eafcff', { edge: '#bfeef2' });
  fascia(slot('kebab'), 'KEBAB', '#05060a', '#ff3fa4', { neon: true, glow: '#ff1493', sub: 'OPEN LATE' });
  fascia(slot('chemist'), 'CHEMIST', '#f2f4ef', '#0d7a3a', { edge: '#0d7a3a' });
  fascia(slot('takeaway'), 'TAKEAWAY', '#05060a', '#3de8ff', { neon: true, glow: '#00bfff' });
  fascia(slot('cafe'), 'CAFE', '#e07a1f', '#2b1405', { edge: '#2b1405', sub: 'BREAKFAST ALL DAY' });
  fascia(slot('butcher'), 'BUTCHER', '#5d1119', '#f6e7c7', { edge: '#d8c08a' });
  fascia(slot('pub'), 'THE ROYAL OAK', '#10251a', '#e8c35a', { edge: '#c9a13a', font: 'bold PXpx Georgia, "Times New Roman", serif' });
  fascia(slot('pawn'), 'PAWN', '#0e1a36', '#f2c85a', { edge: '#f2c85a', sub: 'CASH FOR GOLD' });
  fascia(slot('carPark'), 'CAR PARK', '#0b3a85', '#ffffff', { edge: '#ffffff' });

  // --- clock dial (warm lit face, black roman-ish ticks and hands)
  {
    const d = slot('clock');
    ctx.save();
    ctx.translate(d.x, d.y);
    const cx = d.w / 2, cy = d.h / 2, r = d.w / 2 - 6;
    ctx.fillStyle = '#2a1d0a';
    ctx.fillRect(0, 0, d.w, d.h);
    const g = ctx.createRadialGradient(cx, cy, r * 0.1, cx, cy, r);
    g.addColorStop(0, '#fff0c4');
    g.addColorStop(1, '#f4cf85');
    ctx.fillStyle = g;
    ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI * 2); ctx.fill();
    ctx.strokeStyle = '#3a2a10'; ctx.lineWidth = 8;
    ctx.beginPath(); ctx.arc(cx, cy, r - 4, 0, Math.PI * 2); ctx.stroke();
    ctx.beginPath(); ctx.arc(cx, cy, r * 0.78, 0, Math.PI * 2); ctx.lineWidth = 3; ctx.stroke();
    ctx.fillStyle = '#25190a';
    ctx.font = 'bold 30px Georgia, serif';
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    const roman = ['XII', 'I', 'II', 'III', 'IIII', 'V', 'VI', 'VII', 'VIII', 'IX', 'X', 'XI'];
    for (let i = 0; i < 12; i++) {
      const a = (i / 12) * Math.PI * 2 - Math.PI / 2;
      ctx.save();
      ctx.translate(cx + Math.cos(a) * r * 0.62, cy + Math.sin(a) * r * 0.62);
      ctx.rotate(a + Math.PI / 2);
      ctx.fillText(roman[i], 0, 0);
      ctx.restore();
    }
    ctx.strokeStyle = '#25190a'; ctx.lineCap = 'round';
    ctx.lineWidth = 9; // hour hand ~ 10:10
    ctx.beginPath(); ctx.moveTo(cx, cy); ctx.lineTo(cx + Math.cos(-2.1) * r * 0.42, cy + Math.sin(-2.1) * r * 0.42); ctx.stroke();
    ctx.lineWidth = 6;
    ctx.beginPath(); ctx.moveTo(cx, cy); ctx.lineTo(cx + Math.cos(-0.52) * r * 0.62, cy + Math.sin(-0.52) * r * 0.62); ctx.stroke();
    ctx.beginPath(); ctx.arc(cx, cy, 8, 0, Math.PI * 2); ctx.fillStyle = '#25190a'; ctx.fill();
    ctx.restore();
  }

  // --- hanging pub sign (a painted oak on a green field)
  {
    const d = slot('pubHang');
    ctx.save();
    ctx.translate(d.x, d.y);
    ctx.fillStyle = '#1c3a22';
    ctx.fillRect(0, 0, d.w, d.h);
    ctx.strokeStyle = '#e8c35a'; ctx.lineWidth = 10;
    ctx.strokeRect(8, 8, d.w - 16, d.h - 16);
    ctx.fillStyle = '#5a3a1a';
    ctx.fillRect(d.w / 2 - 12, d.h * 0.45, 24, d.h * 0.3);
    ctx.fillStyle = '#3f8a3a';
    for (const [x, y, r] of [[0.5, 0.32, 0.2], [0.36, 0.4, 0.14], [0.64, 0.4, 0.14], [0.5, 0.2, 0.12]]) {
      ctx.beginPath(); ctx.arc(d.w * x, d.h * y, d.w * r, 0, Math.PI * 2); ctx.fill();
    }
    ctx.fillStyle = '#e8c35a';
    ctx.font = 'bold 34px Georgia, serif';
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText('THE ROYAL OAK', d.w / 2, d.h * 0.86);
    ctx.restore();
  }

  const tex = new THREE.CanvasTexture(canvas);
  tex.flipY = false;
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 8;
  tex.generateMipmaps = true;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.needsUpdate = true;
  return { texture: tex, rect: (n) => rects.get(n)! };
}
