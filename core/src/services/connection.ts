// Проверка подключения агентов с текущими настройками прокси и моделей.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { stripAnsi } from '../agents/common.js';
import { detectTools, prependPath } from '../env.js';
import { run } from '../proc.js';
import type { Kernel } from '../kernel.js';
import type { AgentKind, ConnectionCheck, Role } from '../types.js';
import { DEFAULT_AGENTS, enabledAgents } from '../types.js';

/** Тестовый запрос каждым агентом с текущими настройками прокси и моделей. */
export async function testConnection(k: Kernel): Promise<ConnectionCheck[]> {
  const s = k.opts.getSettings();
  const found = await detectTools(k.opts.env, s.toolPaths);
  const present = enabledAgents(s).filter((a) => found[a].path && !found[a].error);
  if (!present.length) {
    const on = enabledAgents(s);
    throw new Error(
      on.length === 1 ? `Не найден ${on[0]}. Укажите путь в настройках.` : 'Не найдены ни claude, ни codex. Укажите пути в настройках.',
    );
  }
  const tools: Record<AgentKind, string> = { claude: found.claude.path!, codex: found.codex.path!, opencode: found.opencode.path! };
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'purpleflow-check-'));
  const proxy = s.proxy.baseUrl ? s.proxy : undefined;
  const prompt = 'Это проверка подключения. Ответь ровно одним словом: готово';
  const one = async (agent: AgentKind): Promise<ConnectionCheck> => {
    const t0 = Date.now();
    // Модель — из первой роли, которую выполняет этот агент.
    const agents = { ...DEFAULT_AGENTS, ...s.agents };
    const role = (['planner', 'executor', 'reviewer'] as Role[]).find((x) => agents[x] === agent);
    const model = role ? s.models[role] : '';
    const base = {
      bin: tools[agent],
      cwd: dir,
      env: k.opts.env,
      prompt,
      model,
      timeoutMs: 120_000,
      group: `check-${agent}`,
      onOutput: () => {},
      proxy,
      claudeAuth: s.claudeAuth,
    };
    const r =
      agent === 'claude'
        ? await k.claude(base)
        : agent === 'opencode'
          ? await k.opencode({ ...base, readOnly: true })
          : await k.codex({ ...base, sandbox: 'read-only' });
    return {
      agent,
      ok: r.ok,
      model: model || 'по умолчанию',
      durationMs: Date.now() - t0,
      reply: r.text.trim().slice(0, 200),
      error: r.error,
    };
  };
  try {
    return await Promise.all(present.map(one));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

let modelsCache: { bin: string; at: number; list: Promise<string[]> } | null = null;

/**
 * Модели opencode: `opencode models` — провайдеры, которые пользователь подключил сам (opencode auth login, конфиг),
 * и бесплатные opencode/*. Список держим минуту: подсказки нужны на каждом экране моделей.
 */
export async function listOpencodeModels(k: Kernel): Promise<string[]> {
  if (!(await k.hasTool('opencode'))) return [];
  const bin = (await k.tools(['opencode'])).opencode;
  if (modelsCache?.bin === bin && Date.now() - modelsCache.at < 60_000) return modelsCache.list;
  const list = run(bin, ['models'], { cwd: os.homedir(), env: prependPath(k.opts.env, path.dirname(bin)), timeoutMs: 30_000 }).then((r) =>
    r.code === 0
      ? [
          ...new Set(
            stripAnsi(r.stdout)
              .split('\n')
              .map((l) => l.trim())
              .filter((l) => /^[\w.-]+\/\S+$/.test(l)),
          ),
        ]
      : [],
  );
  modelsCache = { bin, at: Date.now(), list };
  list.catch(() => (modelsCache = null));
  return list;
}
