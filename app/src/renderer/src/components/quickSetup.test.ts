import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildPreset, fillTiers, opencodeTiers, restrictAgents } from '../lib/presets';

const row = (m: ReturnType<typeof buildPreset>['models']) => [m.planner, m.reviewer, m.executor, m.manager, m.visual, m.scan];

test('buildPreset: роли растут на ступень от пресета к пресету, сильнее всех — планировщик и ревьюер', () => {
  // планировщик, ревьюер, исполнитель, менеджер, визуальная проверка, сканирование
  assert.deepEqual(row(buildPreset('claude', 'economy').models), ['sonnet', 'sonnet', 'haiku', 'haiku', 'haiku', 'haiku']);
  assert.deepEqual(row(buildPreset('claude', 'optimal').models), ['opus', 'opus', 'sonnet', 'sonnet', 'haiku', 'haiku']);
  assert.deepEqual(row(buildPreset('claude', 'max').models), ['claude-fable-5-2', 'claude-fable-5-2', 'opus', 'opus', 'sonnet', 'sonnet']);
  // У codex ступень в ступень: haiku → luna, sonnet → terra, opus → sol, Fable → astra.
  assert.deepEqual(row(buildPreset('codex', 'economy').models), [
    'gpt-6.1-terra',
    'gpt-6.1-terra',
    'gpt-6-luna',
    'gpt-6-luna',
    'gpt-6-luna',
    'gpt-6-luna',
  ]);
  assert.deepEqual(row(buildPreset('codex', 'optimal').models), [
    'gpt-6-sol',
    'gpt-6-sol',
    'gpt-6.1-terra',
    'gpt-6.1-terra',
    'gpt-6-luna',
    'gpt-6-luna',
  ]);
  assert.deepEqual(row(buildPreset('codex', 'max').models), [
    'gpt-6-astra',
    'gpt-6-astra',
    'gpt-6-sol',
    'gpt-6-sol',
    'gpt-6.1-terra',
    'gpt-6.1-terra',
  ]);
});

test('buildPreset: ревьюер нигде не на модели исполнителя, все роли — на основном агенте', () => {
  for (const a of ['claude', 'codex'] as const)
    for (const p of ['economy', 'optimal', 'max'] as const) {
      const { agents, models } = buildPreset(a, p);
      assert.notEqual(models.reviewer, models.executor, `${a} ${p}`);
      assert.ok(Object.values(agents).every((x) => x === a));
    }
});

test('restrictAgents: роли выключенного CLI переходят на оставшийся с моделями «Оптимального», остальные не трогаем', () => {
  const r = restrictAgents(
    ['claude'],
    { planner: 'claude', executor: 'claude', reviewer: 'codex', manager: 'codex' },
    { planner: 'opus', executor: 'my-sonnet', reviewer: 'gpt-6-sol', visual: '', manager: 'gpt-6-luna', scan: '' },
  );
  assert.deepEqual(r.agents, { planner: 'claude', executor: 'claude', reviewer: 'claude', manager: 'claude' });
  assert.equal(r.models.executor, 'my-sonnet');
  assert.equal(r.models.reviewer, 'opus');
  assert.equal(r.models.manager, 'sonnet');
});

test('restrictAgents: без claude визуальная проверка по умолчанию переезжает на codex', () => {
  const r = restrictAgents(
    ['codex'],
    { planner: 'claude', executor: 'codex', reviewer: 'codex' },
    {
      planner: 'opus',
      executor: '',
      reviewer: '',
    },
  );
  assert.equal(r.agents.planner, 'codex');
  assert.equal(r.models.planner, 'gpt-6-sol');
  assert.equal(r.agents.visual, 'codex');
  assert.equal(r.agents.scan, undefined);
});

test('buildPreset: opencode с AI-прокси — ступени моделей прокси, без прокси — модели из настроек opencode', () => {
  assert.deepEqual(buildPreset('opencode', 'optimal', true).models, buildPreset('codex', 'optimal').models);
  assert.ok(Object.values(buildPreset('opencode', 'optimal').models).every((m) => m === ''));
  const r = restrictAgents(
    ['opencode'],
    { planner: 'claude', executor: 'claude', reviewer: 'codex' },
    { planner: 'opus', executor: '', reviewer: '' },
    true,
  );
  assert.equal(r.agents.planner, 'opencode');
  assert.equal(r.models.planner, 'gpt-6-sol');
  assert.equal(r.models.executor, 'gpt-6.1-terra');
});

test('fillTiers: пустой уровень занимает ближайший заполненный, при равенстве — нижний', () => {
  assert.deepEqual(fillTiers({ low: '', mid: 'or/m', high: '', max: '' }), { low: 'or/m', mid: 'or/m', high: 'or/m', max: 'or/m' });
  assert.deepEqual(fillTiers({ low: 'a/1', mid: '', high: '', max: 'a/4' }), { low: 'a/1', mid: 'a/1', high: 'a/4', max: 'a/4' });
  assert.deepEqual(fillTiers({ low: '', mid: '', high: '', max: '' }), { low: '', mid: '', high: '', max: '' });
});

test('buildPreset: opencode — свои уровни человека; ревьюер не на модели исполнителя, если есть другая', () => {
  const t = { low: 'ds/flash', mid: 'ds/flash', high: 'or/qwen', max: 'or/qwen' };
  const m = buildPreset('opencode', 'optimal', false, t).models;
  assert.equal(m.planner, 'or/qwen');
  assert.equal(m.reviewer, 'or/qwen');
  assert.equal(m.executor, 'ds/flash');
  assert.equal(m.scan, 'ds/flash');
  // Без выбора и без прокси — модель из настроек opencode; с прокси — линейка прокси.
  assert.deepEqual(opencodeTiers(false, null), { low: '', mid: '', high: '', max: '' });
  assert.equal(opencodeTiers(true, null).mid, 'gpt-6.1-terra');
  assert.equal(opencodeTiers(true, t).mid, 'ds/flash');
});
