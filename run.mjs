import { readFileSync } from 'node:fs';
import { layoutPage } from './inputs/layout-pages.mjs';
import { replay } from './src/replay.mjs';

const data = JSON.parse(readFileSync(new URL('./inputs/layout-pages.json', import.meta.url), 'utf8'));
const { trace, accounting } = replay(layoutPage, data);
console.log(JSON.stringify(trace, null, 2));
console.log('--- 对账 ---');
console.log(JSON.stringify(accounting, null, 2));
