// «Сообщить о проблеме»: новый issue на GitHub с версией и окружением. Без путей, проектов и данных пользователя.

export const ISSUES_NEW_URL = 'https://github.com/PurpleSchool/purpleflow/issues/new';

export interface BugEnv {
  version: string;
  os: string;
  arch: string;
  electron: string;
  /** Включённые агенты и инструменты: имя и версия (или «не найден»). */
  tools: { name: string; version?: string }[];
}

/** Версия CLI без лишнего: первая строка, до 60 знаков. */
const short = (v?: string) => (v ? v.split('\n')[0].trim().slice(0, 60) : 'не найден');

export function bugReportUrl(env: BugEnv): string {
  const body = [
    '### Что случилось',
    '',
    '<!-- Опишите, что делали и что пошло не так. Скриншоты можно перетащить прямо сюда. -->',
    '',
    '### Что ожидали',
    '',
    '',
    '### Окружение',
    '',
    `- PurpleFlow: ${env.version}`,
    `- ОС: ${env.os} (${env.arch})`,
    `- Electron: ${env.electron}`,
    ...env.tools.map((t) => `- ${t.name}: ${short(t.version)}`),
  ].join('\n');
  const q = new URLSearchParams({ title: '', body, labels: 'bug' });
  return `${ISSUES_NEW_URL}?${q.toString()}`;
}
