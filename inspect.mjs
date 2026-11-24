import {readFileSync} from 'node:fs';
import * as input from './inputs/layout-pages.mjs';

const source=JSON.parse(readFileSync(new URL('./inputs/layout-pages.json',import.meta.url),'utf8'));
console.log(JSON.stringify({名称:'长稿稀疏排版页',首项:source['pages'],字段:Object.keys(source),取数函数:Object.keys(input)},null,2));
