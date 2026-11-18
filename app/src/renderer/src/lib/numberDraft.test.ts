import assert from 'node:assert/strict';
import { test } from 'node:test';
import { liveNumber, settleNumber } from './numberDraft';

const r = { min: 1, max: 8, fallback: 2 };

test('liveNumber: стёртое поле не подменяется значением по умолчанию, пока человек печатает', () => {
  assert.equal(liveNumber('', r), null);
  assert.equal(liveNumber('-', r), null);
  assert.equal(liveNumber('0', r), null, 'вне пределов — ждём, а не исправляем под рукой');
  assert.equal(liveNumber('12', r), null);
  assert.equal(liveNumber('5', r), 5);
  assert.equal(liveNumber(' 7 ', r), 7);
  assert.equal(liveNumber('25', { min: 1, fallback: 10 }), 25, 'без max — любое от min');
});

test('settleNumber: при уходе из поля — значение по умолчанию или ближайшая граница', () => {
  assert.equal(settleNumber('', r), 2);
  assert.equal(settleNumber('abc', r), 2);
  assert.equal(settleNumber('0', r), 1);
  assert.equal(settleNumber('12', r), 8);
  assert.equal(settleNumber('4', r), 4);
});
