import { run } from '../proc.js';
import {
  addUsage,
  c,
  cleanEnv,
  clip,
  crlf,
  defined,
  emptyUsage,
  explainError,
  plainOutput,
  stripAnsi,
  type AgentResult,
  type AgentRunOptions,
  type AgentStep,
} from './common.js';
import { toolName, toolView } from './tools.js';

export interface AgyOptions extends AgentRunOptions {
  /** Стадия не меняет файлы (уточнение, ревью, служебное). */
  readOnly?: boolean;
  /** Продолжить сохранённую беседу: agy --conversation <id>. */
  resumeConversation?: string;
}

/**
 * Промпт уходит аргументом `-p`: так agy запускается во всех версиях. Длинный промпт
 * на Windows не влезает в лимит командной строки — тогда он идёт потоком в stdin
 * (--input-format stream-json), как это делает agy в многошаговых сессиях.
 */
const ARGV_LIMIT = 8000;

/**
 * Флаги agy 1.x. Права снимаются всегда: в headless-режиме подтвердить действие некому,
 * и без флага любой вызов инструмента ждёт ответа человека до таймаута, а не отклоняется.
 * Стадии только для чтения ограничивает промпт: у agy нет ни списка инструментов флагом,
 * ни отдельного конфига для запуска — правила прав живут в общих настройках пользователя.
 */
export function agyArgs(o: Pick<AgyOptions, 'model' | 'effort' | 'addDirs' | 'resumeConversation'>, streamInput = false): string[] {
  const args = ['--output-format', 'stream-json', '--dangerously-skip-permissions'];
  if (streamInput) args.push('--input-format', 'stream-json');
  if (o.resumeConversation) args.push('--conversation', o.resumeConversation);
  if (o.model) args.push('--model', o.model);
  if (o.effort) args.push('--effort', o.effort);
  for (const d of o.addDirs ?? []) args.push('--add-dir', d);
  return args;
}

/** Промпт стадии: системная часть у agy отдельного флага не имеет — она идёт тем же текстом. */
export function agyPrompt(o: Pick<AgyOptions, 'prompt' | 'systemPrompt' | 'readOnly'>): string {
  const parts = [o.systemPrompt, o.prompt].filter(Boolean) as string[];
  // Права сняты флагом, поэтому «только чтение» держится на этом запрете — как redirect у claude.
  if (o.readOnly) parts.push('Работай только на чтение: не создавай и не меняй файлы, не выполняй команды, меняющие проект.');
  return parts.join('\n\n---\n\n');
}

/** Аргументы и stdin одного запуска. */
export function agyInput(
  o: Pick<AgyOptions, 'prompt' | 'systemPrompt' | 'readOnly' | 'model' | 'effort' | 'addDirs' | 'resumeConversation'>,
  platform: NodeJS.Platform = process.platform,
) {
  const prompt = agyPrompt(o);
  const stream = platform === 'win32' && prompt.length > ARGV_LIMIT;
  // Промпт идёт сразу за -p: так проверено на живом agy 1.4.7 (флаги после промпта он принимает).
  return {
    args: stream ? agyArgs(o, true) : ['-p', prompt, ...agyArgs(o)],
    input: stream ? `${JSON.stringify({ event: 'user', message: { content: prompt } })}\n` : undefined,
  };
}

type Part = Record<string, unknown>;

/** Имена инструментов agy → привычные по claude, чтобы чат показывал их так же. */
const TOOL_NAMES: Record<string, string> = {
  run_command: 'Bash',
  read_file: 'Read',
  write_to_file: 'Write',
  edit_file: 'Edit',
  replace_file_content: 'Edit',
  list_directory: 'LS',
  grep_search: 'Grep',
  glob_search: 'Glob',
  search_web: 'WebSearch',
  read_url: 'WebFetch',
  invoke_subagent: 'Task',
};

/** Аргументы agy → имена claude: главный аргумент должен найти toolView. */
export function agyToolInput(params: Part): Part {
  const out: Part = { ...params };
  const move = (from: string, to: string) => {
    if (params[from] != null) out[to] = params[from];
    delete out[from];
  };
  move('CommandLine', 'command');
  move('TargetFile', 'file_path');
  move('AbsolutePath', 'file_path');
  move('DirectoryPath', 'path');
  move('CodeContent', 'content');
  move('Query', 'pattern');
  return out;
}

/** Строка шага: имя инструмента в общем виде — для живого лога. */
function describeTool(name: string, params: Part): string {
  const { text } = toolView(TOOL_NAMES[name] ?? name, agyToolInput(params));
  return text;
}

/** Шаги чата по событию stream-json: текст, размышления, вызов инструмента с итогом. */
export function agySteps(ev: Record<string, unknown>): AgentStep[] {
  if (ev.event === 'step_update') {
    const s = (ev.step_update ?? {}) as Part;
    const id = `${String(s.conversation_id ?? '')}:${String(s.step_index ?? '')}`;
    const text = typeof s.text_delta === 'string' ? s.text_delta : '';
    if (s.step_type === 'agent_response' && text) return [{ kind: 'text', text, delta: true }];
    if (s.step_type === 'thinking' && text) return [{ kind: 'thinking', text, delta: true }];
    if (s.step_type === 'tool') {
      const info = (s.tool_info ?? {}) as Part;
      const name = String(s.tool_name ?? info.name ?? 'tool');
      const params = (info.parameters ?? {}) as Part;
      const steps: AgentStep[] = [
        defined({
          kind: 'tool' as const,
          id,
          text: describeTool(name, params) || toolName(name),
          detail: plainOutput(JSON.stringify(params)) || undefined,
        }),
      ];
      if (s.state === 'DONE') {
        const failed = info.error != null;
        const output = failed ? String((info.error as Part)?.message ?? '') : String(info.output ?? '');
        steps.push(defined({ kind: 'tool_result', id, ok: !failed, output: plainOutput(output) || undefined }));
      }
      return steps;
    }
    if (s.step_type === 'error_message') return [{ kind: 'notice', level: 'error', text: 'agy: шаг завершился ошибкой' }];
    return [];
  }
  if (ev.event === 'init') {
    const ini = (ev.init ?? {}) as Part;
    return [
      defined({
        kind: 'meta' as const,
        model: typeof ini.model === 'string' ? ini.model : undefined,
        cwd: typeof ini.cwd === 'string' ? ini.cwd : undefined,
        contextWindow: undefined,
      }),
    ];
  }
  return [];
}

/** Токены из usage события: у agy имена полей с суффиксом _tokens. */
function usageOf(u: Part | undefined) {
  return {
    input: Number(u?.input_tokens ?? 0) || 0,
    output: (Number(u?.output_tokens ?? 0) || 0) + (Number(u?.thinking_tokens ?? 0) || 0),
    cacheRead: Number(u?.cache_read_tokens ?? 0) || 0,
  };
}

const STATUS_ERRORS: Record<string, string> = {
  CANCELED: 'запуск отменён',
  INTERRUPTED: 'запуск прерван',
  INVALID: 'agy пришёл в недопустимое состояние',
  WAITING: 'agy ждал ответа, которого в headless-режиме не будет',
  RUNNING: 'agy не дошёл до конца ответа',
};

/** Сбой agy понятной фразой: у него свой вход в Google-аккаунт, ключа и прокси PurpleSchool нет. */
export function agyError(raw: string, status?: string): string {
  const t = raw.toLowerCase();
  if (/authentication required|not logged in|not signed in|sign in|login required|reauth/.test(t))
    return 'agy: нужен вход в аккаунт Antigravity. Выполните в терминале «agy» и войдите, либо укажите путь к своему запускателю в настройках.';
  if (/model.*(not specified|not recognized|unknown)|unknown model|invalid model/.test(t))
    return `agy: модель недоступна. Имя — из списка «agy models»; без модели headless-запуск не стартует.`;
  if (/quota|rate.?limit|resource_exhausted|\b429\b/.test(t)) return 'agy: исчерпан лимит запросов к моделям Antigravity. Повторите позже.';
  if (status && STATUS_ERRORS[status]) return `agy: ${STATUS_ERRORS[status]}`;
  const text = explainError('agy', raw, 'login');
  return text.replace(
    /Выполните в терминале «agy» и войдите в аккаунт[^.]*/,
    'Выполните в терминале «agy» и войдите в аккаунт Antigravity',
  );
}

/** Хвост stdout: строки ошибок из потока, без JSON-мусора и base64. */
function readableTail(stdout: string): string {
  const out: string[] = [];
  for (const l of stdout.split('\n').slice(-40)) {
    const t = l.trim();
    if (!t) continue;
    if (t.startsWith('{')) {
      try {
        const ev = JSON.parse(t) as { event?: string; result?: { error?: unknown }; step_update?: { step_type?: string } };
        const err = ev.result?.error;
        if (typeof err === 'string' && err) out.push(err);
      } catch {
        /* не JSON — попадёт ниже, если это текст ошибки */
      }
      continue;
    }
    if (!/^[A-Za-z0-9+/=]{80,}$/.test(t) && t.length < 600) out.push(t);
  }
  return out.slice(-5).join('\n');
}

export async function runAgy(o: AgyOptions): Promise<AgentResult> {
  const env = cleanEnv(o.env);
  let usage = emptyUsage();
  let finalText = '';
  /** Ответ — текст последнего шага, в котором он был: до него шли вызовы инструментов. */
  let stepText = '';
  let status = '';
  let resultError = '';
  let denied: string[] = [];
  let conversation = o.resumeConversation ?? '';
  const out = (s: string) => o.onOutput(crlf(s));

  const input = agyInput(o);
  const r = await run(o.bin, input.args, {
    cwd: o.cwd,
    env,
    input: input.input,
    timeoutMs: o.timeoutMs,
    idleTimeoutMs: o.idleTimeoutMs,
    group: o.group,
    onStdoutLine: (line) => {
      let ev: Record<string, unknown>;
      try {
        ev = JSON.parse(line);
      } catch {
        if (line.trim()) out(c.dim(stripAnsi(line)) + '\n');
        return;
      }
      if (ev.event === 'init') {
        const id = typeof ev.conversation_id === 'string' ? ev.conversation_id : '';
        const ini = (ev.init ?? {}) as Part;
        if (id && id !== conversation) {
          conversation = id;
          o.onSession?.(id);
        }
        out(c.dim(`● agy · ${String(ini.model ?? o.model ?? 'модель по умолчанию')}${o.readOnly ? ' · только чтение' : ''}`) + '\n');
      } else if (ev.event === 'step_update') {
        const s = (ev.step_update ?? {}) as Part;
        if (s.step_type === 'agent_response') {
          const t = typeof s.text_delta === 'string' ? s.text_delta : '';
          if (t) stepText = stepText ? `${stepText}${t}` : t;
          if (t.trim()) out(t);
        } else if (s.step_type === 'thinking' && s.text_delta) {
          out(c.dim(clip(String(s.text_delta), 500)) + '\n');
        } else if (s.step_type === 'tool' && s.state === 'DONE') {
          const info = (s.tool_info ?? {}) as Part;
          const params = (info.parameters ?? {}) as Part;
          out(c.violet('▸ ') + describeTool(String(info.name ?? s.tool_name ?? 'tool'), params) + '\n');
          if (info.error) out(c.coral(clip(String((info.error as Part)?.message ?? ''), 400)) + '\n');
        }
      } else if (ev.event === 'result') {
        const res = (ev.result ?? {}) as Part;
        status = String(res.status ?? '');
        finalText = typeof res.response === 'string' ? res.response : finalText;
        resultError = typeof res.error === 'string' ? res.error : '';
        usage = addUsage(usage, usageOf(res.usage as Part | undefined));
        denied = Array.isArray(res.denied_actions) ? res.denied_actions.map((d) => String((d as Part)?.tool_name ?? d)) : [];
        o.onStep?.(
          defined({
            kind: 'meta' as const,
            turns: typeof res.num_turns === 'number' ? res.num_turns : undefined,
            durationMs: typeof res.duration_seconds === 'number' ? Math.round(res.duration_seconds * 1000) : undefined,
          }),
        );
        if (denied.length)
          o.onStep?.({
            kind: 'notice',
            level: 'warn',
            key: 'denied',
            text: `Агенту не дали выполнить: ${denied.join('; ')}`,
          });
      }
      for (const st of agySteps(ev)) o.onStep?.(st);
    },
  });

  const text = (finalText || stepText).trim();
  if (r.killed) return { ok: false, text, usage, stopped: true, error: 'Остановлено' };
  if (r.timedOut)
    return {
      ok: false,
      text,
      usage,
      timedOut: true,
      error: r.idle
        ? `agy: молчал ${Math.round((o.idleTimeoutMs ?? 0) / 60000)} мин — похоже, завис; остановлен`
        : `agy: превышен предельный таймаут ${Math.round(o.timeoutMs / 60000)} мин`,
    };
  if (r.spawnError) return { ok: false, text: '', usage, error: `agy не запустился: ${r.spawnError}` };
  if (status !== 'SUCCESS' || r.code !== 0) {
    const raw = [resultError, r.stderr.trim(), readableTail(r.stdout)].filter(Boolean).join('\n');
    if (r.stderr.trim()) out(c.coral(clip(r.stderr, 2000)) + '\n');
    return {
      ok: false,
      text,
      usage,
      error: raw ? agyError(raw, status) : `agy: завершился без ответа (код выхода ${r.code ?? '—'}, статус ${status || '—'})`,
    };
  }
  return { ok: true, text, usage };
}
