// План → факт, подтверждения визуальной проверки и проверка перед влитием.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { emptyUsage } from './agents/common.js';
import { Git } from './git.js';
import { Kernel } from './kernel.js';
import { parsePassed, parsePlanCoverage, parseReview } from './parse.js';
import { mergeCheck } from './services/pr.js';
import type { CoreSettings, RunFile } from './types.js';

const PROMPTS = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'prompts');

test('parsePlanCoverage: статусы, пустые и чужие пункты, ответ без plan', () => {
  const text = JSON.stringify({
    blocking: [],
    notes: [],
    plan: [
      { task: '1.1 Модель', status: 'done', note: 'core/model.ts' },
      { task: '1.2 Тест', status: 'missing', note: null },
      { task: '', status: 'done' },
      { task: '1.3 Что-то', status: 'maybe' },
      { task: '1.4 Миграция', status: 'partial', note: '  ' },
    ],
  });
  assert.deepEqual(parsePlanCoverage(text), [
    { task: '1.1 Модель', status: 'done', note: 'core/model.ts' },
    { task: '1.2 Тест', status: 'missing' },
    { task: '1.4 Миграция', status: 'partial' },
  ]);
  assert.deepEqual(parsePlanCoverage('{"blocking":[],"notes":[]}'), []);
  assert.deepEqual(parsePlanCoverage('не JSON'), []);
  // Ответ с plan по-прежнему читается как ревью.
  assert.deepEqual(parseReview(text)?.blocking, []);
});

test('parsePassed: строки и объекты с message, пустое отбрасывается', () => {
  assert.deepEqual(parsePassed(JSON.stringify({ passed: ['а', ' ', { message: 'б' }, 3] })), ['а', 'б']);
  assert.deepEqual(parsePassed('{"blocking":[],"notes":[]}'), []);
});

function repo(root: string) {
  const dir = path.join(root, 'repo');
  fs.mkdirSync(dir);
  const g = (...a: string[]) =>
    execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...a], { cwd: dir })
      .toString()
      .trim();
  g('init', '-q', '-b', 'main');
  fs.writeFileSync(path.join(dir, 'a.txt'), 'a\n');
  fs.writeFileSync(path.join(dir, 'b.txt'), 'b\n');
  g('add', '-A');
  g('commit', '-qm', 'init');
  return { dir, g, base: g('rev-parse', 'HEAD') };
}

test('git: countAhead и mergeConflicts без изменения рабочей копии', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pf-mc-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const { dir, g, base } = repo(root);
  g('checkout', '-qb', 'feat');
  fs.writeFileSync(path.join(dir, 'a.txt'), 'feat\n');
  g('commit', '-qam', 'feat');
  g('checkout', '-q', 'main');
  fs.writeFileSync(path.join(dir, 'b.txt'), 'main\n');
  g('commit', '-qam', 'main b');
  const git = new Git('git', process.env);
  assert.equal(await git.countAhead(dir, base, 'main'), 1);
  assert.deepEqual(await git.mergeConflicts(dir, 'main', 'feat'), [], 'разные файлы — без конфликта');
  fs.writeFileSync(path.join(dir, 'a.txt'), 'main\n');
  g('commit', '-qam', 'main a');
  assert.deepEqual(await git.mergeConflicts(dir, 'main', 'feat'), ['a.txt']);
  assert.equal(g('status', '--porcelain'), '', 'рабочая копия не тронута');
});

test('mergeCheck: отставание, точный конфликт, пересечение с другим прогоном', async (t) => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pf-mc-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const { dir, g, base } = repo(root);
  // Прогон 1 — завершён, меняет a.txt; прогон 2 — тоже завершён, меняет a.txt и b.txt; main ушла вперёд с правкой a.txt.
  for (const [br, files] of [
    ['purpleflow/one', ['a.txt']],
    ['purpleflow/two', ['a.txt', 'b.txt']],
  ] as const) {
    g('checkout', '-qb', br, base);
    for (const f of files) fs.writeFileSync(path.join(dir, f), `${br}\n`);
    g('commit', '-qam', br);
  }
  g('checkout', '-q', 'main');
  fs.writeFileSync(path.join(dir, 'a.txt'), 'main\n');
  g('commit', '-qam', 'main a');

  const k = new Kernel({
    dataDir: path.join(root, 'data'),
    promptsDir: PROMPTS,
    env: process.env,
    getSettings: () => ({ toolPaths: {}, proxy: { baseUrl: '', apiKey: '' } }) as unknown as CoreSettings,
  });
  const mk = (id: string, branch: string, extra: Partial<RunFile> = {}) =>
    ({
      id,
      title: `Задача ${id}`,
      task: 't',
      changeId: id,
      mode: 'task',
      status: 'finished',
      next: 'finish',
      workspace: 'worktree',
      projectPath: dir,
      worktreePath: path.join(root, `wt-${id}`),
      branch,
      baseBranch: 'main',
      baseCommit: base,
      commit: 'x',
      agents: { planner: 'claude', executor: 'claude', reviewer: 'claude' },
      models: {},
      attempts: [],
      tests: [],
      reviews: [],
      gates: [],
      planRetries: 0,
      implAttemptsUsed: 1,
      implAttemptsLimit: 3,
      totals: emptyUsage(),
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      ...extra,
    }) as unknown as RunFile;
  k.store.save(mk('one', 'purpleflow/one'));
  k.store.save(mk('two', 'purpleflow/two'));
  k.store.save(mk('old', 'purpleflow/two', { merged: { into: 'main', commit: 'y', at: '' } }));

  const res = await mergeCheck(k, 'one');
  assert.ok(res);
  assert.equal(res.target, 'main');
  assert.equal(res.behind, 1);
  assert.equal(res.exact, true);
  assert.deepEqual(res.conflicts, ['a.txt']);
  assert.deepEqual(
    res.overlaps.map((o) => [o.runId, o.files]),
    [['two', ['a.txt']]],
    'влитый прогон не в счёт; общие только a.txt',
  );
  assert.equal(await mergeCheck(k, 'old'), null, 'уже влитый — проверять нечего');
});
