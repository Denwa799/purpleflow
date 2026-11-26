// MCP-серверы агентов: список из их настроек, установка из реестра MCP, удаление и копирование между агентами.
// claude, codex и agy правят свои настройки сами — через `<cli> mcp add/remove`; у opencode — раздел mcp в opencode.json.
// Значения переменных окружения и заголовков (там бывают ключи) в окно не уходят — только их имена.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Kernel } from '../kernel.js';
import { enabledAgents } from '../model/settings.js';
import { run } from '../proc.js';
import type { AgentKind, McpEntry, McpHit, McpInstall, McpScope, McpStatus } from '../types.js';

/** Полное описание сервера: то, что пишется в настройки агента. */
export interface McpDef {
  transport: 'stdio' | 'http' | 'sse';
  command?: string;
  args?: string[];
  url?: string;
  env?: Record<string, string>;
  headers?: Record<string, string>;
}

const NAME = /^[\w.-]{1,64}$/;
const REGISTRY = process.env.PURPLEFLOW_MCP_REGISTRY_URL || 'https://registry.modelcontextprotocol.io/v0/servers';
/** У codex и agy серверы только глобальные: настроек проекта для MCP у них нет. */
export const MCP_GLOBAL_ONLY: AgentKind[] = ['codex', 'agy'];

const home = () => os.homedir();
const readJson = (f: string): Record<string, unknown> | null => {
  try {
    return JSON.parse(fs.readFileSync(f, 'utf8')) as Record<string, unknown>;
  } catch {
    return null;
  }
};
const obj = (x: unknown): Record<string, unknown> =>
  x && typeof x === 'object' && !Array.isArray(x) ? (x as Record<string, unknown>) : {};
const strs = (x: unknown): string[] => (Array.isArray(x) ? x.map(String) : []);
const record = (x: unknown): Record<string, string> => Object.fromEntries(Object.entries(obj(x)).map(([k, v]) => [k, String(v)]));

/** claude, agy и .mcp.json: { command, args, env } или { type, url|serverUrl, headers }. */
function fromClaudeLike(v: Record<string, unknown>): McpDef {
  const url = (v.url ?? v.serverUrl ?? v.httpUrl) as string | undefined;
  if (url) return { transport: v.type === 'sse' ? 'sse' : 'http', url: String(url), headers: record(v.headers) };
  return { transport: 'stdio', command: String(v.command ?? ''), args: strs(v.args), env: record(v.env) };
}

/** opencode: { type: local, command: [..], environment } или { type: remote, url, headers }. */
function fromOpencode(v: Record<string, unknown>): McpDef {
  if (v.type === 'remote') return { transport: 'http', url: String(v.url ?? ''), headers: record(v.headers) };
  const cmd = strs(v.command);
  return { transport: 'stdio', command: cmd[0] ?? '', args: cmd.slice(1), env: record(v.environment) };
}

const opencodeFile = (scope: McpScope, projectPath?: string) =>
  scope === 'project' ? path.join(projectPath!, 'opencode.json') : path.join(home(), '.config', 'opencode', 'opencode.json');
const agyFile = () => path.join(home(), '.gemini', 'config', 'mcp_config.json');

interface Found {
  entry: McpEntry;
  def: McpDef;
}

async function codexServers(k: Kernel): Promise<Found[]> {
  const bin = (await k.tools(['codex'])).codex;
  const r = await run(bin, ['mcp', 'list', '--json'], { cwd: home(), env: k.opts.env, timeoutMs: 30_000 });
  if (r.code !== 0) return [];
  let list: Record<string, unknown>[];
  try {
    list = JSON.parse(r.stdout) as Record<string, unknown>[];
  } catch {
    return [];
  }
  return list.map((s) => {
    const t = obj(s.transport);
    const def: McpDef = t.url
      ? { transport: 'http', url: String(t.url), headers: record(t.http_headers ?? t.headers) }
      : { transport: 'stdio', command: String(t.command ?? ''), args: strs(t.args), env: record(t.env) };
    return { def, entry: entryOf(String(s.name), 'codex', 'user', def, { disabled: s.enabled === false }) };
  });
}

function entryOf(name: string, agent: AgentKind, scope: McpScope, d: McpDef, extra: Partial<McpEntry> = {}): McpEntry {
  return {
    name,
    agent,
    scope,
    transport: d.transport,
    ...(d.url ? { url: d.url } : { command: [d.command, ...(d.args ?? [])].filter(Boolean).join(' ') }),
    env: Object.keys(d.env ?? {}),
    headers: Object.keys(d.headers ?? {}),
    ...extra,
  };
}

/** Все серверы включённых агентов, вместе с полными описаниями (для копирования). */
async function scan(k: Kernel, projectPath?: string): Promise<Found[]> {
  const on = enabledAgents(k.opts.getSettings());
  const out: Found[] = [];
  const add = (
    agent: AgentKind,
    scope: McpScope,
    servers: Record<string, unknown>,
    parse: (v: Record<string, unknown>) => McpDef,
    extra = {},
  ) => {
    for (const [name, v] of Object.entries(servers)) {
      const def = parse(obj(v));
      out.push({ def, entry: entryOf(name, agent, scope, def, { ...extra, ...(obj(v).disabled === true ? { disabled: true } : {}) }) });
    }
  };
  if (on.includes('claude')) {
    if (projectPath) add('claude', 'project', obj(readJson(path.join(projectPath, '.mcp.json'))?.mcpServers), fromClaudeLike);
    const user = readJson(path.join(home(), '.claude.json'));
    add('claude', 'user', obj(user?.mcpServers), fromClaudeLike);
    // «local» у claude — серверы этого проекта только у вас (в ~/.claude.json): показываем среди серверов проекта.
    if (projectPath) add('claude', 'project', obj(obj(obj(user?.projects)[projectPath]).mcpServers), fromClaudeLike, { local: true });
  }
  if (on.includes('opencode')) {
    if (projectPath) add('opencode', 'project', obj(readJson(opencodeFile('project', projectPath))?.mcp), fromOpencode);
    add('opencode', 'user', obj(readJson(opencodeFile('user'))?.mcp), fromOpencode);
  }
  if (on.includes('agy')) add('agy', 'user', obj(readJson(agyFile())?.mcpServers), fromClaudeLike);
  if (on.includes('codex') && (await k.hasTool('codex'))) out.push(...(await codexServers(k).catch(() => [])));
  return out;
}

/** MCP-серверы для экрана проекта: проекта и ваши, по агентам. Значения ключей не отдаются. */
export async function listMcp(k: Kernel, projectPath?: string): Promise<McpEntry[]> {
  return (await scan(k, projectPath)).map((f) => f.entry).sort((a, b) => a.name.localeCompare(b.name));
}

async function cli(k: Kernel, agent: 'claude' | 'codex' | 'agy', args: string[], cwd: string): Promise<void> {
  const bin = (await k.tools([agent]))[agent];
  const r = await run(bin, args, { cwd, env: k.opts.env, timeoutMs: 60_000 });
  if (r.spawnError) throw new Error(`${agent} не запустился: ${r.spawnError}`);
  if (r.code !== 0) throw new Error(`${agent}: ${(r.stderr || r.stdout).trim().split('\n').slice(-3).join(' ') || `код ${r.code}`}`);
}

/** Правка opencode.json: только корректный JSON — файл с комментариями не трогаем, чтобы их не потерять. */
function editOpencode(file: string, fn: (mcp: Record<string, unknown>) => void) {
  const exists = fs.existsSync(file);
  const cfg = exists ? readJson(file) : { $schema: 'https://opencode.ai/config.json' };
  if (!cfg) throw new Error(`opencode: ${file} — не чистый JSON (комментарии?). Измените раздел mcp вручную.`);
  const mcp = obj(cfg.mcp);
  fn(mcp);
  cfg.mcp = mcp;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(cfg, null, 2)}\n`);
}

/** Добавить сервер одному агенту. codex и agy — всегда глобально. */
async function addTo(
  k: Kernel,
  agent: AgentKind,
  name: string,
  def: McpDef,
  scope: McpScope | 'local',
  projectPath?: string,
): Promise<void> {
  const env = Object.entries(def.env ?? {});
  const headers = Object.entries(def.headers ?? {});
  const remote = def.transport !== 'stdio';
  if (agent === 'claude') {
    const json = remote
      ? { type: def.transport, url: def.url, ...(headers.length ? { headers: def.headers } : {}) }
      : { type: 'stdio', command: def.command, args: def.args ?? [], ...(env.length ? { env: def.env } : {}) };
    return cli(k, 'claude', ['mcp', 'add-json', name, JSON.stringify(json), '-s', scope], projectPath ?? home());
  }
  if (agent === 'codex') {
    if (remote && headers.length)
      throw new Error('codex: заголовки для HTTP-сервера через CLI не задать — добавьте их в ~/.codex/config.toml');
    const args = remote
      ? ['mcp', 'add', name, '--url', def.url!]
      : ['mcp', 'add', name, ...env.flatMap(([kk, v]) => ['--env', `${kk}=${v}`]), '--', def.command!, ...(def.args ?? [])];
    return cli(k, 'codex', args, home());
  }
  if (agent === 'agy') {
    const flags = [...env.flatMap(([kk, v]) => ['--env', `${kk}=${v}`]), ...headers.flatMap(([kk, v]) => ['--header', `${kk}: ${v}`])];
    const args = remote
      ? ['mcp', 'add', ...flags, name, def.url!]
      : ['mcp', 'add', ...flags, name, '--', def.command!, ...(def.args ?? [])];
    return cli(k, 'agy', args, home());
  }
  editOpencode(opencodeFile(scope === 'user' ? 'user' : 'project', projectPath), (mcp) => {
    mcp[name] = remote
      ? { type: 'remote', url: def.url, ...(headers.length ? { headers: def.headers } : {}), enabled: true }
      : { type: 'local', command: [def.command, ...(def.args ?? [])], ...(env.length ? { environment: def.env } : {}), enabled: true };
  });
}

const scopeFor = (agent: AgentKind, scope: McpScope): McpScope => (MCP_GLOBAL_ONLY.includes(agent) ? 'user' : scope);

/**
 * Поставить сервер из реестра: выбранный вариант (удалённый или пакет), значения переменных и заголовков —
 * для выбранных агентов. Ошибка у одного агента не отменяет остальных: в ответе — кому не удалось и почему.
 */
export async function installMcp(
  k: Kernel,
  o: { projectPath?: string; scope: McpScope; agents: AgentKind[]; name: string; install: McpInstall; values: Record<string, string> },
): Promise<{ servers: McpEntry[]; failed: { agent: AgentKind; error: string }[] }> {
  if (!NAME.test(o.name)) throw new Error('Имя сервера: латиница, цифры, «-», «_», «.»');
  const on = enabledAgents(k.opts.getSettings());
  const agents = o.agents.filter((a) => on.includes(a));
  if (!agents.length) throw new Error('Не выбран ни один агент');
  for (const i of o.install.inputs) if (i.required && !o.values[i.key]?.trim()) throw new Error(`Заполните ${i.key}`);
  const pick = (kind: 'env' | 'header') =>
    Object.fromEntries(
      o.install.inputs.filter((i) => i.kind === kind && o.values[i.key]?.trim()).map((i) => [i.key, o.values[i.key].trim()]),
    );
  const def: McpDef = {
    transport: o.install.transport,
    command: o.install.command,
    args: o.install.args,
    url: o.install.url,
    env: pick('env'),
    headers: pick('header'),
  };
  const failed: { agent: AgentKind; error: string }[] = [];
  for (const a of agents) {
    try {
      await addTo(k, a, o.name, def, scopeFor(a, o.scope), o.projectPath);
    } catch (e) {
      failed.push({ agent: a, error: (e as Error).message });
    }
  }
  return { servers: await listMcp(k, o.projectPath), failed };
}

/** Удалить сервер у агента — в той области, где он записан. */
export async function removeMcp(
  k: Kernel,
  o: { projectPath?: string; agent: AgentKind; name: string; scope: McpScope; local?: boolean },
): Promise<McpEntry[]> {
  if (!NAME.test(o.name)) throw new Error('Неверное имя сервера');
  const cwd = o.projectPath ?? home();
  if (o.agent === 'claude')
    await cli(k, 'claude', ['mcp', 'remove', o.name, '-s', o.local ? 'local' : o.scope === 'project' ? 'project' : 'user'], cwd);
  else if (o.agent === 'codex') await cli(k, 'codex', ['mcp', 'remove', o.name], home());
  else if (o.agent === 'agy') await cli(k, 'agy', ['mcp', 'remove', o.name], home());
  else editOpencode(opencodeFile(o.scope, o.projectPath), (mcp) => void delete mcp[o.name]);
  return listMcp(k, o.projectPath);
}

/** Скопировать сервер другому агенту — со всеми переменными и заголовками; область — та же, где это возможно. */
export async function copyMcp(
  k: Kernel,
  o: { projectPath?: string; agent: AgentKind; name: string; scope: McpScope; to: AgentKind },
): Promise<McpEntry[]> {
  const found = (await scan(k, o.projectPath)).find(
    (f) => f.entry.agent === o.agent && f.entry.name === o.name && f.entry.scope === o.scope,
  );
  if (!found) throw new Error('Сервер не найден');
  if (!enabledAgents(k.opts.getSettings()).includes(o.to)) throw new Error(`${o.to} выключен в настройках`);
  await addTo(k, o.to, o.name, found.def, scopeFor(o.to, o.scope), o.projectPath);
  return listMcp(k, o.projectPath);
}

/** Командная строка → слова: пробелы делят, кавычки держат вместе. */
export function splitCommand(line: string): string[] {
  const out: string[] = [];
  for (const m of line.matchAll(/"([^"]*)"|'([^']*)'|(\S+)/g)) out.push(m[1] ?? m[2] ?? m[3]);
  return out;
}

/**
 * Изменить сервер: адрес или команду запуска и значения ключей. Пустое значение — ключ остаётся прежним.
 * Агенты не умеют править сервер на месте: удаляем и записываем заново; не вышло — возвращаем как было.
 */
export async function updateMcp(
  k: Kernel,
  o: {
    projectPath?: string;
    agent: AgentKind;
    name: string;
    scope: McpScope;
    local?: boolean;
    /** URL (http, sse) или командная строка (stdio). */
    target?: string;
    values?: Record<string, string>;
  },
): Promise<McpEntry[]> {
  const found = (await scan(k, o.projectPath)).find(
    (f) => f.entry.agent === o.agent && f.entry.name === o.name && f.entry.scope === o.scope && !!f.entry.local === !!o.local,
  );
  if (!found) throw new Error('Сервер не найден');
  const old = found.def;
  const def: McpDef = { ...old, env: { ...old.env }, headers: { ...old.headers } };
  const target = o.target?.trim();
  if (target) {
    if (def.transport === 'stdio') {
      const [command, ...args] = splitCommand(target);
      Object.assign(def, { command, args });
    } else if (/^https?:\/\/\S+$/.test(target)) def.url = target;
    else throw new Error('Адрес сервера: http:// или https://');
  }
  for (const [key, v] of Object.entries(o.values ?? {})) {
    if (!v.trim()) continue;
    if (key in (def.env ?? {})) def.env![key] = v.trim();
    else if (key in (def.headers ?? {})) def.headers![key] = v.trim();
  }
  const scope = o.agent === 'claude' && o.local ? 'local' : scopeFor(o.agent, o.scope);
  if (o.agent === 'opencode') {
    await addTo(k, o.agent, o.name, def, scope, o.projectPath);
    return listMcp(k, o.projectPath);
  }
  await removeMcp(k, o);
  try {
    await addTo(k, o.agent, o.name, def, scope, o.projectPath);
  } catch (e) {
    await addTo(k, o.agent, o.name, old, scope, o.projectPath).catch(() => undefined);
    throw e;
  }
  return listMcp(k, o.projectPath);
}

type McpHealth = McpStatus['status'];

/** Строки `claude mcp list`: «имя: адрес - ✔ Connected» → состояние по имени. */
export function parseClaudeList(out: string): Map<string, McpHealth> {
  const m = new Map<string, McpHealth>();
  for (const line of out.split('\n')) {
    const at = line.indexOf(': ');
    const dash = line.lastIndexOf(' - ');
    if (at < 1 || dash < at) continue;
    const tail = line.slice(dash + 3).toLowerCase();
    const status: McpHealth =
      tail.includes('connected') && !tail.includes('fail')
        ? 'connected'
        : tail.includes('auth')
          ? 'needs-auth'
          : tail.includes('fail')
            ? 'failed'
            : 'unknown';
    m.set(line.slice(0, at).trim(), status);
  }
  return m;
}

const INIT = JSON.stringify({
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'purpleflow', version: '1' } },
});

/** Сами спрашиваем сервер initialize: удалённый — запросом, локальный — запуском (как это сделает агент). */
async function probe(k: Kernel, def: McpDef, cwd: string): Promise<McpHealth> {
  if (def.transport !== 'stdio') {
    try {
      const res = await fetch(def.url!, {
        method: def.transport === 'sse' ? 'GET' : 'POST',
        headers: {
          accept: 'application/json, text/event-stream',
          ...(def.transport === 'sse' ? {} : { 'content-type': 'application/json' }),
          ...def.headers,
        },
        body: def.transport === 'sse' ? undefined : INIT,
        signal: AbortSignal.timeout(10_000),
      });
      void res.body?.cancel().catch(() => undefined);
      return res.status === 401 || res.status === 403 ? 'needs-auth' : res.ok ? 'connected' : 'failed';
    } catch {
      return 'failed';
    }
  }
  if (!def.command) return 'failed';
  let ok = false;
  let stdin: { end: () => void } | null = null;
  await run(def.command, def.args ?? [], {
    cwd,
    env: { ...k.opts.env, ...def.env },
    timeoutMs: 30_000,
    onStdin: (s) => {
      stdin = s;
      s.write(`${INIT}\n`);
    },
    onStdoutLine: (line) => {
      if (!ok && /"id"\s*:\s*1\b/.test(line) && line.includes('"result"')) {
        ok = true;
        stdin?.end();
      }
    },
  });
  return ok ? 'connected' : 'failed';
}

/**
 * Работают ли серверы: у claude — его собственная проверка (`claude mcp list`, с его входами в сервисы),
 * у остальных — пробуем подключиться сами. Одинаковые серверы разных агентов проверяются один раз.
 */
export async function checkMcp(k: Kernel, projectPath?: string): Promise<McpStatus[]> {
  const found = await scan(k, projectPath);
  const cwd = projectPath ?? home();
  const claude = found.some((f) => f.entry.agent === 'claude')
    ? await (async () => {
        const bin = (await k.tools(['claude'])).claude;
        const r = await run(bin, ['mcp', 'list'], { cwd, env: k.opts.env, timeoutMs: 90_000 });
        return parseClaudeList(r.stdout);
      })().catch(() => new Map<string, McpHealth>())
    : new Map<string, McpHealth>();
  const probes = new Map<string, Promise<McpHealth>>();
  return Promise.all(
    found.map(async ({ entry: e, def }) => {
      let status: McpHealth;
      if (e.disabled) status = 'unknown';
      else if (e.agent === 'claude') status = claude.get(e.name) ?? 'unknown';
      else {
        const key = JSON.stringify(def);
        if (!probes.has(key))
          probes.set(
            key,
            probe(k, def, cwd).catch(() => 'failed' as const),
          );
        status = await probes.get(key)!;
      }
      return { agent: e.agent, name: e.name, scope: e.scope, ...(e.local ? { local: true } : {}), status };
    }),
  );
}

/** Поиск в официальном реестре MCP: только последние версии и варианты, которые умеем поставить. */
export async function searchMcp(query: string): Promise<McpHit[]> {
  const q = query.trim();
  if (q.length < 2) return [];
  const res = await fetch(`${REGISTRY}?${new URLSearchParams({ search: q, version: 'latest', limit: '30' })}`, {
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new Error(`Реестр MCP не ответил (HTTP ${res.status})`);
  const data = (await res.json()) as { servers?: { server?: Record<string, unknown> }[] };
  const out: McpHit[] = [];
  for (const { server: s } of data.servers ?? []) {
    if (!s) continue;
    const installs = installsOf(s);
    if (!installs.length) continue;
    const id = String(s.name ?? '');
    out.push({
      id,
      name: shortName(id),
      title: typeof s.title === 'string' ? s.title : undefined,
      description: String(s.description ?? '').slice(0, 300),
      version: String(s.version ?? ''),
      installs,
    });
  }
  return out;
}

/** Короткое имя для настроек: последняя часть «io.github.owner/name» без лишнего. */
export function shortName(id: string): string {
  const last = id.split('/').pop() ?? id;
  return (last.replace(/[^\w.-]+/g, '-').replace(/^-+|-+$/g, '') || 'mcp').slice(0, 64);
}

type Input = McpInstall['inputs'][number];
const inputsOf = (list: unknown, kind: 'env' | 'header'): Input[] =>
  (Array.isArray(list) ? list : []).map(obj).flatMap((v) => {
    const key = String(v.name ?? '');
    if (!/^[\w-]+$/.test(key)) return [];
    return [
      {
        key,
        kind,
        description: typeof v.description === 'string' ? v.description.slice(0, 200) : undefined,
        required: v.isRequired === true,
        secret: v.isSecret === true,
        default: typeof v.value === 'string' ? v.value : typeof v.default === 'string' ? v.default : undefined,
      },
    ];
  });

/** Варианты установки сервера из записи реестра: удалённый адрес, npm (npx) или PyPI (uvx). */
export function installsOf(s: Record<string, unknown>): McpInstall[] {
  const out: McpInstall[] = [];
  for (const r of (Array.isArray(s.remotes) ? s.remotes : []).map(obj)) {
    const url = String(r.url ?? '');
    if (!/^https?:\/\//.test(url) || /\{/.test(url)) continue;
    out.push({
      kind: 'remote',
      label: 'Удалённый сервер',
      transport: r.type === 'sse' ? 'sse' : 'http',
      url,
      inputs: inputsOf(r.headers, 'header'),
    });
  }
  for (const p of (Array.isArray(s.packages) ? s.packages : []).map(obj)) {
    if (obj(p.transport).type && obj(p.transport).type !== 'stdio') continue;
    const id = String(p.identifier ?? '');
    const version = typeof p.version === 'string' && p.version ? p.version : '';
    // Позиционные аргументы с готовым значением; именованные и без значения не угадываем.
    const extra = (Array.isArray(p.packageArguments) ? p.packageArguments : [])
      .map(obj)
      .filter((a) => a.type === 'positional' && typeof a.value === 'string')
      .map((a) => String(a.value));
    const inputs = inputsOf(p.environmentVariables, 'env');
    if (p.registryType === 'npm' && /^[@\w./-]+$/.test(id))
      out.push({
        kind: 'npm',
        label: 'npm (npx)',
        transport: 'stdio',
        command: 'npx',
        args: ['-y', version ? `${id}@${version}` : id, ...extra],
        inputs,
      });
    else if (p.registryType === 'pypi' && /^[\w.-]+$/.test(id))
      out.push({
        kind: 'pypi',
        label: 'PyPI (uvx)',
        transport: 'stdio',
        command: 'uvx',
        args: [version ? `${id}==${version}` : id, ...extra],
        inputs,
      });
  }
  return out;
}
