import { test } from 'node:test';
import assert from 'node:assert/strict';
import { layoutGraph } from './gitGraph';

test('layoutGraph: линейная история — одна колонка', () => {
  const rows = layoutGraph([
    { hash: 'c', parents: ['b'] },
    { hash: 'b', parents: ['a'] },
    { hash: 'a', parents: [] },
  ]);
  assert.deepEqual(
    rows.map((r) => r.col),
    [0, 0, 0],
  );
  assert.deepEqual(rows[0].top, []);
  assert.deepEqual(rows[2].bottom, []);
});

test('layoutGraph: слияние расходится во вторую колонку и сходится обратно', () => {
  // m — слияние f в main; f и x — параллельные ветки от a.
  const rows = layoutGraph([
    { hash: 'm', parents: ['x', 'f'] },
    { hash: 'f', parents: ['a'] },
    { hash: 'x', parents: ['a'] },
    { hash: 'a', parents: [] },
  ]);
  assert.deepEqual(
    rows.map((r) => r.col),
    [0, 1, 0, 0],
  );
  // Из точки слияния — линия в колонку 1.
  assert.ok(rows[0].bottom.some((s) => s.from === 0 && s.to === 1));
  // В «a» сходятся обе линии.
  assert.deepEqual(rows[3].top.map((s) => [s.from, s.to]).sort(), [
    [0, 0],
    [1, 0],
  ]);
  assert.equal(Math.max(...rows.map((r) => r.width)), 2);
});

test('layoutGraph: несколько вершин веток занимают свободные колонки', () => {
  const rows = layoutGraph([
    { hash: 'b2', parents: ['a'] },
    { hash: 'b1', parents: ['a'] },
    { hash: 'a', parents: [] },
  ]);
  assert.deepEqual(
    rows.map((r) => r.col),
    [0, 1, 0],
  );
});
