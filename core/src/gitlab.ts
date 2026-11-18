// Merge Request через GitLab CLI: все операции — `glab api --hostname <хост>` к REST API v4.
// Хост передаётся в каждом вызове явно, поэтому проекты на разных инстансах не мешают друг другу;
// учётные данные по хостам хранит сам glab.
import { which } from './env.js';
import type { Forge } from './forge.js';
import { parseRemote } from './forge.js';
import { run } from './proc.js';
import type { PrComment, PrStatus } from './types.js';

const T = 120_000;

/**
 * Окружение вызова: ни `GITLAB_HOST`, ни глобальные токены не должны попасть к чужому инстансу —
 * glab применяет `GITLAB_TOKEN` к любому `--hostname`, а нужен токен, сохранённый для хоста проекта (`glab auth login`).
 */
function glabEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const e = { ...env };
  for (const n of ['GITLAB_HOST', 'GITLAB_URI', 'GITLAB_TOKEN', 'GITLAB_ACCESS_TOKEN', 'OAUTH_TOKEN']) delete e[n];
  return e;
}

/** Текст ошибки: `message`/`error` из тела ответа GitLab или последние строки stderr. */
function errorText(stdout: string, stderr: string, fallback: string): string {
  try {
    const j = JSON.parse(stdout) as { message?: unknown; error?: unknown };
    const m = j.message ?? j.error;
    if (m) return typeof m === 'string' ? m : JSON.stringify(m);
  } catch {
    // тело не JSON — берём текст ниже
  }
  return (stderr || stdout).trim().split('\n').slice(-3).join(' ') || fallback;
}

async function glab(bin: string, host: string, cwd: string, env: NodeJS.ProcessEnv, args: string[]): Promise<string> {
  const r = await run(bin, ['api', '--hostname', host, ...args], { cwd, env: glabEnv(env), timeoutMs: T });
  if (r.code !== 0) throw new Error(errorText(r.stdout, r.stderr, `glab api: код ${r.code}`));
  return r.stdout;
}

/**
 * Ответ `glab api --paginate`: страницы приходят подряд (`[..][..]`), а не одним массивом.
 * Склеиваем их; если разобрать не вышло — ошибка, а не пустой список.
 */
export function parsePages<T>(out: string): T[] {
  const s = out.trim();
  if (!s) return [];
  const items: T[] = [];
  let i = 0;
  while (i < s.length) {
    while (i < s.length && /\s/.test(s[i])) i++;
    if (i >= s.length) break;
    const start = i;
    let depth = 0;
    let inStr = false;
    for (; i < s.length; i++) {
      const c = s[i];
      if (inStr) {
        if (c === '\\') i++;
        else if (c === '"') inStr = false;
      } else if (c === '"') inStr = true;
      else if (c === '[' || c === '{') depth++;
      else if (c === ']' || c === '}') {
        depth--;
        if (depth === 0) {
          i++;
          break;
        }
      }
    }
    if (depth !== 0) throw new Error('Не удалось разобрать ответ glab: обрезанный JSON');
    let v: unknown;
    try {
      v = JSON.parse(s.slice(start, i));
    } catch {
      throw new Error('Не удалось разобрать ответ glab: это не JSON');
    }
    if (Array.isArray(v)) items.push(...(v as T[]));
    else items.push(v as T);
  }
  return items;
}

const enc = encodeURIComponent;

/** Проект и номер MR из ссылки `https://host/group/sub/proj/-/merge_requests/N` (вложенные группы, хвост `/diffs`). */
export function parseMrUrl(url: string): { project: string; number: number } | null {
  const m = url.match(/^https?:\/\/[^/]+\/(.+?)\/-\/merge_requests\/(\d+)(?:[/?#].*)?$/);
  return m ? { project: m[1], number: Number(m[2]) } : null;
}

const mrPath = (project: string, n: number) => `projects/${enc(project)}/merge_requests/${n}`;

/** Можно ли создать MR: есть glab и он авторизован на этом хосте. */
export async function mrReadiness(bin: string | null, host: string, repo: string, env: NodeJS.ProcessEnv): Promise<string | null> {
  if (!bin) return `Нужен GitLab CLI: brew install glab, затем glab auth login --hostname ${host}`;
  const auth = await run(bin, ['auth', 'status', '--hostname', host], { cwd: repo, env: glabEnv(env), timeoutMs: 20_000 });
  if (auth.code !== 0) {
    const why = (auth.stderr || auth.stdout).trim().split('\n').slice(-2).join(' ');
    return `GitLab CLI не авторизован на ${host}: выполните glab auth login --hostname ${host}${why ? ` (${why})` : ''}`;
  }
  return null;
}

interface Mr {
  iid: number;
  title: string;
  web_url: string;
  state: string;
  draft?: boolean;
  work_in_progress?: boolean;
  merge_status?: string;
  detailed_merge_status?: string;
  has_conflicts?: boolean;
  merge_commit_sha?: string | null;
  squash_commit_sha?: string | null;
  sha?: string | null;
  head_pipeline?: { id: number } | null;
  diff_refs?: { head_sha?: string } | null;
}

interface Job {
  id: number;
  name: string;
  status: string;
  allow_failure?: boolean;
  retried?: boolean;
  web_url?: string;
}

const BLOCKED = new Set([
  'not_approved',
  'discussions_not_resolved',
  'ci_must_pass',
  'ci_still_running',
  'blocked_status',
  'requested_changes',
  'jira_association_missing',
  'not_open',
  'draft_status',
  'external_status_checks',
]);

const PENDING_JOB = new Set(['created', 'pending', 'running', 'preparing', 'waiting_for_resource', 'scheduled']);

/** Статус MR и pipeline в общем виде `PrStatus`. */
export async function mrStatus(bin: string, host: string, repo: string, env: NodeJS.ProcessEnv, url: string): Promise<PrStatus> {
  const p = parseMrUrl(url);
  if (!p) throw new Error(`Не похоже на ссылку на MR: ${url}`);
  const mr = JSON.parse(await glab(bin, host, repo, env, [mrPath(p.project, p.number)])) as Mr;

  // Старый GitLab (до 15.6) не отдаёт detailed_merge_status — тогда смотрим merge_status.
  const detailed = mr.detailed_merge_status ?? '';
  const legacy = detailed ? '' : (mr.merge_status ?? '');
  const conflicts = detailed
    ? detailed === 'conflict' || mr.has_conflicts === true
    : legacy === 'cannot_be_merged' || mr.has_conflicts === true;

  let jobs: Job[] = [];
  if (mr.head_pipeline?.id) {
    const out = await glab(bin, host, repo, env, [
      '--paginate',
      `projects/${enc(p.project)}/pipelines/${mr.head_pipeline.id}/jobs?per_page=100`,
    ]);
    // Последняя попытка каждого job: повторно запущенные заменяют прежние.
    const latest = new Map<string, Job>();
    for (const j of parsePages<Job>(out)) {
      if (j.retried) continue;
      const prev = latest.get(j.name);
      if (!prev || j.id > prev.id) latest.set(j.name, j);
    }
    jobs = [...latest.values()];
  }
  const verdict = (j: Job): 'ok' | 'pending' | 'failed' => {
    if (j.status === 'failed' && j.allow_failure) return 'ok';
    if (PENDING_JOB.has(j.status)) return 'pending';
    if (j.status === 'failed' || j.status === 'canceled') return 'failed';
    return 'ok'; // success, skipped, manual
  };
  const v = jobs.map(verdict);

  return {
    url: mr.web_url,
    number: mr.iid,
    state: mr.state === 'merged' ? 'MERGED' : mr.state === 'opened' || mr.state === 'locked' ? 'OPEN' : 'CLOSED',
    draft: mr.draft === true || mr.work_in_progress === true,
    mergeable: detailed ? detailed === 'mergeable' : legacy === 'can_be_merged',
    conflicts,
    blocked: BLOCKED.has(detailed),
    behind: conflicts || detailed === 'need_rebase',
    review: detailed === 'not_approved' ? 'REVIEW_REQUIRED' : detailed === 'requested_changes' ? 'CHANGES_REQUESTED' : null,
    checks: {
      total: v.length,
      passed: v.filter((x) => x === 'ok').length,
      failed: v.filter((x) => x === 'failed').length,
      pending: v.filter((x) => x === 'pending').length,
    },
    failedChecks: jobs.filter((_, i) => v[i] === 'failed').map((j) => ({ name: j.name, url: j.web_url ?? null })),
    // При fast-forward GitLab не отдаёт sha слияния — тогда коммит слияния это голова ветки.
    mergeCommit: mr.merge_commit_sha ?? mr.squash_commit_sha ?? (mr.state === 'merged' ? (mr.sha ?? mr.diff_refs?.head_sha ?? null) : null),
  };
}

export async function mrMerge(bin: string, host: string, repo: string, env: NodeJS.ProcessEnv, url: string): Promise<void> {
  const p = parseMrUrl(url);
  if (!p) throw new Error(`Не похоже на ссылку на MR: ${url}`);
  await glab(bin, host, repo, env, ['-X', 'PUT', `${mrPath(p.project, p.number)}/merge`]);
}

interface Note {
  id: number;
  body: string;
  author?: { username?: string } | null;
  created_at: string;
  system?: boolean;
  resolvable?: boolean;
  resolved?: boolean;
  position?: {
    new_path?: string | null;
    old_path?: string | null;
    new_line?: number | null;
    old_line?: number | null;
    head_sha?: string;
  } | null;
}

interface Discussion {
  id: string;
  individual_note?: boolean;
  notes?: Note[];
}

/** Обсуждения MR: ветки в коде и общие комментарии, без системных заметок. */
export async function mrComments(
  bin: string,
  host: string,
  repo: string,
  env: NodeJS.ProcessEnv,
  url: string,
): Promise<{ title: string; comments: PrComment[] }> {
  const p = parseMrUrl(url);
  if (!p) throw new Error(`Не похоже на ссылку на MR: ${url}`);
  const mr = JSON.parse(await glab(bin, host, repo, env, [mrPath(p.project, p.number)])) as Mr;
  const ds = parsePages<Discussion>(
    await glab(bin, host, repo, env, ['--paginate', `${mrPath(p.project, p.number)}/discussions?per_page=100`]),
  );
  const who = (n: Note) => n.author?.username ?? 'ghost';
  const out: PrComment[] = [];
  for (const d of ds) {
    const [first, ...rest] = (d.notes ?? []).filter((n) => !n.system);
    if (!first) continue;
    const pos = first.position;
    const thread = !!pos || d.individual_note === false;
    const resolvable = (d.notes ?? []).filter((n) => n.resolvable);
    const c: PrComment = {
      id: d.id,
      kind: thread ? 'thread' : 'comment',
      author: who(first),
      body: first.body,
      at: first.created_at,
      url: `${mr.web_url}#note_${first.id}`,
    };
    if (pos) {
      c.path = pos.new_path ?? pos.old_path ?? undefined;
      c.line = pos.new_line ?? pos.old_line ?? undefined;
      c.outdated = !!pos.head_sha && !!mr.diff_refs?.head_sha && pos.head_sha !== mr.diff_refs.head_sha;
    }
    if (thread) c.resolved = resolvable.length > 0 && resolvable.every((n) => n.resolved);
    if (rest.length) c.replies = rest.map((n) => ({ author: who(n), body: n.body, at: n.created_at }));
    out.push(c);
  }
  return { title: mr.title, comments: out.sort((a, b) => a.at.localeCompare(b.at)) };
}

/** Хвост лога упавшего job GitLab CI (по ссылке `…/-/jobs/<id>`). null — не job или лог недоступен. */
export async function failedJobLog(
  bin: string,
  host: string,
  repo: string,
  env: NodeJS.ProcessEnv,
  checkUrl: string,
): Promise<string | null> {
  const m = checkUrl.match(/^https?:\/\/[^/]+\/(.+?)\/-\/jobs\/(\d+)/);
  if (!m) return null;
  const r = await run(bin, ['api', '--hostname', host, `projects/${enc(m[1])}/jobs/${m[2]}/trace`], {
    cwd: repo,
    env: glabEnv(env),
    timeoutMs: T,
  });
  if (r.code !== 0) return null;
  // Цветовые коды и маркеры сворачиваемых секций — шум для агента.
  const ansi = /\x1b\[[0-9;?]*[A-Za-z]/g;
  const lines = r.stdout
    .replace(ansi, '')
    .replace(/section_(?:start|end):\d+:\S*/g, '')
    .replace(/\r/g, '')
    .split('\n')
    .filter((l) => l.trim());
  return lines.slice(-120).join('\n');
}

async function projectOf(repo: string, env: NodeJS.ProcessEnv): Promise<string> {
  const git = which('git', env) ?? 'git';
  const r = await run(git, ['remote', 'get-url', 'origin'], { cwd: repo, env, timeoutMs: 10_000 });
  const p = r.code === 0 ? parseRemote(r.stdout.trim()) : null;
  if (!p) throw new Error('Не удалось определить проект GitLab по адресу origin');
  return p.path;
}

/** Провайдер GitLab (gitlab.com и self-hosted): хост берётся из настроек проекта или `run.pr`. */
export function gitlabForge(bin: string | null, env: NodeJS.ProcessEnv, host: string): Forge {
  const need = (): string => {
    if (!bin) throw new Error(`Нужен GitLab CLI: brew install glab, затем glab auth login --hostname ${host}`);
    return bin;
  };
  return {
    kind: 'gitlab',
    host,
    readiness: (repo) => mrReadiness(bin, host, repo, env),
    create: async (repo, o) => {
      const project = await projectOf(repo, env);
      const out = await glab(need(), host, repo, env, [
        '-X',
        'POST',
        `projects/${enc(project)}/merge_requests`,
        '-f',
        `source_branch=${o.head}`,
        '-f',
        `target_branch=${o.base}`,
        '-f',
        `title=${o.title}`,
        '-F',
        `description=@${o.bodyFile}`,
        '-F',
        'remove_source_branch=false',
      ]);
      const mr = JSON.parse(out) as { web_url: string; iid: number };
      return { url: mr.web_url, number: mr.iid };
    },
    status: (repo, url) => mrStatus(need(), host, repo, env, url),
    merge: (repo, url) => mrMerge(need(), host, repo, env, url),
    comments: (repo, url) => mrComments(need(), host, repo, env, url),
    failedJobLog: (repo, checkUrl) => failedJobLog(need(), host, repo, env, checkUrl),
    parseUrl: parseMrUrl,
  };
}
