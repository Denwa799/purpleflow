import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { ChatSummary, ProjectListItem } from '@purpleflow/core';
import { recentProjects } from './recentProjects';

const proj = (path: string, o: Partial<ProjectListItem> = {}): ProjectListItem => ({
  path,
  configured: true,
  exists: true,
  runs: 0,
  active: 0,
  lastRunAt: null,
  ...o,
});
const chat = (projectPath: string, updatedAt: string): ChatSummary => ({
  id: projectPath + updatedAt,
  title: 'ч',
  projectPath,
  agent: 'claude',
  updatedAt,
  busy: false,
  last: 'ok',
});

test('recentProjects: по последнему прогону или чату, пропавшие папки не показаны, не больше лимита', () => {
  const projects = [
    proj('/a', { lastRunAt: '2026-11-10T00:00:00Z' }),
    proj('/b', { lastRunAt: '2026-11-01T00:00:00Z' }),
    proj('/c', { updatedAt: '2026-11-17T00:00:00Z' }),
    proj('/gone', { exists: false, lastRunAt: '2026-11-18T00:00:00Z' }),
    proj('/multi/api', { root: '/multi' }),
  ];
  const chats = [chat('/b', '2026-11-15T00:00:00Z'), chat('/multi', '2026-11-12T00:00:00Z')];
  assert.deepEqual(
    recentProjects(projects, chats).map((p) => p.path),
    ['/b', '/multi/api', '/a', '/c'],
  );
  assert.equal(recentProjects(projects, chats, 2).length, 2);
});
