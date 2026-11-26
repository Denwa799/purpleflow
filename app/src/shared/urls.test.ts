import assert from 'node:assert/strict';
import { test } from 'node:test';
import { isLocalUrl, isSamePage, isWebUrl, normalizeAddress } from './urls';

test('isLocalUrl: только http(s) на этой машине', () => {
  for (const u of ['http://localhost:3000/a', 'https://127.0.0.1/', 'http://[::1]:5173/']) assert.ok(isLocalUrl(u), u);
  for (const u of [
    'https://example.com',
    'http://localhost.evil.com/',
    'http://localhost@evil.com/',
    'http://127.0.0.1.nip.io/',
    'file:///etc/passwd',
    'javascript:alert(1)',
    'не адрес',
  ])
    assert.ok(!isLocalUrl(u), u);
});

test('isWebUrl: системному браузеру — только http(s)', () => {
  assert.ok(isWebUrl('https://github.com/a'));
  assert.ok(isWebUrl('http://x.test'));
  for (const u of ['file:///Applications/Calculator.app', 'javascript:alert(1)', 'smb://host/share', './README.md'])
    assert.ok(!isWebUrl(u), u);
});

test('isSamePage: параметры и якорь не меняют путь приложения', () => {
  const dev = 'http://localhost:5173/';
  const prod = 'file:///Applications/PurpleFlow.app/out/renderer/index.html';
  assert.ok(isSamePage(`${dev}?view=example#x`, dev));
  assert.ok(isSamePage(prod, prod));
  assert.ok(!isSamePage('https://evil.test/', dev));
  assert.ok(!isSamePage('http://localhost:5173/README.md', dev));
  assert.ok(!isSamePage('file:///tmp/dropped.html', prod));
  assert.ok(!isSamePage('не адрес', dev));
});

test('normalizeAddress: домен — https, локальный — http, путь — от страницы, остальное — поиск', () => {
  assert.equal(normalizeAddress('ya.ru'), 'https://ya.ru');
  assert.equal(normalizeAddress('github.com/anthropics'), 'https://github.com/anthropics');
  assert.equal(normalizeAddress('localhost:3000/admin'), 'http://localhost:3000/admin');
  assert.equal(normalizeAddress('127.0.0.1:5173'), 'http://127.0.0.1:5173');
  assert.equal(normalizeAddress('http://example.com'), 'http://example.com');
  assert.equal(normalizeAddress('/login', 'http://localhost:3000/app'), 'http://localhost:3000/login');
  assert.equal(
    normalizeAddress('как работает git rebase'),
    'https://www.google.com/search?q=%D0%BA%D0%B0%D0%BA%20%D1%80%D0%B0%D0%B1%D0%BE%D1%82%D0%B0%D0%B5%D1%82%20git%20rebase',
  );
  assert.equal(normalizeAddress(''), 'about:blank');
});
