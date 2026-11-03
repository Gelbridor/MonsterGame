import { layoutTown } from '../src/city/town-layout';
import { generateBuilding } from '../src/destruction/building-gen';
const layout = layoutTown(1987);
const levels = ['low', 'medium', 'high', 'ultra'] as const;
for (const spec of layout.specs) {
  if (spec.type === 'gasholder') continue;
  const row: string[] = [];
  for (const l of levels) {
    const t0 = performance.now();
    const g = generateBuilding(spec, l)!;
    row.push(`${l}:${g.pieces.length}p/${g.bonds.length}b/${(performance.now() - t0).toFixed(0)}ms`);
  }
  console.log(spec.id, spec.type, spec.floors, spec.width.toFixed(0) + 'x' + spec.depth.toFixed(0) + 'x' + spec.height.toFixed(0), row.join(' '));
}
