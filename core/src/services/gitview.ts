// Вкладка «Git» (только просмотр): ветки, история с графом и дифф коммита. Ничего в репозитории не меняет.
import fs from 'node:fs';
import path from 'node:path';
import { Git } from '../git.js';
import type { Kernel } from '../kernel.js';
import type { DiffFile, GitBranchInfo, GitCommitInfo, GitGraph } from '../types.js';

/** Пустое дерево git: дифф первого коммита считается от него. */
const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';
const MAX_BRANCHES = 60;

async function gitFor(k: Kernel, dir: string): Promise<Git> {
  if (!dir || !fs.existsSync(dir)) throw new Error('Папка проекта не найдена');
  const git = new Git((await k.tools(['git'])).git, k.opts.env);
  if (!(await git.isRepo(dir))) throw new Error('Папка проекта — не git-репозиторий');
  return git;
}

export async function gitGraph(k: Kernel, dir: string, limit = 400): Promise<GitGraph> {
  const git = await gitFor(k, dir);
  const [log, refs, cur, head] = await Promise.all([
    git.graphLog(dir, limit + 1),
    git.refList(dir),
    git.branches(dir).then((b) => b.current),
    git.revParse(dir, 'HEAD').catch(() => ''),
  ]);
  const byHash = new Map<string, string[]>();
  const branches: GitBranchInfo[] = [];
  for (const r of refs) {
    let name: string;
    if (r.ref.startsWith('refs/heads/')) name = r.ref.slice(11);
    else if (r.ref.startsWith('refs/remotes/')) name = r.ref.slice(13);
    else name = `tag: ${r.ref.slice(10)}`;
    if (name === 'origin/HEAD') continue;
    byHash.set(r.hash, [...(byHash.get(r.hash) ?? []), name]);
    if (!name.startsWith('tag: ')) branches.push({ name, remote: r.ref.startsWith('refs/remotes/'), hash: r.hash, at: r.at });
  }
  const local = new Set(branches.filter((b) => !b.remote).map((b) => b.name));
  const base = ['main', 'master'].find((b) => local.has(b)) ?? cur;
  // Ветки прогонов — с названием задачи.
  const runs = new Map(
    k.store
      .list()
      .filter((r) => path.resolve(r.projectPath) === path.resolve(dir) && r.branch)
      .map((r) => [r.branch, { id: r.id, title: r.title }]),
  );
  const shown = branches.slice(0, MAX_BRANCHES);
  await Promise.all(
    shown.map(async (b) => {
      const run = runs.get(b.name);
      if (run) b.run = run;
      if (!base || b.name === base) return;
      const ab = await git.aheadBehind(dir, base, b.hash);
      if (ab) Object.assign(b, ab);
    }),
  );
  const commits: GitCommitInfo[] = log.slice(0, limit).map((c) => ({ ...c, refs: byHash.get(c.hash) ?? [] }));
  return { current: cur, head, base: base ?? null, branches: shown, commits, more: log.length > limit };
}

/** Что изменил коммит: относительно первого родителя (у слияния — что пришло в основную линию), у первого — всё. */
export async function gitCommitDiff(k: Kernel, dir: string, hash: string): Promise<DiffFile[]> {
  if (!/^[0-9a-f]{7,40}$/i.test(hash)) throw new Error('Неверный коммит');
  const git = await gitFor(k, dir);
  const parent = await git.revParse(dir, `${hash}^`).catch(() => '');
  return git.diffCommits(dir, parent || EMPTY_TREE, hash);
}
