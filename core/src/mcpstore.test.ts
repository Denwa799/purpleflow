// MCP-серверы: чтение настроек агентов, установка, удаление и копирование через их CLI (заглушки), разбор реестра.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { Kernel } from './kernel.js';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import {
  checkMcp,
  copyMcp,
  installMcp,
  installsOf,
  listMcp,
  parseClaudeList,
  removeMcp,
  shortName,
  splitCommand,
  updateMcp,
} from './services/mcpstore.js';
import type { CoreSettings, McpInstall } from './types.js';

const unix = { skip: process.platform === 'win32' };
const PROMPTS = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'prompts');

function setup(t: { after: (fn: () => void) => void }, agents = ['claude', 'codex', 'opencode', 'agy']) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pf-mcp-')));
  const prevHome = process.env.HOME;
  t.after(() => {
    process.env.HOME = prevHome;
    fs.rmSync(root, { recursive: true, force: true });
  });
  const home = path.join(root, 'home');
  const project = path.join(root, 'project');
  const bin = path.join(root, 'bin');
  for (const d of [home, project, bin]) fs.mkdirSync(d);
  process.env.HOME = home;
  const log = path.join(root, 'calls.log');
  for (const name of ['claude', 'codex', 'agy', 'opencode']) {
    fs.writeFileSync(
      path.join(bin, name),
      `#!/bin/sh
[ "$1" = "--version" ] && { echo "${name} 1.0.0"; exit 0; }
[ "$1 $2 $3" = "mcp list --json" ] && { cat "${root}/codex.json" 2>/dev/null || echo '[]'; exit 0; }
[ "$1 $2 $#" = "mcp list 2" ] && { cat "${root}/${name}-list.txt" 2>/dev/null; exit 0; }
printf '%s' "${name}" >> "${log}"; for a in "$@"; do printf ' [%s]' "$a" >> "${log}"; done; echo >> "${log}"
[ -f "${root}/fail-${name}" ] && { echo "сломался" >&2; exit 1; }
[ -f "${root}/fail-${name}-$2" ] && { echo "сломался" >&2; exit 1; }
exit 0
`,
      { mode: 0o755 },
    );
  }
  const settings = {
    enabledAgents: agents,
    toolPaths: Object.fromEntries(['claude', 'codex', 'agy', 'opencode'].map((n) => [n, path.join(bin, n)])),
    agents: {},
    models: {},
  } as unknown as CoreSettings;
  const k = new Kernel({ dataDir: path.join(root, 'data'), promptsDir: PROMPTS, env: process.env, getSettings: () => settings });
  const calls = () => (fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n') : []);
  const write = (f: string, v: unknown) => {
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, JSON.stringify(v));
  };
  return { k, root, home, project, calls, write };
}

test('listMcp: серверы всех агентов, проекта и ваши; значения ключей не уходят', unix, async (t) => {
  const { k, root, home, project, write } = setup(t);
  write(path.join(project, '.mcp.json'), {
    mcpServers: { figma: { type: 'http', url: 'https://mcp.figma.com/mcp', headers: { Authorization: 'Bearer секрет' } } },
  });
  write(path.join(home, '.claude.json'), {
    mcpServers: { fs: { command: 'npx', args: ['-y', 'server-fs'] } },
    projects: { [project]: { mcpServers: { db: { command: 'pg', env: { DB_URL: 'postgres://секрет' } } } } },
  });
  write(path.join(project, 'opencode.json'), { mcp: { linear: { type: 'remote', url: 'https://mcp.linear.app/sse' } } });
  write(path.join(home, '.gemini/config/mcp_config.json'), {
    mcpServers: { gh: { command: 'docker', args: ['run', 'gh'], env: { GITHUB_TOKEN: 'ghp_секрет' } } },
  });
  write(path.join(root, 'codex.json'), [
    { name: 'notion', enabled: true, transport: { type: 'streamable_http', url: 'https://mcp.notion.com/mcp' } },
  ]);
  const list = await listMcp(k, project);
  const by = (agent: string, name: string) => list.find((s) => s.agent === agent && s.name === name)!;
  assert.deepEqual([by('claude', 'figma').scope, by('claude', 'figma').headers], ['project', ['Authorization']]);
  assert.equal(by('claude', 'fs').scope, 'user');
  assert.deepEqual([by('claude', 'db').scope, by('claude', 'db').local, by('claude', 'db').env], ['project', true, ['DB_URL']]);
  assert.equal(by('opencode', 'linear').url, 'https://mcp.linear.app/sse');
  assert.deepEqual([by('agy', 'gh').command, by('agy', 'gh').scope], ['docker run gh', 'user']);
  assert.equal(by('codex', 'notion').url, 'https://mcp.notion.com/mcp');
  assert.doesNotMatch(JSON.stringify(list), /секрет/);
});

const npm: McpInstall = {
  kind: 'npm',
  label: 'npm',
  transport: 'stdio',
  command: 'npx',
  args: ['-y', '@acme/mcp@1.0.0'],
  inputs: [{ key: 'ACME_TOKEN', kind: 'env', required: true, secret: true }],
};

test('installMcp: каждому агенту — своей командой; codex и agy — глобально; opencode — в opencode.json', unix, async (t) => {
  const { k, project, calls } = setup(t);
  await assert.rejects(
    installMcp(k, { projectPath: project, scope: 'project', agents: ['claude'], name: 'acme', install: npm, values: {} }),
    /ACME_TOKEN/,
  );
  const r = await installMcp(k, {
    projectPath: project,
    scope: 'project',
    agents: ['claude', 'codex', 'agy', 'opencode'],
    name: 'acme',
    install: npm,
    values: { ACME_TOKEN: 't1' },
  });
  assert.deepEqual(r.failed, []);
  const c = calls();
  assert.equal(
    c.find((l) => l.startsWith('claude')),
    'claude [mcp] [add-json] [acme] [{"type":"stdio","command":"npx","args":["-y","@acme/mcp@1.0.0"],"env":{"ACME_TOKEN":"t1"}}] [-s] [project]',
  );
  assert.equal(
    c.find((l) => l.startsWith('codex')),
    'codex [mcp] [add] [acme] [--env] [ACME_TOKEN=t1] [--] [npx] [-y] [@acme/mcp@1.0.0]',
  );
  assert.equal(
    c.find((l) => l.startsWith('agy')),
    'agy [mcp] [add] [--env] [ACME_TOKEN=t1] [acme] [--] [npx] [-y] [@acme/mcp@1.0.0]',
  );
  const oc = JSON.parse(fs.readFileSync(path.join(project, 'opencode.json'), 'utf8'));
  assert.deepEqual(oc.mcp.acme, {
    type: 'local',
    command: ['npx', '-y', '@acme/mcp@1.0.0'],
    environment: { ACME_TOKEN: 't1' },
    enabled: true,
  });
});

test('installMcp: сбой у одного агента не мешает остальным; удалённый сервер с заголовком', unix, async (t) => {
  const { k, root, project, calls } = setup(t);
  fs.writeFileSync(path.join(root, 'fail-claude'), '');
  const remote: McpInstall = {
    kind: 'remote',
    label: 'r',
    transport: 'http',
    url: 'https://x.test/mcp',
    inputs: [{ key: 'X-Key', kind: 'header', required: false, secret: true }],
  };
  const r = await installMcp(k, {
    projectPath: project,
    scope: 'user',
    agents: ['claude', 'agy'],
    name: 'x',
    install: remote,
    values: { 'X-Key': 'k1' },
  });
  assert.deepEqual(
    r.failed.map((f) => f.agent),
    ['claude'],
  );
  assert.match(r.failed[0].error, /сломался/);
  assert.equal(
    calls().find((l) => l.startsWith('agy')),
    'agy [mcp] [add] [--header] [X-Key: k1] [x] [https://x.test/mcp]',
  );
});

test('removeMcp и copyMcp: удаление в своей области, копия — со значениями ключей', unix, async (t) => {
  const { k, home, project, calls, write } = setup(t);
  write(path.join(home, '.gemini/config/mcp_config.json'), {
    mcpServers: { gh: { command: 'docker', args: ['run', 'gh'], env: { GITHUB_TOKEN: 'ghp_1' } } },
  });
  write(path.join(project, 'opencode.json'), {
    $schema: 'x',
    mcp: { a: { type: 'remote', url: 'https://a.test' }, b: { type: 'remote', url: 'https://b.test' } },
  });
  await removeMcp(k, { projectPath: project, agent: 'claude', name: 'db', scope: 'project', local: true });
  assert.equal(calls().at(-1), 'claude [mcp] [remove] [db] [-s] [local]');
  await removeMcp(k, { projectPath: project, agent: 'opencode', name: 'a', scope: 'project' });
  assert.deepEqual(Object.keys(JSON.parse(fs.readFileSync(path.join(project, 'opencode.json'), 'utf8')).mcp), ['b']);
  await copyMcp(k, { projectPath: project, agent: 'agy', name: 'gh', scope: 'user', to: 'claude' });
  assert.equal(
    calls().at(-1),
    'claude [mcp] [add-json] [gh] [{"type":"stdio","command":"docker","args":["run","gh"],"env":{"GITHUB_TOKEN":"ghp_1"}}] [-s] [user]',
  );
});

test('installsOf и shortName: варианты из записи реестра', () => {
  const s = {
    name: 'io.github.acme/acme-mcp',
    remotes: [
      {
        type: 'streamable-http',
        url: 'https://mcp.acme.dev/mcp',
        headers: [{ name: 'Authorization', isRequired: true, isSecret: true, value: 'Bearer {token}' }],
      },
      { type: 'streamable-http', url: 'https://{tenant}.acme.dev/mcp' },
    ],
    packages: [
      {
        registryType: 'npm',
        identifier: '@acme/mcp',
        version: '2.1.0',
        transport: { type: 'stdio' },
        environmentVariables: [{ name: 'ACME_KEY', isRequired: true, isSecret: true }],
      },
      { registryType: 'pypi', identifier: 'acme-mcp', version: '0.3', packageArguments: [{ type: 'positional', value: 'serve' }] },
      { registryType: 'nuget', identifier: 'Acme.Mcp' },
    ],
  };
  const list = installsOf(s);
  assert.deepEqual(
    list.map((i) => [i.kind, i.url ?? `${i.command} ${i.args!.join(' ')}`]),
    [
      ['remote', 'https://mcp.acme.dev/mcp'],
      ['npm', 'npx -y @acme/mcp@2.1.0'],
      ['pypi', 'uvx acme-mcp==0.3 serve'],
    ],
  );
  assert.deepEqual(list[0].inputs[0], {
    key: 'Authorization',
    kind: 'header',
    description: undefined,
    required: true,
    secret: true,
    default: 'Bearer {token}',
  });
  assert.equal(shortName('io.github.acme/acme-mcp'), 'acme-mcp');
});

test('updateMcp: новый ключ и команда — удалить и записать заново; пустое значение оставляет прежнее', unix, async (t) => {
  const { k, home, project, calls, write } = setup(t);
  write(path.join(home, '.claude.json'), {
    projects: { [project]: { mcpServers: { db: { command: 'pg', args: ['--old'], env: { DB_URL: 'old', DB_USER: 'me' } } } } },
  });
  await updateMcp(k, {
    projectPath: project,
    agent: 'claude',
    name: 'db',
    scope: 'project',
    local: true,
    target: 'pg "--host=a b"',
    values: { DB_URL: 'new', DB_USER: ' ' },
  });
  assert.deepEqual(calls(), [
    'claude [mcp] [remove] [db] [-s] [local]',
    `claude [mcp] [add-json] [db] [${JSON.stringify({ type: 'stdio', command: 'pg', args: ['--host=a b'], env: { DB_URL: 'new', DB_USER: 'me' } })}] [-s] [local]`,
  ]);
  // opencode: правка на месте.
  write(path.join(project, 'opencode.json'), { mcp: { linear: { type: 'remote', url: 'https://a.example/mcp', headers: { X: '1' } } } });
  await updateMcp(k, {
    projectPath: project,
    agent: 'opencode',
    name: 'linear',
    scope: 'project',
    target: 'https://b.example/mcp',
    values: { X: '2' },
  });
  const oc = JSON.parse(fs.readFileSync(path.join(project, 'opencode.json'), 'utf8')) as {
    mcp: Record<string, { url: string; headers: unknown }>;
  };
  assert.deepEqual([oc.mcp.linear.url, oc.mcp.linear.headers], ['https://b.example/mcp', { X: '2' }]);
  await assert.rejects(
    updateMcp(k, { projectPath: project, agent: 'opencode', name: 'linear', scope: 'project', target: 'ftp://x' }),
    /http/,
  );
});

test('updateMcp: не записалось — пробуем вернуть прежний сервер', unix, async (t) => {
  const { k, root, home, calls, write } = setup(t);
  write(path.join(home, '.gemini/config/mcp_config.json'), { mcpServers: { gh: { command: 'gh-mcp', env: { T: 'old' } } } });
  fs.writeFileSync(path.join(root, 'fail-agy-add'), '');
  await assert.rejects(updateMcp(k, { agent: 'agy', name: 'gh', scope: 'user', values: { T: 'new' } }), /сломался/);
  assert.deepEqual(calls(), [
    'agy [mcp] [remove] [gh]',
    'agy [mcp] [add] [--env] [T=new] [gh] [--] [gh-mcp]',
    'agy [mcp] [add] [--env] [T=old] [gh] [--] [gh-mcp]',
  ]);
});

test('checkMcp: claude — по его проверке, остальные — пробуем подключиться', unix, async (t) => {
  const { k, root, home, project, write } = setup(t);
  const server = http.createServer((req, res) => {
    res.statusCode = req.url === '/locked' ? 401 : 200;
    res.end('{}');
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  t.after(() => server.close());
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const ok = path.join(root, 'ok-mcp.mjs');
  fs.writeFileSync(
    ok,
    `process.stdin.on('data', () => { process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: 1, result: {} }) + '\\n'); });\n`,
  );
  write(path.join(home, '.claude.json'), { mcpServers: { figma: { type: 'http', url: 'https://x' }, gone: { command: 'nope' } } });
  fs.writeFileSync(
    path.join(root, 'claude-list.txt'),
    'Checking MCP server health…\n\nfigma: https://x (HTTP) - ✔ Connected\ngone: nope - ✗ Failed to connect\n',
  );
  write(path.join(project, 'opencode.json'), {
    mcp: {
      local: { type: 'local', command: [process.execPath, ok] },
      broken: { type: 'local', command: [process.execPath, '-e', 'process.exit(1)'] },
      remote: { type: 'remote', url: `${base}/mcp` },
      locked: { type: 'remote', url: `${base}/locked` },
    },
  });
  const st = await checkMcp(k, project);
  const of = (agent: string, name: string) => st.find((s) => s.agent === agent && s.name === name)?.status;
  assert.equal(of('claude', 'figma'), 'connected');
  assert.equal(of('claude', 'gone'), 'failed');
  assert.equal(of('opencode', 'local'), 'connected');
  assert.equal(of('opencode', 'broken'), 'failed');
  assert.equal(of('opencode', 'remote'), 'connected');
  assert.equal(of('opencode', 'locked'), 'needs-auth');
});

test('splitCommand и parseClaudeList', () => {
  assert.deepEqual(splitCommand(`npx -y "@a/b c" 'd e' f`), ['npx', '-y', '@a/b c', 'd e', 'f']);
  const m = parseClaudeList(
    'Checking MCP server health…\n\nclaude.ai Gmail: https://g/mcp - ✔ Connected\nsentry: https://s - ⚠ Needs authentication\nx: y - ✗ Failed to connect\n',
  );
  assert.deepEqual(
    [...m],
    [
      ['claude.ai Gmail', 'connected'],
      ['sentry', 'needs-auth'],
      ['x', 'failed'],
    ],
  );
});
