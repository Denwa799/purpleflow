// Провайдер Pull/Merge Request: общий интерфейс, разбор origin и выбор провайдера для проекта и прогона.
import path from 'node:path';
import { which } from './env.js';
import { githubForge } from './github.js';
import { gitlabForge, mrReadiness } from './gitlab.js';
import type { Kernel } from './kernel.js';
import { run } from './proc.js';
import type { ForgeKind, ForgeRef, PrComment, PrStatus, RunFile } from './types.js';

export type { ForgeKind, ForgeRef } from './types.js';

/** Операции Pull/Merge Request одного провайдера на одном хосте. */
export interface Forge extends ForgeRef {
  /** null — можно создавать PR/MR, иначе причина. */
  readiness(repo: string): Promise<string | null>;
  create(repo: string, o: { base: string; head: string; title: string; bodyFile: string }): Promise<{ url: string; number: number }>;
  status(repo: string, url: string): Promise<PrStatus>;
  merge(repo: string, url: string): Promise<void>;
  comments(repo: string, url: string): Promise<{ title: string; comments: PrComment[] }>;
  /** Хвост лога упавшей проверки по ссылке; null — не поддерживается или недоступен. */
  failedJobLog(repo: string, checkUrl: string): Promise<string | null>;
  parseUrl(url: string): { project: string; number: number } | null;
}

/** Хост и путь проекта из адреса remote: https (в том числе с портом), `git@host:a/b.git`, `ssh://git@host:2222/a/b.git`. */
export function parseRemote(remote: string): { host: string; path: string } | null {
  const s = remote.trim();
  const clean = (p: string) =>
    p
      .replace(/^\/+/, '')
      .replace(/\/+$/, '')
      .replace(/\.git$/i, '');
  const url = s.match(/^(https?|ssh|git):\/\/(?:[^@/]*@)?([^/:]+)(:\d+)?\/(.+)$/i);
  if (url) {
    // Порт SSH к веб-хосту отношения не имеет, порт http(s) — часть адреса инстанса.
    const web = /^https?$/i.test(url[1]);
    const p = clean(url[4]);
    return p ? { host: url[2].toLowerCase() + (web ? (url[3] ?? '') : ''), path: p } : null;
  }
  // `C:\путь` — диск Windows, а не хост scp-вида.
  const scp = /^[a-z]:[\\/]/i.test(s) ? null : s.match(/^(?:[^@/\s]+@)?([^/:\s]+):(?!\/)(.+)$/);
  if (scp) {
    const p = clean(scp[2]);
    return p ? { host: scp[1].toLowerCase(), path: p } : null;
  }
  return null;
}

export interface ForgeDetection {
  host: string | null;
  /** Предложение по адресу origin; null — по хосту ничего не понятно. */
  suggested: ForgeRef | null;
  /** Хост точно известен (github.com, gitlab.com) — подтверждать не нужно. */
  confirmed: boolean;
}

/** Провайдер по адресу origin: публичные хосты подтверждены, self-hosted GitLab — только предложение. */
export function detectForge(remote: string | null | undefined): ForgeDetection {
  const p = remote ? parseRemote(remote) : null;
  if (!p) return { host: null, suggested: null, confirmed: false };
  const host = p.host;
  // Порт и служебные имена для обхода файрвола (ssh.github.com:443, altssh.gitlab.com) — тот же публичный хост.
  const bare = host.replace(/:\d+$/, '');
  if (bare === 'github.com' || bare === 'ssh.github.com')
    return { host: 'github.com', suggested: { kind: 'github', host: 'github.com' }, confirmed: true };
  if (bare === 'gitlab.com' || bare === 'ssh.gitlab.com' || bare === 'altssh.gitlab.com')
    return { host: 'gitlab.com', suggested: { kind: 'gitlab', host: 'gitlab.com' }, confirmed: true };
  if (host === 'github.com') return { host, suggested: { kind: 'github', host }, confirmed: true };
  if (host === 'gitlab.com') return { host, suggested: { kind: 'gitlab', host }, confirmed: true };
  if (host.includes('gitlab')) return { host, suggested: { kind: 'gitlab', host }, confirmed: false };
  return { host, suggested: null, confirmed: false };
}

/** Провайдер для ссылки: бинарь CLI ищется в окружении ядра. null — провайдер недоступен. */
function buildForge(k: Kernel, ref: ForgeRef): Forge | null {
  if (ref.kind === 'github') {
    const bin = which('gh', k.opts.env);
    return bin ? githubForge(bin, k.opts.env, ref.host) : null;
  }
  const bin = which('glab', k.opts.env);
  return bin ? gitlabForge(bin, k.opts.env, ref.host) : null;
}

/** Хост из поля настроек: без схемы, пути, порта-пробелов и регистра («https://GitLab.Company.ru/» → «gitlab.company.ru»). */
export function normalizeHost(raw: string): string {
  return raw
    .trim()
    .replace(/^[a-z]+:\/\//i, '')
    .replace(/^[^@/]*@/, '')
    .split(/[/\s]/)[0]
    .toLowerCase();
}

export async function originOf(k: Kernel, repo: string): Promise<string | null> {
  const tools = await k.tools(['git']);
  const r = await run(tools.git, ['remote', 'get-url', 'origin'], { cwd: repo, env: k.opts.env, timeoutMs: 10_000 });
  return r.code === 0 ? r.stdout.trim() : null;
}

/**
 * Провайдер проекта: настройки проекта → автоопределение по подтверждённому хосту → причина отказа.
 * Локальное слияние от провайдера не зависит, поэтому причина подсказывает о нём.
 */
export async function resolveForge(k: Kernel, repo: string): Promise<{ forge: Forge | null; reason: string | null }> {
  const remote = await originOf(k, repo);
  if (!remote) return { forge: null, reason: 'У проекта нет удалённого репозитория origin' };
  const saved = k.store.readProjects()[path.resolve(repo)]?.forge;
  const det = detectForge(remote);
  const ref = saved ?? (det.confirmed ? det.suggested : null);
  if (!ref) {
    const host = det.host ?? remote;
    return {
      forge: null,
      reason: `Провайдер для ${host} не настроен: укажите GitHub или GitLab и хост в настройках проекта. Влить локально можно и без него`,
    };
  }
  // Хост из настроек должен совпадать с origin: иначе ветка уйдёт в origin, а MR — на другой инстанс.
  const originHost = det.host?.replace(/:\d+$/, '');
  if (saved && originHost && originHost !== saved.host.replace(/:\d+$/, '')) {
    return {
      forge: null,
      reason: `Хост origin (${originHost}) не совпадает с хостом в настройках проекта (${saved.host}): поправьте настройки или origin. Влить локально можно и без MR/PR`,
    };
  }
  const forge = buildForge(k, ref);
  if (forge) return { forge, reason: await forge.readiness(repo) };
  return {
    forge: null,
    reason:
      ref.kind === 'gitlab'
        ? await mrReadiness(null, ref.host, repo, k.opts.env)
        : 'Нужен GitHub CLI: brew install gh, затем gh auth login',
  };
}

/** Провайдер прогона: по `run.pr`, а не по текущим настройкам проекта; старые прогоны без `kind` — GitHub. */
export function forgeOfRun(k: Kernel, r: RunFile): Forge | null {
  if (!r.pr) return null;
  const kind: ForgeKind = r.pr.kind ?? 'github';
  const host = r.pr.host ?? parseRemote(r.pr.url)?.host ?? 'github.com';
  return buildForge(k, { kind, host });
}
