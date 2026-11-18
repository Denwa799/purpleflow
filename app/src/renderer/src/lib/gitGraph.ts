// Раскладка истории git по колонкам для графа: у каждого коммита — колонка и отрезки линий над и под точкой.

export interface GraphSeg {
  from: number;
  to: number;
  color: number;
}

export interface GraphRow {
  col: number;
  color: number;
  /** От верхнего края строки к точке (или мимо неё). */
  top: GraphSeg[];
  /** От точки (или мимо неё) к нижнему краю строки. */
  bottom: GraphSeg[];
  width: number;
}

/** commits — сверху новые, дети выше родителей (git log --topo-order). */
export function layoutGraph(commits: { hash: string; parents: string[] }[]): GraphRow[] {
  const lanes: (string | null)[] = [];
  const colors: number[] = [];
  let nextColor = 0;
  const free = () => {
    const i = lanes.indexOf(null);
    return i >= 0 ? i : lanes.length;
  };
  const rows: GraphRow[] = [];
  for (const c of commits) {
    const before = lanes.slice();
    const beforeColors = colors.slice();
    let col = lanes.indexOf(c.hash);
    if (col < 0) {
      // Вершина ветки, которую ещё никто не ждал.
      col = free();
      lanes[col] = c.hash;
      colors[col] = nextColor++;
    }
    const top: GraphSeg[] = [];
    before.forEach((h, j) => {
      if (h == null) return;
      top.push({ from: j, to: h === c.hash ? col : j, color: beforeColors[j] });
    });
    // Другие линии, ждавшие этот коммит, сходятся в него.
    lanes.forEach((h, j) => {
      if (h === c.hash && j !== col) lanes[j] = null;
    });
    const color = colors[col];
    const parentLanes: number[] = [];
    if (!c.parents.length) lanes[col] = null;
    else {
      lanes[col] = c.parents[0];
      for (const p of c.parents.slice(1)) {
        let k = lanes.indexOf(p);
        if (k < 0) {
          k = free();
          lanes[k] = p;
          colors[k] = nextColor++;
        }
        parentLanes.push(k);
      }
    }
    const bottom: GraphSeg[] = [];
    lanes.forEach((h, j) => {
      if (h == null) return;
      if (j === col) bottom.push({ from: col, to: col, color });
      else if (parentLanes.includes(j)) bottom.push({ from: col, to: j, color: colors[j] });
      else bottom.push({ from: j, to: j, color: colors[j] });
    });
    while (lanes.length && lanes[lanes.length - 1] == null) {
      lanes.pop();
      colors.length = lanes.length;
    }
    rows.push({ col, color, top, bottom, width: Math.max(before.length, col + 1, ...bottom.map((s) => Math.max(s.from, s.to) + 1)) });
  }
  return rows;
}
