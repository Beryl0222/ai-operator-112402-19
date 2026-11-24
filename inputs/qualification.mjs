export function page(input, index) {
  const start = index * input.rowsPerPage;
  const end = start + input.rowsPerPage;
  const areaSize = input.pagesPerSection * input.rowsPerPage;
  const source = [];
  const target = [];
  const edges = [];
  const anchors = [];
  const views = [];
  for (let word = start; word < end; word += 1) {
    const section = Math.floor(word / areaSize);
    const left = section * areaSize;
    const right = left + areaSize;
    source.push({ word, section, mass: word % 13 === 1 ? 2 : 1, skip: 8 + word % 3 });
    target.push({ word, section, cap: word % 5 === 0 ? 1 : 2 });
    views.push({ word, part: 0, start: word * 10, end: word * 10 + 6 });
    if (word % 11 === 0) {
      views.push({ word, part: 1, start: word * 10 + 6, end: word * 10 + 10 });
    }
    for (let j = Math.max(left, word - input.nearRadius); j < Math.min(right, word + input.nearRadius + 1); j += 1) {
      const [u, v] = input.patch.edge;
      const cost = word === u && j === v ? input.patch.range : Math.abs(word - j) + ((word * 19 + j) % 4);
      edges.push([word, j, cost]);
    }
    if ((word % areaSize === 0 && section > 0) || word === 4701) {
      anchors.push([word, word, 1]);
    }
  }
  return { source, target, edges, anchors, views };
}
