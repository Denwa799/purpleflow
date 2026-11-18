import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildTree } from './fileTree';
import { insertMention } from './mentions';

test('buildTree: папки из путей, сначала папки, затем файлы', () => {
  const t = buildTree(['src/b.ts', 'README.md', 'src/api/x.ts', 'src/a.ts', '.gitignore']);
  assert.deepEqual(
    t.map((n) => n.name),
    ['src', '.gitignore', 'README.md'],
  );
  assert.deepEqual(
    t[0].children!.map((n) => n.path),
    ['src/api', 'src/a.ts', 'src/b.ts'],
  );
  assert.equal(t[0].children![0].children![0].path, 'src/api/x.ts');
});

test('insertMention: «@путь» в позицию курсора с пробелами по краям', () => {
  assert.deepEqual(insertMention('', 0, 'src/a.ts'), { text: '@src/a.ts ', caret: 10 });
  assert.deepEqual(insertMention('глянь', 5, 'a.ts'), { text: 'глянь @a.ts ', caret: 12 });
  assert.deepEqual(insertMention('глянь и скажи', 5, 'a.ts'), { text: 'глянь @a.ts и скажи', caret: 11 });
});

test('langOfContent: незнакомое расширение — по содержимому', async () => {
  const { langOfContent, langOf } = await import('./lang');
  assert.equal(langOfContent('design/av.pen', '{\n  "version": "2.11"'), 'json');
  assert.equal(langOfContent('scripts/run', '#!/usr/bin/env bash\necho'), 'shell');
  assert.equal(langOfContent('src/a.ts', '{'), 'typescript');
  assert.equal(langOf('Dockerfile'), 'dockerfile');
  assert.equal(langOfContent('notes.txt', 'просто текст'), 'plaintext');
});
