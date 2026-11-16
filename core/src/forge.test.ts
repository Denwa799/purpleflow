// Провайдер PR/MR: разбор адреса origin и автоопределение.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { detectForge, parseRemote } from './forge.js';

test('parseRemote: https, scp, ssh с портом, вложенные группы', () => {
  assert.deepEqual(parseRemote('https://github.com/acme/app.git'), { host: 'github.com', path: 'acme/app' });
  assert.deepEqual(parseRemote('https://user:tok@gitlab.company.ru:8443/a/b/c.git/'), { host: 'gitlab.company.ru:8443', path: 'a/b/c' });
  assert.deepEqual(parseRemote('git@gitlab.com:group/sub/proj.git'), { host: 'gitlab.com', path: 'group/sub/proj' });
  assert.deepEqual(parseRemote('ssh://git@ssh.gitlab.company.ru:2222/a/b.git'), { host: 'ssh.gitlab.company.ru', path: 'a/b' });
  assert.equal(parseRemote(''), null);
  assert.equal(parseRemote('/local/path/repo.git'), null);
});

test('detectForge: публичные хосты подтверждены, self-hosted GitLab — предложение', () => {
  assert.deepEqual(detectForge('git@github.com:a/b.git'), {
    host: 'github.com',
    suggested: { kind: 'github', host: 'github.com' },
    confirmed: true,
  });
  assert.deepEqual(detectForge('https://gitlab.com/a/b'), {
    host: 'gitlab.com',
    suggested: { kind: 'gitlab', host: 'gitlab.com' },
    confirmed: true,
  });
  assert.deepEqual(detectForge('git@gitlab.company.ru:a/b.git'), {
    host: 'gitlab.company.ru',
    suggested: { kind: 'gitlab', host: 'gitlab.company.ru' },
    confirmed: false,
  });
  assert.deepEqual(detectForge('git@git.company.ru:a/b.git'), { host: 'git.company.ru', suggested: null, confirmed: false });
  assert.deepEqual(detectForge(null), { host: null, suggested: null, confirmed: false });
});

test('detectForge: порты и ssh-обходы файрвола — те же публичные хосты', () => {
  for (const r of ['ssh://git@ssh.github.com:443/acme/app.git', 'https://github.com:443/acme/app.git']) {
    assert.deepEqual(detectForge(r), { host: 'github.com', suggested: { kind: 'github', host: 'github.com' }, confirmed: true });
  }
  for (const r of ['ssh://git@altssh.gitlab.com:443/acme/app.git', 'git@ssh.gitlab.com:acme/app.git']) {
    assert.deepEqual(detectForge(r), { host: 'gitlab.com', suggested: { kind: 'gitlab', host: 'gitlab.com' }, confirmed: true });
  }
  assert.equal(detectForge('https://gitlab.company.ru:8443/a/b.git').confirmed, false);
});

test('parseRemote: диск Windows — не хост scp-вида', () => {
  assert.equal(parseRemote('C:\\repos\\app.git'), null);
});
