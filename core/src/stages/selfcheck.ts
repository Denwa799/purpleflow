// Самопроверка исполнителя: приложение из рабочей копии и браузер (pw) на время стадии «Реализация».
import fs from 'node:fs';
import path from 'node:path';
import { c, crlf } from '../agents/common.js';
import { prependPath } from '../env.js';
import type { Kernel } from '../kernel.js';
import { expandPorts, portEnv, waitForUrl } from '../net.js';
import { killGroup, run as runProc } from '../proc.js';
import { workDir } from '../services/repos.js';
import { prepareApp } from '../services/workspace.js';
import type { RunFile } from '../types.js';
import { closePw, writePw } from './visual.js';

export interface SelfCheck {
  /** Блок для промпта исполнителя: адрес приложения, папка скриншотов, что проверять. */
  block: string;
  /** Окружение агента: pw в PATH. */
  env: NodeJS.ProcessEnv;
  stop(): Promise<void>;
}

/**
 * Включается вместе с визуальной проверкой прогона: у проекта есть команда запуска и адрес, и человек согласился
 * поднимать приложение. codex — нет: песочница workspace-write без сети и записи вне рабочей копии, npx и браузер не запустятся.
 */
export function selfCheckReason(run: Pick<RunFile, 'visual' | 'runCommand' | 'appUrl' | 'agents'>): 'on' | 'off' | 'codex' {
  if (!run.visual || !run.runCommand?.trim() || !run.appUrl?.trim()) return 'off';
  return run.agents.executor === 'codex' ? 'codex' : 'on';
}

/**
 * Поднять приложение в фоне (подготовка из команд проекта, затем команда запуска на свободном порту) и выдать
 * исполнителю pw. Агента не ждём: он пишет код, а к экрану приходит, когда приложение уже отвечает.
 * Сервер — в группе `${id}:server`: «Стоп» прогона гасит его вместе со стадией.
 */
export async function startSelfCheck(k: Kernel, run: RunFile, attempt: number): Promise<SelfCheck | null> {
  const why = selfCheckReason(run);
  if (why === 'codex') {
    k.log(run, c.dim('Самопроверка в браузере недоступна codex: его песочница не пускает в сеть.') + '\n');
    return null;
  }
  if (why === 'off') return null;
  // Рядом с папками визуальной проверки: удаление прогона убирает и их.
  const dir = path.join(k.opts.dataDir, 'visual', run.id, `self-${attempt}`);
  fs.mkdirSync(dir, { recursive: true });
  const session = `purpleflow-self-${run.id.slice(0, 8)}`;
  writePw(dir, session);
  const { port, url, command } = await expandPorts(run.appUrl!, run.runCommand!);
  const group = `${run.id}:server`;
  let stopped = false;
  const log = (t: string) => k.log(run, c.dim(crlf(t)), false);
  void (async () => {
    try {
      await prepareApp(k, { repo: run.projectPath, cwd: workDir(run), group, onOutput: log });
      if (stopped) return;
      k.log(run, c.sky(`$ ${command}`) + c.dim(`  # приложение для самопроверки на ${url}`) + '\n');
      let exited = false;
      void runProc(command, [], {
        cwd: workDir(run),
        env: { ...k.opts.env, ...portEnv(run.runCommand!, port), BROWSER: 'none', CI: '1' },
        shell: true,
        group,
        waitForOutput: true,
        onStdout: log,
        onStderr: log,
      }).then(() => {
        exited = true;
      });
      const ready = await waitForUrl(url, 120_000, () => exited || stopped);
      if (!stopped)
        k.log(
          run,
          (ready
            ? c.mint(`✓ приложение для самопроверки отвечает на ${url}`)
            : c.dim(`приложение для самопроверки не ответило на ${url}`)) + '\n',
        );
    } catch (e) {
      if (!stopped) k.log(run, c.dim(`самопроверка: приложение не поднялось — ${(e as Error).message.split('\n')[0]}`) + '\n');
    }
  })();
  return {
    block: k.prompts.render('selfcheck.md', { url, dir }),
    env: prependPath(k.opts.env, dir),
    async stop() {
      stopped = true;
      await closePw(k, dir, session, `${run.id}:visual-cleanup`);
      await killGroup(group);
    },
  };
}
