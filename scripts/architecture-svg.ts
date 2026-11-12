// Rewrites docs/architecture.svg from the diagram the Docs page draws: node scripts/architecture-svg.ts
import { writeFileSync } from 'node:fs';
import { architectureSvg } from '../packages/ui/src/ui/architecture.ts';

writeFileSync(new URL('../docs/architecture.svg', import.meta.url), `${architectureSvg('static')}\n`);
