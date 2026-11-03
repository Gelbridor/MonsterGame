// Destruction material table (plan.md "Materials decide health, mass and effects").
// Densities are effective bulk values (cavities, voids and rebar averaged in), strengths are
// effective structural limits in Pa, so a bond's limit is simply strength x contact area.

import type { DMaterial, PieceKind } from './types';
import type { MatKey } from '../city/town-layout';

export interface MaterialDef {
  /** kg/m^3, effective. */
  density: number;
  /** Health of a typical piece before detaching (damage units; the punch deals 100 at its centre). */
  health: number;
  /** Compressive strength (Pa) used for bond limits. */
  strength: number;
  /** Tension limit as a fraction of the compressive limit. */
  tension: number;
  /** Shear limit as a fraction of the compressive limit. */
  shear: number;
  /** Shard count multiplier when the piece is destroyed. */
  shards: number;
  /** Contact force, in multiples of the piece's own weight, it can take before impact damage accrues. */
  impactG: number;
  /** Debug colour (0xRRGGBB). */
  color: number;
}

export const MATERIALS: Record<DMaterial, MaterialDef> = {
  concrete: { density: 2400, health: 140, strength: 25e6, tension: 0.15, shear: 0.35, shards: 0.8, impactG: 14, color: 0x9a9a98 },
  brick: { density: 1700, health: 60, strength: 8e6, tension: 0.06, shear: 0.3, shards: 1.0, impactG: 8, color: 0xa4553a },
  stone: { density: 2300, health: 150, strength: 15e6, tension: 0.05, shear: 0.3, shards: 0.8, impactG: 14, color: 0xb8a98a },
  glass: { density: 2500, health: 4, strength: 3e6, tension: 0.05, shear: 0.2, shards: 1.5, impactG: 2, color: 0x7fb4d0 },
  steel: { density: 1800, health: 400, strength: 60e6, tension: 0.8, shear: 0.55, shards: 0.6, impactG: 30, color: 0x5a6a78 },
  wood: { density: 450, health: 25, strength: 4e6, tension: 0.2, shear: 0.3, shards: 1.2, impactG: 5, color: 0x8a6a40 },
};

/** Piece health multiplier by kind (columns and slabs are tougher than cladding). */
export const KIND_HEALTH: Record<PieceKind, number> = {
  column: 0.8,
  slab: 1,
  wall: 1,
  window: 1,
  roof: 0.8,
  beam: 0.8,
};

/** Fill factor (voids, ribbed slabs, cavity walls) applied to density x volume. */
export const KIND_FILL: Record<PieceKind, number> = {
  column: 1,
  slab: 0.75,
  wall: 0.85,
  window: 1,
  roof: 0.6,
  beam: 1,
};

export function materialForSpec(key: MatKey): DMaterial {
  switch (key) {
    case 'brick0':
    case 'brick1':
    case 'brick2':
    case 'brick3':
    case 'shopBrick':
      return 'brick';
    case 'sandstone':
    case 'sootStone':
      return 'stone';
    case 'glass0':
    case 'glass1':
      return 'glass';
    case 'steel':
      return 'steel';
    case 'slate':
      return 'wood';
    default:
      return 'concrete';
  }
}
