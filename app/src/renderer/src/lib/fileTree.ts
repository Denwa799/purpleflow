/** Узел дерева файлов проекта: папки — с детьми, сначала папки, затем файлы, по алфавиту. */
export interface TreeNode {
  name: string;
  /** Путь от корня проекта, через «/». */
  path: string;
  children?: TreeNode[];
}

/** Дерево из списка путей (git ls-files): папки выводятся из путей. */
export function buildTree(files: string[]): TreeNode[] {
  const root: TreeNode = { name: '', path: '', children: [] };
  const dirs = new Map<string, TreeNode>([['', root]]);
  for (const f of files) {
    const parts = f.split('/').filter(Boolean);
    let parent = root;
    for (let i = 0; i < parts.length; i++) {
      const p = parts.slice(0, i + 1).join('/');
      if (i === parts.length - 1) {
        parent.children!.push({ name: parts[i], path: p });
        break;
      }
      let d = dirs.get(p);
      if (!d) {
        d = { name: parts[i], path: p, children: [] };
        dirs.set(p, d);
        parent.children!.push(d);
      }
      parent = d;
    }
  }
  const sort = (n: TreeNode) => {
    if (!n.children) return;
    n.children.sort((a, b) => Number(Boolean(b.children)) - Number(Boolean(a.children)) || a.name.localeCompare(b.name));
    n.children.forEach(sort);
  };
  sort(root);
  return root.children!;
}
