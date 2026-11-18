import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { CoreCommand, CoreEvent, RunFile } from '@purpleflow/core';
import { presetOf } from './presets';
import {
  UsageQueue,
  usageFromCommand,
  usageFromCoreEvent,
  usageFromRunStart,
  usageFromSetup,
  type UsageEvent,
  type UsageSendResult,
} from './usage-events';

const event = (name: string): UsageEvent => ({ name, occurredAt: '2026-11-09T13:00:00.000Z' });

const RID = '5f0a4c1e-8c2d-4a7b-9f3e-2a1b0c9d8e7f';

test('команды превращаются в события без текста задачи и комментариев; ворота — из контекста', () => {
  const start = {
    type: 'run.start',
    input: { projectPath: '/secret', task: 'секрет', testCommand: 'npm test', mode: 'bug' },
  } as CoreCommand;
  assert.equal(usageFromCommand(start), null, 'run_started — по самому прогону, после старта');
  assert.deepEqual(usageFromCommand({ type: 'gate.reject', runId: RID, comment: 'секрет' }, { gate: 'gate1' }), {
    name: 'gate_decided',
    props: { runId: RID, gate: 'gate1', decision: 'reject' },
  });
  // Прогон стоит не на воротах (или неизвестно где) — без gate, сервер такое тоже примет.
  assert.deepEqual(usageFromCommand({ type: 'gate.approve', runId: RID }, { gate: 'implement' }), {
    name: 'gate_decided',
    props: { runId: RID, decision: 'approve' },
  });
  assert.deepEqual(usageFromCommand({ type: 'run.pr', runId: RID, base: 'main' }), { name: 'pr_created', props: { runId: RID } });
  assert.equal(usageFromCommand({ type: 'run.stop', runId: RID }), null);
});

test('старт прогона: режим, пресет, агент и модель исполнителя, effort, прокси', () => {
  const run = {
    id: RID,
    mode: 'task',
    agents: { planner: 'claude', executor: 'claude', reviewer: 'claude' },
    models: { planner: 'opus', executor: 'sonnet', reviewer: 'opus' },
    efforts: { executor: 'high' },
  } as unknown as RunFile;
  assert.deepEqual(usageFromRunStart(run, true), {
    name: 'run_started',
    props: { runId: RID, mode: 'task', preset: 'optimal', agent: 'claude', model: 'sonnet', effort: 'high', proxy: true },
  });
  // Своя модель с пробелами не уходит: сервер отклонил бы всю пачку. Пустая — модель CLI по умолчанию.
  const own = { ...run, models: { planner: '', executor: 'my local model', reviewer: '' }, efforts: undefined } as unknown as RunFile;
  assert.deepEqual(usageFromRunStart(own, false).props, { runId: RID, mode: 'task', preset: 'custom', agent: 'claude', proxy: false });
  const dflt = { ...run, models: { planner: '', executor: '', reviewer: '' } } as unknown as RunFile;
  assert.equal(usageFromRunStart(dflt, false).props?.model, 'default');
});

test('пресет прогона узнаётся по моделям ролей, в том числе с префиксом прокси', () => {
  const codex = { planner: 'codex', executor: 'codex', reviewer: 'codex' } as const;
  assert.equal(presetOf(codex, { planner: 'gpt-6.1-terra', executor: 'gpt-6-luna', reviewer: 'gpt-6.1-terra' }), 'economy');
  assert.equal(
    presetOf(codex, { planner: 'purpleflow/gpt-6-astra', executor: 'purpleflow/gpt-6-sol', reviewer: 'purpleflow/gpt-6-astra' }),
    'max',
  );
  assert.equal(presetOf({ ...codex, reviewer: 'claude' }, { planner: '', executor: '', reviewer: '' }), 'custom');
  assert.equal(presetOf({ planner: 'opencode', executor: 'opencode', reviewer: 'opencode' }, {}), 'custom');
});

test('события ядра сводятся к разрешённым полям и несут runId', () => {
  const tests = {
    type: 'tests.result',
    runId: RID,
    result: { passed: false, durationMs: 12.6, output: 'секрет', command: 'x' },
  } as unknown as CoreEvent;
  assert.deepEqual(usageFromCoreEvent(tests), { name: 'tests_finished', props: { runId: RID, passed: false, durationMs: 13 } });
  const review = { type: 'review.result', runId: RID, result: { blocking: [{}], notes: [] } } as unknown as CoreEvent;
  assert.deepEqual(usageFromCoreEvent(review), { name: 'review_finished', props: { runId: RID, hasBlocking: true } });
  assert.deepEqual(usageFromCoreEvent({ type: 'stage.failed', runId: RID, stage: 'plan', error: 'секрет' }), {
    name: 'stage_failed',
    props: { runId: RID, stage: 'plan' },
  });
  assert.deepEqual(
    usageFromCoreEvent({
      type: 'gate.waiting',
      runId: RID,
      gate: 'limit',
      message: 'секрет',
      limit: { cause: 'loop', attempts: 2, max: 3 },
    }),
    { name: 'gate_waiting', props: { runId: RID, gate: 'limit', cause: 'loop', attempts: 2, limit: 3 } },
  );
  assert.deepEqual(usageFromCoreEvent({ type: 'gate.waiting', runId: RID, gate: 'gate1' }), {
    name: 'gate_waiting',
    props: { runId: RID, gate: 'gate1' },
  });
  assert.deepEqual(usageFromCoreEvent({ type: 'run.finished', runId: RID, status: 'stopped', message: 'секрет', reason: 'stage_failed' }), {
    name: 'run_finished',
    props: { runId: RID, status: 'stopped', reason: 'stage_failed' },
  });
  assert.equal(usageFromCoreEvent({ type: 'agent.output', runId: RID, stage: 'plan', text: 'секрет' }), null);
  assert.equal(usageFromCoreEvent({ type: 'run.finished', runId: RID, status: 'running' }), null);
});

test('шаги настройки из окна: только известные шаги, неизвестная причина — unknown', () => {
  assert.deepEqual(usageFromSetup('welcome'), { name: 'setup_step', props: { step: 'welcome' } });
  assert.deepEqual(usageFromSetup('login', 'network'), { name: 'setup_failed', props: { step: 'login', reason: 'network' } });
  assert.deepEqual(usageFromSetup('check', 'пароль неверный'), { name: 'setup_failed', props: { step: 'check', reason: 'unknown' } });
  assert.equal(usageFromSetup('/Users/anna'), null);
  assert.equal(usageFromSetup(42), null);
});

test('очередь шлёт пачками по 50', async () => {
  const sizes: number[] = [];
  const q = new UsageQueue(async (batch) => (sizes.push(batch.length), 'sent'));
  for (let i = 0; i < 120; i += 1) q.push(event(`e${i}`));
  await q.flush();
  assert.deepEqual(sizes, [50, 50, 20]);
  assert.equal(q.size, 0);
});

test('сбой сети оставляет события, отказ сервера их выбрасывает', async () => {
  let result: UsageSendResult = 'failed';
  const q = new UsageQueue(async () => result);
  q.push(event('a'));
  await q.flush();
  assert.equal(q.size, 1);
  result = 'rejected';
  await q.flush();
  assert.equal(q.size, 0);
});

test('одновременные отправки не дублируют события, переполнение вытесняет старые', async () => {
  let calls = 0;
  const q = new UsageQueue(async () => (calls++, 'sent'));
  q.push(event('a'));
  await Promise.all([q.flush(), q.flush()]);
  assert.equal(calls, 1);

  const stuck = new UsageQueue(async () => 'failed');
  for (let i = 0; i < 501; i += 1) stuck.push(event(`e${i}`));
  assert.equal(stuck.size, 500);
});
