// Ветки и Pull Request: слияние результата, PR/MR у провайдера, статус CI и круг доработки по замечаниям.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { c } from '../agents/common.js';
import { forgeFor, forgeOfRun, originOf, parseRemote, resolveForge, type Forge } from '../forge.js';
import { Git } from '../git.js';
import { pushBranch } from '../github.js';
import { isRunBranch } from '../ids.js';
import type { Kernel } from '../kernel.js';

import type { MergeCheck, PrDetails, PrFollowupItem, PrStatus, RunFile, RunRepo } from '../types.js';
import { getChangeDocs } from './runs.js';
import { copyEnvFiles, envFilesOf } from './workspace.js';
const MULTI_ROUND = 'В проекте из нескольких репозиториев новый круг по PR пока не поддерживается — поставьте доработку новой задачей.';

/** null — PR/MR создать можно; иначе причина, почему нет (нет CLI провайдера, хост не настроен…). */
export async function prReady(k: Kernel, id: string): Promise<string | null> {
  const r = k.mustLoad(id);
  return (await resolveForge(k, r.projectPath)).reason;
}

/** Прогоны, для которых PR/MR уже создаётся: двойной клик не должен породить второй push и create. */
const opening = new Set<string>();

export async function openPr(k: Kernel, id: string, base: string) {
  if (opening.has(id)) throw new Error('PR/MR уже создаётся');
  opening.add(id);
  try {
    await openPrOnce(k, id, base);
  } finally {
    opening.delete(id);
  }
}

async function openPrOnce(k: Kernel, id: string, base: string) {
  const r = k.mustLoad(id);
  if (r.status !== 'finished') throw new Error('PR можно открыть только для завершённого прогона');
  if (r.pr) throw new Error(`PR уже открыт: ${r.pr.url}`);
  if (!base.trim()) throw new Error('Выберите ветку, в которую открыть PR');
  const tools = await k.tools(['git']);
  const { forge, reason } = await resolveForge(k, r.projectPath);
  if (reason || !forge) throw new Error(reason ?? 'Нет провайдера PR');
  k.log(r, c.sky(`$ git push -u origin ${r.branch}`) + '\n');
  await pushBranch(tools.git, r.projectPath, r.branch, k.opts.env);
  const bodyFile = path.join(os.tmpdir(), `purpleflow-pr-${r.id}.md`);
  fs.writeFileSync(bodyFile, await prBody(k, r));
  try {
    const pr = await forge.create(r.projectPath, { base, head: r.branch, title: r.title, bodyFile });
    r.pr = { ...pr, base, createdAt: new Date().toISOString(), kind: forge.kind, host: forge.host };
    k.save(r);
    k.log(r, c.mint(`✓ PR #${pr.number}: ${pr.url}`) + '\n');
    await openRepoPrs(k, r, forge, base, bodyFile);
  } finally {
    fs.rmSync(bodyFile, { force: true });
  }
}

/** Изменённые участники проекта из нескольких репозиториев (у основного свой учёт). */
const changedExtras = (r: RunFile) => (r.repos ?? []).filter((x) => x.commit && x.commit !== x.baseCommit);

/** Ветка участника, куда вливать: та же, что у основного, если есть, иначе та, на которой он был при старте. */
async function extraTarget(git: Git, x: RunRepo, target: string): Promise<string> {
  const { branches } = await git.branches(x.path);
  const t = branches.includes(target) ? target : x.baseBranch && branches.includes(x.baseBranch) ? x.baseBranch : null;
  if (!t) throw new Error(`В репозитории ${x.rel} нет ни ветки ${target}, ни ${x.baseBranch ?? 'исходной'} — влейте ${x.rel} вручную`);
  return t;
}

/**
 * Провайдер участника проекта из нескольких репозиториев: участник — не проект, своих настроек у него нет.
 * Origin на том же хосте, что у основного, — тот же провайдер (self-hosted GitLab без подтверждения); иначе — по его origin.
 */
async function extraForge(k: Kernel, main: Forge, x: RunRepo): Promise<{ forge: Forge | null; reason: string | null }> {
  const origin = await originOf(k, x.path).catch(() => null);
  const host = origin ? parseRemote(origin)?.host.replace(/:\d+$/, '') : null;
  if (host && host === main.host.replace(/:\d+$/, '')) {
    const forge = forgeFor(k, { kind: main.kind, host: main.host });
    return { forge, reason: forge ? await forge.readiness(x.path) : 'Нет CLI провайдера' };
  }
  return resolveForge(k, x.path);
}

/** PR/MR в остальных изменённых репозиториях — с тем же описанием; не вышло в одном — предупреждаем и идём дальше. */
async function openRepoPrs(k: Kernel, r: RunFile, main: Forge, base: string, bodyFile: string) {
  const tools = await k.tools(['git']);
  const git = new Git(tools.git, k.opts.env);
  for (const x of changedExtras(r)) {
    if (x.pr) continue;
    try {
      const { forge, reason } = await extraForge(k, main, x);
      if (reason || !forge) throw new Error(reason ?? 'Нет провайдера PR');
      const into = await extraTarget(git, x, base);
      k.log(r, c.sky(`$ git push -u origin ${r.branch}  # ${x.rel}`) + '\n');
      await pushBranch(tools.git, x.path, r.branch, k.opts.env);
      const pr = await forge.create(x.path, { base: into, head: r.branch, title: r.title, bodyFile });
      x.pr = { url: pr.url, number: pr.number, base: into, kind: forge.kind, host: forge.host };
      k.save(r);
      k.log(r, c.mint(`✓ ${x.rel}: PR #${pr.number}: ${pr.url}`) + '\n');
    } catch (e) {
      k.warn(r, `PR в ${x.rel} не открыт: ${(e as Error).message}`);
    }
  }
}

/** Описание PR: задача, итог исполнителя, план, проверки, ревью и визуальная проверка — из прогона. */
export async function prBody(k: Kernel, r: RunFile): Promise<string> {
  const docs = await getChangeDocs(k, r.id).catch(() => null);
  const impl = [...r.attempts].reverse().find((a) => a.stage === 'implement' && a.output)?.output;
  const lastTest = r.tests.at(-1);
  const review = r.reviews.at(-1);
  const visual = r.visuals?.at(-1);
  const parts: string[] = [`## Задача\n\n${r.task}`];
  if (impl) parts.push(`## Что сделано\n\n${impl.slice(0, 4000)}`);
  if (docs?.proposal) parts.push(`## План (OpenSpec \`${r.changeId}\`)\n\n${docs.proposal.replace(/^#\s+.*\n+/, '').slice(0, 4000)}`);
  if (lastTest?.checks?.length) {
    parts.push(
      `## Проверки\n\n${lastTest.checks.map((x) => `- ${x.kind === 'lint' ? 'Линтер' : 'Тесты'}: ${x.unstable ? '⚠️ нестабильные, не из‑за задачи' : x.passed ? '✅' : x.preexisting ? '⚠️ красные и до задачи, новых ошибок нет' : '❌'} \`${x.command}\``).join('\n')}`,
    );
  }
  if (review) {
    const notes = review.notes.map((n) => `- ${n.file ? `\`${n.file}${n.line ? ':' + n.line : ''}\` — ` : ''}${n.message}`).join('\n');
    parts.push(
      `## Ревью (${r.agents.reviewer})\n\n${review.blocking.length ? `Блокирующих: ${review.blocking.length}` : 'Блокирующих замечаний нет.'}${notes ? `\n\nЗаметки:\n${notes}` : ''}`,
    );
  }
  if (review?.plan?.length) {
    const mark = { done: '✅', partial: '◐', missing: '❌' } as const;
    parts.push(
      `## План → факт\n\n${review.plan.map((p) => `- ${mark[p.status]} ${p.task}${p.status !== 'done' && p.note ? ` — ${p.note}` : ''}`).join('\n')}`,
    );
  }
  if (visual) {
    parts.push(
      `## Визуальная проверка\n\n${visual.unverified ? `⚠️ Проверить не удалось: ${visual.unverified}` : visual.blocking.length ? `Проблем: ${visual.blocking.length}` : '✅ В браузере всё выглядит верно'}${visual.passed?.length ? `\n\nПроверено:\n${visual.passed.map((x) => `- ${x}`).join('\n')}` : ''}${visual.shots.length ? `\n\nСкриншоты (${visual.shots.length}) — в PurpleFlow:\n${visual.shots.map((s) => `- ${s.caption}`).join('\n')}` : ''}`,
    );
  }
  parts.push(`---\nСделано в PurpleFlow · режим «${r.mode}» · прогон \`${r.id.slice(0, 8)}\``);
  return parts.join('\n\n');
}

export async function getPrStatus(k: Kernel, id: string): Promise<PrStatus | null> {
  const r = k.mustLoad(id);
  const forge = forgeOfRun(k, r);
  if (!r.pr || !forge) return null;
  const st = await forge.status(r.projectPath, r.pr.url);
  // Влили у провайдера (из приложения или руками) — отмечаем у прогона.
  if (st.state === 'MERGED' && !r.merged) {
    r.merged = { into: r.pr.base, commit: st.mergeCommit ?? '', at: new Date().toISOString() };
    k.save(r);
  }
  return st;
}

/** PR с замечаниями — по запросу со вкладки «Pull Request» (без фонового опроса). */
export async function getPrDetails(k: Kernel, id: string): Promise<PrDetails | null> {
  const r = k.mustLoad(id);
  const forge = forgeOfRun(k, r);
  if (!r.pr || !forge) return null;
  const [status, c] = await Promise.all([getPrStatus(k, id), forge.comments(r.projectPath, r.pr.url)]);
  if (!status) return null;
  const checks = (status.failedChecks ?? []).map((x, i) => ({
    id: `check:${x.name}:${i}`,
    kind: 'check' as const,
    author: 'CI',
    body: x.name,
    at: new Date().toISOString(),
    url: x.url ?? undefined,
  }));
  return { title: c.title, status, comments: [...checks, ...c.comments], fetchedAt: new Date().toISOString() };
}

/**
 * Доработка по замечаниям PR — новый круг в том же прогоне: реализация → проверки → ревью → приёмка → коммит и push в ветку PR.
 * Запускается только человеком.
 */
export async function prFollowup(k: Kernel, id: string, items: PrFollowupItem[], note?: string) {
  const r = k.mustLoad(id);
  if (!r.pr) throw new Error('У прогона нет PR');
  if (r.status !== 'finished') throw new Error('Доработку можно начать, когда прогон завершён');
  if (r.merged) throw new Error('PR уже влит — для новых правок создайте новую задачу');
  if (!items.length && !note?.trim()) throw new Error('Выберите замечания или опишите, что доработать');
  if (r.repos?.length) throw new Error(MULTI_ROUND);
  const { git, pulled } = await reopenWorkspace(k, r);

  // Логи упавших проверок CI — исполнителю, чтобы не гадать, что сломалось.
  const forge = forgeOfRun(k, r);
  const lines: string[] = [];
  for (const it of items) {
    if (it.kind === 'check') {
      const log = forge && it.url ? await forge.failedJobLog(r.projectPath, it.url).catch(() => null) : null;
      lines.push(`- Упала проверка CI «${it.body}»${it.url ? ` (${it.url})` : ''}${log ? `. Хвост лога:\n\`\`\`\n${log}\n\`\`\`` : ''}`);
    } else {
      const where = it.path ? `${it.path}${it.line ? `:${it.line}` : ''}` : it.kind === 'review' ? 'итог ревью' : 'комментарий к PR';
      lines.push(`- ${where} — @${it.author}: ${it.body.trim()}`);
    }
  }
  const round = (r.prRound ?? 1) + 1;
  r.prRound = round;
  r.roundBase = await git.head(r.worktreePath);
  r.prRounds = [...(r.prRounds ?? []), { round, at: new Date().toISOString(), items, note: note?.trim() || undefined }];
  r.feedback = {
    source: 'human',
    text: [
      `Задача уже сделана и отправлена в Pull Request #${r.pr.number}${r.archivedPath ? ' (изменение OpenSpec в архиве — tasks.md не трогай)' : ''}. Ревьюеры оставили замечания — отработай только их, остальное не переделывай.`,
      'Если замечание — вопрос или с ним нельзя согласиться, не меняй код, а объясни это в отчёте.',
      lines.length ? `Замечания:\n${lines.join('\n')}` : '',
      note?.trim() ? `Комментарий человека:\n${note.trim()}` : '',
    ]
      .filter(Boolean)
      .join('\n\n'),
  };
  r.status = 'running';
  r.next = 'implement';
  r.finishedAt = undefined;
  r.message = undefined;
  r.implAttemptsLimit = r.implAttemptsUsed + 3;
  k.log(
    r,
    '\n' +
      c.violet(c.bold(`━━ Доработка по PR #${r.pr.number} · круг ${round}`)) +
      '\n' +
      c.dim(`замечаний: ${items.length}${pulled === 'updated' ? ' · подтянуты новые коммиты из ветки PR' : ''}`) +
      '\n',
  );
  k.save(r);
  k.emit({ type: 'run.updated', run: r });
  void k.engine.drive(r);
}

/** Рабочая копия завершённого прогона для нового круга: worktree могли удалить, проект в режиме «ветка» — переключить. */
export async function reopenWorkspace(k: Kernel, r: RunFile): Promise<{ git: Git; pulled: 'updated' | 'same' | 'diverged' | 'no-remote' }> {
  const tools = await k.tools(['git']);
  const git = new Git(tools.git, k.opts.env);

  // Рабочая копия: worktree могли удалить при очистке, в режиме «ветка» проект мог уйти на другую ветку.
  if (r.workspace === 'branch') {
    const cur = await git.currentBranch(r.projectPath);
    if (cur !== r.branch) {
      const dirty = await git.dirtyFiles(r.projectPath);
      if (dirty.length)
        throw new Error(
          `В проекте есть незакоммиченные изменения (${dirty.length}) — закоммитьте или уберите их, чтобы переключиться на ${r.branch}`,
        );
      await git.checkout(r.projectPath, r.branch);
    }
  } else if (r.worktreeRemoved || !fs.existsSync(r.worktreePath)) {
    await git.addWorktreeAt(r.projectPath, r.worktreePath, r.branch);
    r.worktreeRemoved = undefined;
    // Сразу на диск: ошибка дальше (pull, слияние) иначе оставит флаг, и следующая попытка упрётся в «already exists».
    k.save(r);
    copyEnvFiles(k, r);
  }
  const pulled = await git.pullFastForward(r.worktreePath, r.branch);
  if (pulled === 'diverged')
    throw new Error(`Ветка ${r.branch} у провайдера разошлась с локальной — подтяните изменения вручную (git pull) и повторите`);
  return { git, pulled };
}

/**
 * «Обновить ветку»: влить свежую базовую ветку PR в ветку прогона.
 * Без конфликтов — проверки и push; с конфликтами — исполнитель разрешает их, затем проверки и приёмка.
 */
export async function updateBranch(k: Kernel, id: string) {
  const r = k.mustLoad(id);
  if (!r.pr) throw new Error('У прогона нет PR');
  if (r.status !== 'finished') throw new Error('Обновить ветку можно, когда прогон завершён');
  if (r.merged) throw new Error('PR уже влит');
  if (r.repos?.length) throw new Error(MULTI_ROUND);
  const { git } = await reopenWorkspace(k, r);
  const base = r.pr.base;
  await git.fetchRef(r.worktreePath, base);
  const round = (r.prRound ?? 1) + 1;
  r.roundBase = await git.head(r.worktreePath);
  const m = await git.mergeRef(r.worktreePath, 'FETCH_HEAD', `Merge ${base} в ${r.branch}`);
  if (!m.changed) {
    k.log(r, c.dim(`ветка ${r.branch} уже содержит всё из ${base} — обновлять нечего`) + '\n');
    throw new Error(`Ветка уже содержит всё из ${base}`);
  }
  r.diffFrom = await git.revParse(r.worktreePath, 'FETCH_HEAD');
  r.prRound = round;
  r.prRounds = [
    ...(r.prRounds ?? []),
    {
      round,
      at: new Date().toISOString(),
      items: [],
      kind: 'update',
      conflicts: m.conflicts.length ? m.conflicts : undefined,
      note: `Обновление из ${base}`,
    },
  ];
  r.status = 'running';
  r.finishedAt = undefined;
  r.message = undefined;
  k.log(r, '\n' + c.violet(c.bold(`━━ Обновление ветки из ${base} · круг ${round}`)) + '\n');
  if (m.conflicts.length) {
    r.roundFiles = m.conflicts;
    r.mergeOnly = undefined;
    r.next = 'implement';
    r.implAttemptsLimit = r.implAttemptsUsed + 3;
    r.feedback = {
      source: 'validator',
      text: [
        `Идёт слияние свежей ветки ${base} в ветку задачи ${r.branch} — в файлах конфликты. Задача уже сделана; сейчас нужно только разрешить конфликты.`,
        `Файлы с конфликтами:\n${m.conflicts.map((f) => `- ${f}`).join('\n')}`,
        `Разреши каждый конфликт так, чтобы сохранились и изменения из ${base}, и изменения задачи. Убери все маркеры <<<<<<< ======= >>>>>>>. Если ${base} что-то переименовал или поменял API — подстрой под это код задачи.`,
        'Не выполняй git commit, git merge --abort и git reset — слияние завершит оркестратор после проверок.',
      ].join('\n\n'),
    };
    k.log(r, c.amber(`! конфликты: ${m.conflicts.join(', ')} — их разрешит исполнитель`) + '\n');
  } else {
    r.roundFiles = undefined;
    r.mergeOnly = true;
    r.next = 'tests';
    k.log(r, c.mint(`✓ ${base} влита без конфликтов — проверки и отправка в PR`) + '\n');
  }
  k.save(r);
  k.emit({ type: 'run.updated', run: r });
  void k.engine.drive(r);
}

export async function mergePrOf(k: Kernel, id: string) {
  const r = k.mustLoad(id);
  const forge = forgeOfRun(k, r);
  if (!r.pr || !forge) throw new Error('У прогона нет PR');
  await forge.merge(r.projectPath, r.pr.url);
  k.log(r, c.mint(`✓ PR #${r.pr.number} влит в ${r.pr.base}`) + '\n');
  await getPrStatus(k, id);
}

/** Ветки репозитория пользователя для слияния результата. */
export async function listBranches(
  k: Kernel,
  id: string,
): Promise<{ branches: string[]; current: string | null; suggested: string | null }> {
  const r = k.mustLoad(id);
  const tools = await k.tools(['git']);
  const b = await new Git(tools.git, k.opts.env).branches(r.projectPath);
  const branches = b.branches.filter((x) => x !== r.branch && !isRunBranch(x));
  // Куда вливать по умолчанию: ветка, от которой начинали задачу, иначе main/master, иначе текущая.
  const from = r.baseBranch?.replace(/^origin\//, '');
  const suggested = [from, 'main', 'master', b.current].find((x): x is string => Boolean(x && branches.includes(x))) ?? branches[0] ?? null;
  return { branches, current: b.current, suggested };
}

/** Изменённые прогоном файлы основного репозитория: служебное OpenSpec и файлы окружения не в счёт. */
async function runFiles(k: Kernel, git: Git, r: RunFile): Promise<string[]> {
  if (r.workspacePending || (r.worktreeRemoved && r.status !== 'finished')) return [];
  const env = new Set(envFilesOf(k, r));
  const files =
    r.status === 'finished'
      ? await git.namesBetween(r.projectPath, r.baseCommit, r.branch)
      : await git.changedFiles(r.worktreePath, r.baseCommit);
  return files.filter((f) => !f.startsWith('openspec/') && !env.has(f));
}

/** Прогоны, которые ещё могут попасть в ту же ветку: идут, ждут решения или завершены, но не влиты. */
const PENDING = new Set(['running', 'waiting', 'stopped', 'queued']);
const FRESH_MS = 14 * 24 * 3600_000;

/**
 * Перед влитием: насколько целевая ветка ушла вперёд с начала задачи, где будут конфликты
 * (у завершённого — пробным слиянием, у идущего — по пересечению файлов) и какие другие прогоны правят те же файлы.
 * Только основной репозиторий проекта; ничего не меняет.
 */
export async function mergeCheck(k: Kernel, id: string, target?: string): Promise<MergeCheck | null> {
  const r = k.mustLoad(id);
  if (r.merged || r.status === 'cancelled') return null;
  const into = target?.trim() || (await listBranches(k, id)).suggested;
  if (!into) return null;
  const git = new Git((await k.tools(['git'])).git, k.opts.env);
  const targetSha = await git.revParse(r.projectPath, into).catch(() => '');
  if (!targetSha) return null;
  const ours = await runFiles(k, git, r).catch(() => [] as string[]);
  const mine = new Set(ours);
  const behind = await git.countAhead(r.projectPath, r.baseCommit, targetSha).catch(() => 0);
  let conflicts: string[] = [];
  let exact = false;
  if (behind > 0) {
    const exactConflicts = r.status === 'finished' ? await git.mergeConflicts(r.projectPath, targetSha, r.branch).catch(() => null) : null;
    if (exactConflicts) {
      conflicts = exactConflicts;
      exact = true;
    } else {
      const theirs = await git.namesBetween(r.projectPath, r.baseCommit, targetSha).catch(() => [] as string[]);
      conflicts = theirs.filter((f) => mine.has(f));
    }
  }
  const overlaps: MergeCheck['overlaps'] = [];
  if (mine.size) {
    const others = k.store
      .list()
      .filter(
        (s) =>
          s.id !== r.id &&
          s.projectPath === r.projectPath &&
          // Завершённые, но не влитые — только свежие: брошенная месяц назад ветка уже никуда не пойдёт.
          (PENDING.has(s.status) || (s.status === 'finished' && Date.now() - Date.parse(s.updatedAt) < FRESH_MS)),
      )
      .slice(0, 12);
    for (const s of others) {
      const o = k.store.load(s.id);
      if (!o || o.merged || (o.status === 'finished' && !o.commit)) continue;
      const files = (await runFiles(k, git, o).catch(() => [] as string[])).filter((f) => mine.has(f));
      if (files.length) overlaps.push({ runId: o.id, title: o.title, files });
    }
  }
  return { target: into, behind, conflicts, exact, overlaps };
}

/**
 * Режим «Ветка»: после завершения проект остаётся на ветке прогона, и следующая задача начиналась бы от неё.
 * Влили — переключаем проект на ветку, куда влили (в ней уже вся работа). С правками в рабочей копии не трогаем.
 */
async function leaveRunBranch(k: Kernel, git: Git, r: RunFile, target: string) {
  if (r.workspace !== 'branch') return;
  const cur = await git.currentBranch(r.projectPath).catch(() => null);
  if (cur !== r.branch) return;
  if (await git.hasTrackedChanges(r.projectPath).catch(() => true)) {
    k.log(r, c.amber(`! проект остался на ${r.branch}: в рабочей копии есть правки. Переключитесь сами: git checkout ${target}`) + '\n');
    return;
  }
  await git
    .checkout(r.projectPath, target)
    .then(() => k.log(r, c.dim(`проект переключён на ${target}`) + '\n'))
    .catch((e) => k.log(r, c.amber(`! не удалось переключить проект на ${target}: ${(e as Error).message}`) + '\n'));
}

/** Влить ветку прогона в выбранную ветку репозитория пользователя (решение человека). */
export async function merge(k: Kernel, id: string, target: string) {
  const r = k.mustLoad(id);
  if (r.status !== 'finished') throw new Error('Влить можно только завершённый прогон');
  if (!target.trim()) throw new Error('Выберите ветку');
  const tools = await k.tools(['git']);
  const git = new Git(tools.git, k.opts.env);
  // Повтор после сбоя в одном из участников: основной уже влит — вливаем только оставшиеся.
  if (!r.merged) {
    const sha = await git.merge(r.projectPath, r.branch, target, `Merge ${r.branch}: ${r.title}`, k.store.worktreesDir());
    r.merged = { into: target, commit: sha, at: new Date().toISOString() };
    k.save(r);
    k.log(r, c.mint(`✓ ${r.root ? `${r.root.main}: ` : ''}${r.branch} влита в ${target} (${sha.slice(0, 8)})`) + '\n');
    await leaveRunBranch(k, git, r, target);
  }
  const failed: string[] = [];
  for (const x of changedExtras(r)) {
    if (x.merged) continue;
    try {
      const into = await extraTarget(git, x, target);
      const sha = await git.merge(x.path, r.branch, into, `Merge ${r.branch}: ${r.title}`, k.store.worktreesDir());
      x.merged = { into, commit: sha, at: new Date().toISOString() };
      k.save(r);
      k.log(r, c.mint(`✓ ${x.rel}: ${r.branch} влита в ${into} (${sha.slice(0, 8)})`) + '\n');
    } catch (e) {
      failed.push(`${x.rel}: ${(e as Error).message}`);
    }
  }
  if (failed.length) throw new Error(`Не влиты:\n${failed.join('\n')}\nИсправьте и нажмите «Влить» ещё раз — уже влитые не тронем.`);
}
