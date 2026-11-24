import {readFileSync} from 'node:fs';
const data = JSON.parse(readFileSync(new URL('./layout-pages.json', import.meta.url), 'utf8'));
export function layoutPage(page) {
  if (page<0 || page>=data.pages) throw new RangeError('版面页越界');
  const first=page*data.rows, n=data.pages*data.rows, section=Math.floor(page/data.sectionPages);
  const sources=Array.from({length:data.rows},(_,i)=>({ordinal:first+i,section,q:1+((i+3)%7===0?1:0),skip:5+(i%3)}));
  const targets=Array.from({length:data.rows},(_,i)=>({ordinal:first+i,section,cap:1}));
  const edges=[];
  for(const {ordinal:i} of sources){
    for(let j=Math.max(0,i-3);j<Math.min(n,i+4);j++){
      const s=Math.floor(j/(data.rows*data.sectionPages));
      if(s===section) edges.push([i,j,Math.abs(j-i)+((i+j)%5),((i+2*j)%5)-2]);
    }
    for(const bridge of data.bridges) if(bridge[0]===i) edges.push(bridge);
  }
  return {page,sources,targets,edges,locks:data.locks.filter(([i])=>i>=first&&i<first+data.rows)};
}
