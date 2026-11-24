// Адаптер agy (Antigravity CLI): флаги, промпт, разбор потока `agy -p --output-format stream-json`.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import type { AgentStep } from './agents/common.js';
import { agyArgs, agyError, agyInput, agySteps, agyToolInput, runAgy, type AgyOptions } from './agents/agy.js';

const unix = { skip: process.platform === 'win32' };

/** Фейковый agy: печатает события, запоминает аргументы и stdin. */
function fakeAgy(t: { after: (fn: () => void) => void }, lines: unknown[], o: { code?: number; stderr?: string } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pf-agy-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const out = path.join(dir, 'out.jsonl');
  fs.writeFileSync(out, lines.map((l) => (typeof l === 'string' ? l : JSON.stringify(l))).join('\n') + '\n');
  const bin = path.join(dir, 'agy');
  fs.writeFileSync(
    bin,
    [
      '#!/bin/sh',
      `printf '%s\\n' "$@" > "${dir}/args"`,
      `cat > "${dir}/stdin"`,
      `cat "${out}"`,
      `[ -n "${o.stderr ?? ''}" ] && echo "${o.stderr}" >&2`,
      `exit ${o.code ?? 0}`,
    ].join('\n'),
    { mode: 0o755 },
  );
  const read = (f: string) => fs.readFileSync(path.join(dir, f), 'utf8');
  return { bin, args: () => read('args').trim().split('\n'), stdin: () => read('stdin') };
}

function opts(bin: string, dir: string, p: Partial<AgyOptions> = {}) {
  const steps: AgentStep[] = [];
  const sessions: string[] = [];
  const o: AgyOptions = {
    bin,
    cwd: dir,
    env: { ...process.env },
    prompt: 'задача',
    timeoutMs: 20_000,
    group: `agy-${path.basename(dir)}`,
    onOutput: () => {},
    onStep: (s) => steps.push(s),
    onSession: (id) => sessions.push(id),
    ...p,
  };
  return { o, steps, sessions };
}

/** Событие потока agy: init, step_update, result. */
const init = (id = 'c-1') => ({
  event: 'init',
  conversation_id: id,
  init: { cwd: '/tmp/proj', tools: ['run_command'], permission_mode: 'always-proceed' },
});
const step = (payload: Record<string, unknown>) => ({
  event: 'step_update',
  step_update: { conversation_id: 'c-1', step_index: 0, state: 'DONE', ...payload },
});
const result = (payload: Record<string, unknown> = {}) => ({
  event: 'result',
  result: {
    conversation_id: 'c-1',
    status: 'SUCCESS',
    response: 'готово\n',
    duration_seconds: 1.5,
    num_turns: 1,
    usage: { input_tokens: 10, output_tokens: 5, thinking_tokens: 2, cache_read_tokens: 7 },
    ...payload,
  },
});

test('agyArgs: потоковая разметка, снятые права и флаги роли', () => {
  const args = agyArgs({ model: 'gemini-3.8-flash-high', effort: 'high', addDirs: ['/extra'], resumeConversation: 'c-9' });
  assert.deepEqual(args, [
    '--output-format',
    'stream-json',
    '--dangerously-skip-permissions',
    '--conversation',
    'c-9',
    '--model',
    'gemini-3.8-flash-high',
    '--effort',
    'high',
    '--add-dir',
    '/extra',
  ]);
  // Промпт потоком — только вместе с --input-format: иначе agy ждёт его аргументом -p.
  assert.ok(agyArgs({}, true).includes('--input-format'));
  assert.ok(!agyArgs({}).includes('--input-format'));
});

test('agyInput: системный промпт и запрет записи идут тем же текстом, промпт — сразу за -p', () => {
  const one = agyInput({ prompt: 'задача', systemPrompt: 'ты планировщик', readOnly: true });
  const prompt = one.args[1] ?? '';
  assert.equal(one.args[0], '-p');
  assert.match(prompt, /ты планировщик/);
  assert.match(prompt, /задача/);
  assert.match(prompt, /только на чтение/);
  assert.equal(one.input, undefined);
  // Без readOnly запрета нет: писать агенту можно.
  assert.doesNotMatch(agyInput({ prompt: 'задача' }).args[1] ?? '', /только на чтение/);
});

test('agyInput на Windows: длинный промпт уходит потоком в stdin, а не в командную строку', () => {
  const long = 'я'.repeat(9000);
  const win = agyInput({ prompt: long }, 'win32');
  assert.ok(win.args.includes('--input-format'));
  assert.ok(!win.args.includes('-p'));
  const line = JSON.parse((win.input ?? '').trim()) as { event: string; message: { content: string } };
  assert.equal(line.event, 'user');
  assert.equal(line.message.content, long);
  // На Linux тот же промпт остаётся аргументом.
  assert.ok(agyInput({ prompt: long }, 'linux').args.includes('-p'));
});

test('agyToolInput: аргументы agy переводятся в имена claude, лишние не теряются', () => {
  assert.deepEqual(agyToolInput({ CommandLine: 'npm test', Cwd: '/p' }), { command: 'npm test', Cwd: '/p' });
  assert.deepEqual(agyToolInput({ TargetFile: '/p/a.ts', CodeContent: 'x' }), { file_path: '/p/a.ts', content: 'x' });
  assert.deepEqual(agyToolInput({ Query: 'mul' }), { pattern: 'mul' });
});

test('agySteps: текст, вызов инструмента с итогом, ошибка шага и init', () => {
  assert.deepEqual(agySteps(step({ step_type: 'agent_response', text_delta: 'привет' })), [{ kind: 'text', text: 'привет', delta: true }]);
  const tool = agySteps(
    step({
      step_type: 'tool',
      tool_name: 'run_command',
      tool_info: { name: 'run_command', parameters: { CommandLine: 'npm test' }, output: 'ok\n' },
    }),
  );
  assert.equal(tool.length, 2);
  assert.equal(tool[0].kind, 'tool');
  assert.match(tool[0].kind === 'tool' ? tool[0].text : '', /Bash npm test/);
  assert.deepEqual(tool[1], { kind: 'tool_result', id: 'c-1:0', ok: true, output: 'ok' });
  const failed = agySteps(
    step({ step_type: 'tool', tool_name: 'read_file', tool_info: { name: 'read_file', error: { message: 'нет файла' } } }),
  );
  assert.deepEqual(failed[1], { kind: 'tool_result', id: 'c-1:0', ok: false, output: 'нет файла' });
  assert.equal(agySteps(step({ step_type: 'error_message' }))[0].kind, 'notice');
  const meta = agySteps(init());
  assert.equal(meta[0].kind, 'meta');
  assert.equal(meta[0].kind === 'meta' ? meta[0].cwd : '', '/tmp/proj');
});

test('runAgy: ответ, токены и ID беседы из потока', unix, async (t) => {
  const fake = fakeAgy(t, [init(), step({ step_type: 'agent_response', text_delta: 'готово' }), result()]);
  const { o, steps, sessions } = opts(fake.bin, fake.bin.replace(/\/agy$/, ''), { model: 'gemini-3.8-flash-high' });
  const r = await runAgy(o);
  assert.equal(r.ok, true);
  assert.equal(r.text, 'готово');
  // thinking_tokens входят в output: иначе расход агента занижен.
  assert.equal(r.usage.input, 10);
  assert.equal(r.usage.output, 7);
  assert.equal(r.usage.cacheRead, 7);
  assert.equal(r.usage.cacheWrite, 0);
  assert.deepEqual(sessions, ['c-1']);
  assert.ok(steps.some((s) => s.kind === 'text' && s.text === 'готово'));
  const args = fake.args();
  assert.equal(args[args.indexOf('--model') + 1], 'gemini-3.8-flash-high');
});

test('runAgy: продолжение беседы — через --conversation, без него флага нет', unix, async (t) => {
  const fake = fakeAgy(t, [init(), result()]);
  await runAgy(opts(fake.bin, os.tmpdir(), { resumeConversation: 'c-1' }).o);
  const args = fake.args();
  assert.equal(args[args.indexOf('--conversation') + 1], 'c-1');
  const fresh = fakeAgy(t, [init(), result()]);
  await runAgy(opts(fresh.bin, os.tmpdir()).o);
  assert.ok(!fresh.args().includes('--conversation'));
});

test('runAgy: статус ERROR — это ошибка запуска, а не пустой ответ', unix, async (t) => {
  const fake = fakeAgy(t, [init(), result({ status: 'ERROR', response: '', error: 'model gemini-0 is not recognized as a known model' })], {
    code: 1,
  });
  const r = await runAgy(opts(fake.bin, os.tmpdir()).o);
  assert.equal(r.ok, false);
  assert.match(r.error ?? '', /agy models/);
});

test('agyError: вход в аккаунт, лимиты и отказы прав — понятными фразами', () => {
  assert.match(agyError('authentication required'), /войдите/);
  assert.match(agyError('RESOURCE_EXHAUSTED: quota exceeded'), /лимит/);
  assert.match(agyError('', 'CANCELED'), /отменён/);
  assert.match(agyError('plan model not specified'), /agy models/);
});

test('runAgy: отказ в правах из denied_actions виден человеку', unix, async (t) => {
  const fake = fakeAgy(t, [init(), result({ denied_actions: [{ tool_name: 'run_command' }] })]);
  const { o, steps } = opts(fake.bin, os.tmpdir());
  await runAgy(o);
  const notice = steps.find((s) => s.kind === 'notice');
  assert.ok(notice && notice.kind === 'notice');
  assert.match(notice.kind === 'notice' ? notice.text : '', /run_command/);
});
