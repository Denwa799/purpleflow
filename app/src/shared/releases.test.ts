import assert from 'node:assert/strict';
import { test } from 'node:test';
import { compareVersions, notesFromCommits, parseReleases, releasesBetween, shouldShowWhatsNew } from './releases';

test('compareVersions: числа, а не строки; префикс v', () => {
  assert.ok(compareVersions('0.10.0', '0.9.9') > 0);
  assert.equal(compareVersions('v0.3.4', '0.3.4'), 0);
  assert.ok(compareVersions('0.3', '0.3.1') < 0);
});

test('parseReleases: без черновиков и пред-выпусков, новые первыми, пустое описание — пустые заметки', () => {
  const list = parseReleases([
    { tag_name: '0.3.2', draft: true, published_at: null, body: '' },
    { tag_name: '0.3.3', published_at: '2026-11-13T08:00:00Z', body: ' ### Добавлено\n- x ', html_url: 'u3' },
    { tag_name: '0.3.4', published_at: '2026-11-13T14:00:00Z', body: null },
    { tag_name: '0.4.0-beta', prerelease: true, published_at: '2026-11-14T00:00:00Z' },
  ]);
  assert.deepEqual(
    list.map((r) => [r.version, r.notes]),
    [
      ['0.3.4', ''],
      ['0.3.3', '### Добавлено\n- x'],
    ],
  );
  assert.deepEqual(parseReleases({ message: 'rate limit' }), []);
});

test('notesFromCommits: первые строки по порядку, без коммита версии и слияний', () => {
  const notes = notesFromCommits({
    commits: [
      { commit: { message: 'OpenCode как третий агент\n\nподробности' } },
      { commit: { message: 'Merge branch x' } },
      { commit: { message: 'Картинки в чате' } },
      { commit: { message: 'Версия 0.3.4' } },
    ],
  });
  // GitHub отдаёт коммиты от старых к новым — показываем новые сверху.
  assert.equal(notes, '- Картинки в чате\n- OpenCode как третий агент');
  assert.equal(notesFromCommits(null), '');
});

test('shouldShowWhatsNew и releasesBetween: только после обновления, только новое', () => {
  assert.equal(shouldShowWhatsNew('', '0.3.4'), false);
  assert.equal(shouldShowWhatsNew('0.3.4', '0.3.4'), false);
  assert.equal(shouldShowWhatsNew('0.3.3', '0.3.4'), true);
  const list = parseReleases(
    ['0.3.0', '0.3.3', '0.3.4', '0.3.5'].map((v) => ({ tag_name: v, published_at: '2026-11-01T00:00:00Z', body: v })),
  );
  assert.deepEqual(
    releasesBetween(list, '0.3.0', '0.3.4').map((r) => r.version),
    ['0.3.4', '0.3.3'],
  );
});
