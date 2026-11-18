import type { ChatSummary, ProjectListItem } from '@purpleflow/core';

/** Последние проекты для боковой панели: по последнему прогону или чату, смотря что позже; без истории — по дате подключения. */
export function recentProjects(projects: ProjectListItem[], chats: ChatSummary[], limit = 5): ProjectListItem[] {
  const at = (p: ProjectListItem) => {
    let t = p.lastRunAt ?? '';
    for (const c of chats) if ((c.projectPath === p.path || (p.root && c.projectPath === p.root)) && c.updatedAt > t) t = c.updatedAt;
    return t || `0${p.updatedAt ?? ''}`;
  };
  return projects
    .filter((p) => p.exists)
    .map((p) => ({ p, t: at(p) }))
    .sort((a, b) => b.t.localeCompare(a.t))
    .slice(0, limit)
    .map((x) => x.p);
}
