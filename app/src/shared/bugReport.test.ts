import assert from 'node:assert/strict';
import { test } from 'node:test';
import { bugReportUrl, ISSUES_NEW_URL } from './bugReport';

test('bugReportUrl: новый issue с версией, ОС и версиями инструментов, без лишнего', () => {
  const url = new URL(
    bugReportUrl({
      version: '0.3.4',
      os: 'macOS 15.1',
      arch: 'arm64',
      electron: '38.0.0',
      tools: [{ name: 'claude', version: '2.0.0 (Claude Code)\nещё строка' }, { name: 'codex' }],
    }),
  );
  assert.equal(`${url.origin}${url.pathname}`, ISSUES_NEW_URL);
  assert.equal(url.searchParams.get('labels'), 'bug');
  const body = url.searchParams.get('body')!;
  assert.match(body, /- PurpleFlow: 0\.3\.4/);
  assert.match(body, /- ОС: macOS 15\.1 \(arm64\)/);
  assert.match(body, /- claude: 2\.0\.0 \(Claude Code\)\n/);
  assert.match(body, /- codex: не найден/);
});
