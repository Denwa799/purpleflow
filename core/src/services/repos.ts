// Проект из нескольких репозиториев: общая папка прогона, рабочие копии участников, дифф и файлы по всем сразу.
import fs from 'node:fs';
import path from 'node:path';
import type { Git } from '../git.js';
import type { DiffFile, MultiRepo, RunFile, RunRepo } from '../types.js';

/** Где работают агенты и команды: общая папка прогона или рабочая копия единственного репозитория. */
export const workDir = (r: RunFile): string => r.root?.dir ?? r.worktreePath;

/** Путь файла от рабочей папки прогона: у участника проекта из нескольких репозиториев — с его папкой впереди. */
export const inRepo = (rel: string, p: string): string => (rel ? `${rel}/${p}` : p);

/**
 * Путь файла репозитория от рабочей папки. openspec/ основного виден в её корне ссылкой — его пути оставляем как есть,
 * чтобы проверки «это файлы плана» работали одинаково для одного и нескольких репозиториев.
 */
export const slotPath = (slot: { rel: string; extra?: unknown }, p: string): string =>
  !slot.extra && p.startsWith('openspec/') ? p : inRepo(slot.rel, p);

/** Один репозиторий прогона: основной или участник; base — от какого коммита считать изменения. */
export interface RepoSlot {
  rel: string;
  path: string;
  worktreePath: string;
  base: string;
  /** Участник (не основной). */
  extra?: RunRepo;
}

/** Все репозитории прогона, основной — первым. */
export function repoSlots(r: RunFile): RepoSlot[] {
  const main: RepoSlot = {
    rel: r.root?.main ?? '',
    path: r.projectPath,
    worktreePath: r.worktreePath,
    base: r.prRound && r.roundBase ? r.roundBase : r.baseCommit,
  };
  return [main, ...(r.repos ?? []).map((x) => ({ rel: x.rel, path: x.path, worktreePath: x.worktreePath, base: x.baseCommit, extra: x }))];
}

const SKIP_DIRS = new Set(['node_modules', 'vendor', 'target', 'dist', 'build', 'coverage', '.venv', 'venv']);

/** Вложенные git-репозитории папки (до трёх уровней), пути от неё; внутрь найденного не заходим. */
export function nestedRepos(dir: string, maxDepth = 3): string[] {
  const out: string[] = [];
  const walk = (rel: string, depth: number) => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(path.join(dir, rel), { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (!e.isDirectory() || e.name.startsWith('.') || SKIP_DIRS.has(e.name)) continue;
      const child = rel ? `${rel}/${e.name}` : e.name;
      if (fs.existsSync(path.join(dir, child, '.git'))) out.push(child);
      else if (depth < maxDepth) walk(child, depth + 1);
    }
  };
  walk('', 1);
  return out.sort();
}

export function realPath(p: string): string {
  try {
    return fs.realpathSync(p);
  } catch {
    return path.resolve(p);
  }
}

/**
 * Участники прогона по настройкам проекта: верхняя папка, путь основного от неё и остальные репозитории, которые на месте.
 * null — проект из одного репозитория (или основной оказался вне верхней папки).
 */
export function multiRepoOf(repo: string, cfg: MultiRepo | undefined): { root: string; main: string; repos: string[] } | null {
  if (!cfg?.repos.length) return null;
  // Реальные пути: git отдаёт корень репозитория без ссылок (/private/var…), а в настройках он мог быть записан со ссылкой.
  const root = realPath(cfg.root);
  const main = path.relative(root, realPath(repo)).split(path.sep).join('/');
  if (!main || main.startsWith('..') || path.isAbsolute(main)) return null;
  const repos = [...new Set(cfg.repos)].filter((rel) => rel && rel !== main && fs.existsSync(path.join(root, rel, '.git')));
  return repos.length ? { root, main, repos } : null;
}

/** Создать рабочие копии участников на ветке прогона. Сбой — убираем уже созданные. */
export async function addRepoWorktrees(git: Git, r: RunFile) {
  const done: RunRepo[] = [];
  try {
    for (const x of r.repos ?? []) {
      await git.addWorktree(x.path, x.worktreePath, r.branch, x.baseCommit);
      done.push(x);
    }
  } catch (e) {
    for (const x of done) await removeRepoWorktree(git, r, x, true).catch(() => {});
    throw e;
  }
}

export async function removeRepoWorktree(git: Git, r: RunFile, x: RunRepo, deleteBranch: boolean) {
  if (fs.existsSync(x.worktreePath)) await git.removeWorktree(x.path, x.worktreePath);
  if (deleteBranch) await git.deleteBranch(x.path, r.branch).catch(() => {});
}

/** Убрать всю рабочую папку прогона: копии участников и общую папку (копию основного убирает вызывающий). */
export async function removeRepoWorktrees(git: Git, r: RunFile, deleteBranch: boolean) {
  for (const x of r.repos ?? []) await removeRepoWorktree(git, r, x, deleteBranch).catch(() => {});
  if (r.root?.dir) fs.rmSync(r.root.dir, { recursive: true, force: true });
}

/**
 * openspec/ основного — ссылкой в корне общей папки: пути изменения в промптах (`openspec/changes/<id>/`) считаются от неё,
 * а файлы остаются в основном репозитории и уходят в его коммит.
 */
export function linkOpenspec(r: RunFile) {
  if (!r.root) return;
  const link = path.join(r.root.dir, 'openspec');
  const target = path.join(r.worktreePath, 'openspec');
  if (!fs.existsSync(target) || fs.existsSync(link)) return;
  fs.symlinkSync(path.relative(r.root.dir, target), link, 'dir');
}

/** Изменения прогона по всем репозиториям, пути — от рабочей папки. skip — по пути внутри репозитория. */
export async function repoDiff(git: Git, r: RunFile, skip: (slot: RepoSlot, p: string) => boolean): Promise<DiffFile[]> {
  const out: DiffFile[] = [];
  for (const slot of repoSlots(r)) {
    const files =
      r.status === 'finished'
        ? await git.diffCommits(slot.path, slot.extra ? slot.base : (r.diffFrom ?? r.baseCommit), r.branch, (p) => skip(slot, p))
        : await git.diff(slot.worktreePath, slot.base, (p) => skip(slot, p));
    out.push(...files.map((f) => ({ ...f, path: slotPath(slot, f.path) })));
  }
  return out;
}

/** Пути изменённых файлов по всем репозиториям (от рабочей папки). */
export async function repoChangedFiles(
  git: Git,
  r: RunFile,
  opts: { finished?: boolean; base?: 'run'; skip?: (slot: RepoSlot, p: string) => boolean } = {},
): Promise<string[]> {
  const out: string[] = [];
  for (const slot of repoSlots(r)) {
    const base = opts.base === 'run' ? (slot.extra ? slot.base : r.baseCommit) : slot.base;
    const files = opts.finished
      ? await git.namesBetween(slot.path, slot.extra ? slot.base : (r.diffFrom ?? r.baseCommit), r.branch)
      : await git.changedFiles(slot.worktreePath, base);
    out.push(...files.filter((f) => !opts.skip?.(slot, f)).map((f) => slotPath(slot, f)));
  }
  return out;
}

/** Дифф текстом по всем репозиториям — для ревьюера; exclude — шаблоны для всех и файлы окружения своего репозитория. */
export async function repoDiffText(git: Git, r: RunFile, common: string[], mainEnv: string[]): Promise<string> {
  const parts: string[] = [];
  for (const slot of repoSlots(r)) {
    const env = slot.extra ? (slot.extra.envFiles ?? []) : mainEnv;
    const text = await git.diffText(slot.worktreePath, slot.base, [...common, ...env], slot.rel || undefined);
    if (text.trim()) parts.push(text.trimEnd());
  }
  return parts.join('\n') + (parts.length ? '\n' : '');
}

/** Блок для агентов: из каких репозиториев собран проект и что вне их только читать. */
export function reposBlock(r: RunFile): string {
  if (!r.root) return '';
  const list = repoSlots(r)
    .map((s) => `- \`${s.rel}/\`${s.extra ? '' : ' — основной (в нём openspec/)'}`)
    .join('\n');
  return `\n\n## Проект из нескольких репозиториев\n\nРабочая папка собрана из отдельных git-репозиториев на одной ветке задачи — менять можно в любом из них:\n\n${list}\n\nПути в задаче и замечаниях — от рабочей папки (\`${r.root.main}/src/…\`). Остальное из папки проекта \`${r.root.path}\` (другие репозитории, файлы в её корне) только читай по абсолютным путям — ничего там не меняй. Не делай git commit — коммиты во все репозитории сделает оркестратор.`;
}

/** В прогоне есть другие репозитории, кроме основного. */
export function hasExtras(r: RunFile): boolean {
  return Boolean(r.root && r.repos?.length);
}
