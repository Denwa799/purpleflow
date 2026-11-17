// «Что нового»: выпуски с GitHub. Описание выпуска — его заметки; пустое — заменяем заголовками коммитов от прошлого выпуска.

export const RELEASES_API = 'https://api.github.com/repos/PurpleSchool/purpleflow';

export interface Release {
  version: string;
  /** ISO-дата публикации. */
  date: string;
  /** Markdown: заметки выпуска или список коммитов. */
  notes: string;
  url: string;
}

/** Сравнение версий вида 0.3.4 (префикс v допустим). */
export function compareVersions(a: string, b: string): number {
  const p = (v: string) =>
    v
      .replace(/^v/, '')
      .split(/[.-]/)
      .map((x) => Number.parseInt(x, 10) || 0);
  const x = p(a);
  const y = p(b);
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const d = (x[i] ?? 0) - (y[i] ?? 0);
    if (d) return d;
  }
  return 0;
}

interface GhRelease {
  tag_name?: unknown;
  draft?: unknown;
  prerelease?: unknown;
  published_at?: unknown;
  body?: unknown;
  html_url?: unknown;
}

/** Опубликованные выпуски из ответа /releases, новые — первыми. Черновики и пред-выпуски пропускаем. */
export function parseReleases(json: unknown): Release[] {
  if (!Array.isArray(json)) return [];
  return (json as GhRelease[])
    .filter((r) => typeof r?.tag_name === 'string' && !r.draft && !r.prerelease && typeof r.published_at === 'string')
    .map((r) => ({
      version: String(r.tag_name).replace(/^v/, ''),
      date: String(r.published_at),
      notes: typeof r.body === 'string' ? r.body.trim() : '',
      url: typeof r.html_url === 'string' ? r.html_url : '',
    }))
    .sort((a, b) => compareVersions(b.version, a.version));
}

/** Заметки из коммитов сравнения двух тегов: первая строка каждого, без коммитов выпуска и слияний. */
export function notesFromCommits(json: unknown): string {
  const commits = (json as { commits?: { commit?: { message?: unknown } }[] } | null)?.commits;
  if (!Array.isArray(commits)) return '';
  const lines = commits
    .map((c) => (typeof c?.commit?.message === 'string' ? c.commit.message.split('\n')[0].trim() : ''))
    .filter((s) => s && !/^(Версия|Version|Release)\s+v?\d/i.test(s) && !/^Merge\b/.test(s))
    .reverse();
  return lines.map((s) => `- ${s}`).join('\n');
}

/**
 * Показать «Что нового» сами: после обновления версия выросла по сравнению с той, что пользователь уже видел.
 * Первый запуск (seen пусто) — молчим: нового для него нет, всё новое.
 */
export function shouldShowWhatsNew(seen: string, current: string): boolean {
  return Boolean(seen) && compareVersions(current, seen) > 0;
}

/** Выпуски новее seen и не новее current — то, что появилось с прошлого раза. */
export function releasesBetween(list: Release[], seen: string, current: string): Release[] {
  return list.filter((r) => compareVersions(r.version, seen) > 0 && compareVersions(r.version, current) <= 0);
}
