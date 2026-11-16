// GitLab-обвязка на фейковом glab: скрипт пишет аргументы вызовов и отвечает по подстроке запроса.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { gitlabForge, mrComments, mrMerge, mrReadiness, mrStatus, parseMrUrl, parsePages } from './gitlab.js';

const unix = { skip: process.platform === 'win32' };
const HOST = 'gitlab.company.ru';
const URL_ = `https://${HOST}/team/sub/app/-/merge_requests/5`;
const MR_PATH = 'projects/team%2Fsub%2Fapp/merge_requests/5';

/** Маршрут: подстрока аргументов → тело ответа и код выхода; первый подошедший побеждает. */
type Route = [match: string, body: string, code?: number];

function fakeGlab(t: { after: (fn: () => void) => void }, routes: Route[]) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pf-glab-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const bin = path.join(dir, 'glab');
  const calls = path.join(dir, 'calls');
  let script = `#!/bin/sh\necho "$*" >> "${calls}"\nenv_host="\${GITLAB_HOST:-}"\n[ -n "$env_host" ] && echo "GITLAB_HOST=$env_host" >> "${calls}"\n`;
  routes.forEach(([match, body, code = 0], i) => {
    const f = path.join(dir, `r${i}`);
    fs.writeFileSync(f, body);
    script += `case "$*" in *"${match}"*) cat "${f}"; exit ${code};; esac\n`;
  });
  script += 'echo "нет маршрута" >&2\nexit 1\n';
  fs.writeFileSync(bin, script, { mode: 0o755 });
  return { bin, dir, calls: () => (fs.existsSync(calls) ? fs.readFileSync(calls, 'utf8').trim().split('\n') : []) };
}

const mr = (over: object = {}) =>
  JSON.stringify({
    iid: 5,
    title: 'Заголовок MR',
    web_url: URL_,
    state: 'opened',
    draft: false,
    detailed_merge_status: 'mergeable',
    has_conflicts: false,
    merge_commit_sha: null,
    head_pipeline: null,
    diff_refs: { head_sha: 'new' },
    ...over,
  });

test('parseMrUrl: вложенные группы и хвост /diffs', () => {
  assert.deepEqual(parseMrUrl(URL_), { project: 'team/sub/app', number: 5 });
  assert.deepEqual(parseMrUrl(`${URL_}/diffs`), { project: 'team/sub/app', number: 5 });
  assert.equal(parseMrUrl('https://github.com/acme/app/pull/1'), null);
});

test('parsePages: страницы склеиваются, битый ответ — ошибка', () => {
  assert.deepEqual(parsePages('[{"a":"]"}]\n[{"a":2}]'), [{ a: ']' }, { a: 2 }]);
  assert.deepEqual(parsePages(''), []);
  assert.throws(() => parsePages('[{"a":'), /glab/);
  assert.throws(() => parsePages('[1] мусор'), /glab/);
});

test('status: detailed_merge_status → признаки PrStatus', unix, async (t) => {
  const cases: [string, Partial<Record<'mergeable' | 'conflicts' | 'blocked' | 'behind', boolean>>, string | null][] = [
    ['mergeable', { mergeable: true, conflicts: false, blocked: false, behind: false }, null],
    ['conflict', { mergeable: false, conflicts: true, behind: true }, null],
    ['need_rebase', { mergeable: false, conflicts: false, behind: true }, null],
    ['not_approved', { mergeable: false, blocked: true }, 'REVIEW_REQUIRED'],
    ['requested_changes', { blocked: true }, 'CHANGES_REQUESTED'],
    ['discussions_not_resolved', { blocked: true }, null],
  ];
  for (const [d, want, review] of cases) {
    const g = fakeGlab(t, [[MR_PATH, mr({ detailed_merge_status: d })]]);
    const s = await mrStatus(g.bin, HOST, g.dir, process.env, URL_);
    for (const [k, v] of Object.entries(want)) assert.equal(s[k as 'mergeable'], v, `${d}: ${k}`);
    assert.equal(s.review, review, `${d}: review`);
    assert.equal(s.state, 'OPEN');
  }
});

test('status: старый GitLab без detailed_merge_status — merge_status; черновик, влитый MR', unix, async (t) => {
  const old = (ms: string) => mr({ detailed_merge_status: undefined, merge_status: ms });
  let g = fakeGlab(t, [[MR_PATH, old('can_be_merged')]]);
  assert.equal((await mrStatus(g.bin, HOST, g.dir, process.env, URL_)).mergeable, true);
  g = fakeGlab(t, [[MR_PATH, old('cannot_be_merged')]]);
  const c = await mrStatus(g.bin, HOST, g.dir, process.env, URL_);
  assert.deepEqual([c.mergeable, c.conflicts, c.behind], [false, true, true]);
  g = fakeGlab(t, [[MR_PATH, mr({ state: 'merged', draft: true, merge_commit_sha: 'abc' })]]);
  const m = await mrStatus(g.bin, HOST, g.dir, process.env, URL_);
  assert.deepEqual([m.state, m.draft, m.mergeCommit], ['MERGED', true, 'abc']);
  g = fakeGlab(t, [[MR_PATH, mr({ state: 'closed', merge_commit_sha: null, squash_commit_sha: 'sq' })]]);
  const z = await mrStatus(g.bin, HOST, g.dir, process.env, URL_);
  assert.deepEqual([z.state, z.mergeCommit], ['CLOSED', 'sq']);
});

test('status: pipeline — упавший, allow_failure, ретрай, ожидающий; без pipeline проверок нет', unix, async (t) => {
  const job = (id: number, name: string, status: string, over: object = {}) => ({
    id,
    name,
    status,
    web_url: `https://${HOST}/team/sub/app/-/jobs/${id}`,
    ...over,
  });
  const page1 = JSON.stringify([job(1, 'lint', 'success'), job(2, 'test', 'failed'), job(3, 'flaky', 'failed', { allow_failure: true })]);
  const page2 = JSON.stringify([
    job(4, 'test', 'success'),
    job(5, 'build', 'running'),
    job(6, 'deploy', 'manual'),
    job(7, 'old', 'failed', { retried: true }),
    job(8, 'e2e', 'failed'),
  ]);
  let g = fakeGlab(t, [
    ['pipelines/9/jobs', `${page1}\n${page2}`],
    [MR_PATH, mr({ head_pipeline: { id: 9 } })],
  ]);
  const s = await mrStatus(g.bin, HOST, g.dir, process.env, URL_);
  // test: берётся последняя попытка (id 4, успешна); old с retried отброшен; flaky с allow_failure не считается упавшим.
  assert.deepEqual(s.checks, { total: 6, passed: 4, failed: 1, pending: 1 });
  assert.deepEqual(s.failedChecks, [{ name: 'e2e', url: `https://${HOST}/team/sub/app/-/jobs/8` }]);
  assert.ok(g.calls().some((c) => c.includes('--paginate') && c.includes('pipelines/9/jobs')));

  g = fakeGlab(t, [[MR_PATH, mr()]]);
  const none = await mrStatus(g.bin, HOST, g.dir, process.env, URL_);
  assert.deepEqual(none.checks, { total: 0, passed: 0, failed: 0, pending: 0 });
  assert.deepEqual(none.failedChecks, []);
});

test('comments: ветки в коде, общие комментарии, системные заметки отброшены', unix, async (t) => {
  const note = (id: number, body: string, over: object = {}) => ({
    id,
    body,
    author: { username: 'ann' },
    created_at: `2026-01-0${id}T00:00:00Z`,
    ...over,
  });
  const pos = { new_path: 'src/a.ts', old_path: 'src/a.ts', new_line: 12, old_line: null, head_sha: 'old' };
  const discussions = [
    {
      id: 'd1',
      individual_note: false,
      notes: [
        note(1, 'Поправь', { resolvable: true, resolved: true, position: pos }),
        note(2, 'Готово', { resolvable: true, resolved: true }),
      ],
    },
    { id: 'd2', individual_note: true, notes: [note(3, 'Общий комментарий')] },
    { id: 'd3', individual_note: true, notes: [note(4, 'merged', { system: true })] },
    { id: 'd4', individual_note: false, notes: [note(5, 'Открытый вопрос', { resolvable: true, resolved: false })] },
  ];
  const g = fakeGlab(t, [
    ['/discussions', JSON.stringify(discussions.slice(0, 2)) + JSON.stringify(discussions.slice(2))],
    [MR_PATH, mr()],
  ]);
  const r = await mrComments(g.bin, HOST, g.dir, process.env, URL_);
  assert.equal(r.title, 'Заголовок MR');
  assert.deepEqual(
    r.comments.map((c) => [c.id, c.kind, c.resolved, c.path, c.line, c.outdated]),
    [
      ['d1', 'thread', true, 'src/a.ts', 12, true],
      ['d2', 'comment', undefined, undefined, undefined, undefined],
      ['d4', 'thread', false, undefined, undefined, undefined],
    ],
  );
  assert.equal(r.comments[0].url, `${URL_}#note_1`);
  assert.deepEqual(r.comments[0].replies, [{ author: 'ann', body: 'Готово', at: '2026-01-02T00:00:00Z' }]);
});

test('failedJobLog: трасса без ANSI и маркеров секций, хвост 120 строк; не job — null', unix, async (t) => {
  const body =
    'section_start:1:step\r\x1b[0K\x1b[31;1mошибка сборки\x1b[0m\nsection_end:2:step\r\x1b[0K\n' +
    Array.from({ length: 150 }, (_, i) => `строка ${i}`).join('\n');
  const g = fakeGlab(t, [['jobs/8/trace', body]]);
  const f = gitlabForge(g.bin, process.env, HOST);
  const log = await f.failedJobLog(g.dir, `https://${HOST}/team/sub/app/-/jobs/8`);
  const lines = log!.split('\n');
  assert.equal(lines.length, 120);
  assert.equal(lines.at(-1), 'строка 149');
  assert.doesNotMatch(log!, /section_|\x1b|\r/);
  assert.equal(await f.failedJobLog(g.dir, `https://${HOST}/team/sub/app/-/pipelines/1`), null);
  const bad = fakeGlab(t, [['trace', 'x', 1]]);
  assert.equal(await gitlabForge(bad.bin, process.env, HOST).failedJobLog(g.dir, `https://${HOST}/a/b/-/jobs/1`), null);
});

test('merge: PUT на /merge; ошибка GitLab доходит текстом', unix, async (t) => {
  const ok = fakeGlab(t, [['/merge', '{}']]);
  await mrMerge(ok.bin, HOST, ok.dir, process.env, URL_);
  assert.ok(ok.calls()[0].includes(`api --hostname ${HOST} -X PUT ${MR_PATH}/merge`));
  const bad = fakeGlab(t, [['/merge', JSON.stringify({ message: 'Branch cannot be merged' }), 1]]);
  await assert.rejects(mrMerge(bad.bin, HOST, bad.dir, process.env, URL_), /Branch cannot be merged/);
});

test('ошибка glab: последние строки stderr, GITLAB_HOST из окружения не передаётся', unix, async (t) => {
  const g = fakeGlab(t, []);
  await assert.rejects(mrStatus(g.bin, HOST, g.dir, { ...process.env, GITLAB_HOST: 'other.host' }, URL_), /нет маршрута/);
  assert.ok(!g.calls().some((c) => c.startsWith('GITLAB_HOST=')));
  await assert.rejects(mrStatus(g.bin, HOST, g.dir, process.env, 'https://x/y'), /Не похоже на ссылку на MR/);
});

test('readiness: нет glab, не авторизован, готов — и всегда с --hostname', unix, async (t) => {
  assert.match((await mrReadiness(null, HOST, '.', process.env)) ?? '', /glab auth login --hostname gitlab\.company\.ru/);
  const bad = fakeGlab(t, [['auth status', 'токена нет', 1]]);
  assert.match((await mrReadiness(bad.bin, HOST, bad.dir, process.env)) ?? '', /не авторизован на gitlab\.company\.ru/);
  const ok = fakeGlab(t, [['auth status', 'ok']]);
  assert.equal(await mrReadiness(ok.bin, HOST, ok.dir, process.env), null);
  assert.equal(ok.calls()[0], `auth status --hostname ${HOST}`);
});
