import { app, net } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import { notesFromCommits, parseReleases, RELEASES_API, type Release } from '../shared/releases';

/**
 * Выпуски для «Что нового»: публичный API GitHub, без токена и данных пользователя.
 * Без заметок у выпуска берём заголовки коммитов от прошлого выпуска. Ответ кэшируется на диске:
 * без сети окно показывает последний удачный список.
 */
const TTL_MS = 60 * 60_000;
const TIMEOUT_MS = 10_000;
/** Сколько выпусков без заметок дополнять коммитами: у GitHub 60 запросов в час без токена. */
const FILL_LIMIT = 6;
const file = () => path.join(app.getPath('userData'), 'releases.json');

export interface ReleasesResult {
  releases: Release[];
  /** Сеть или GitHub недоступны — список из кэша (или пустой). */
  error?: string;
}

let memo: { at: number; releases: Release[] } | null = null;
let inflight: Promise<ReleasesResult> | null = null;

const getJson = async (url: string): Promise<unknown> => {
  const res = await net.fetch(url, {
    headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'PurpleFlow' },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`GitHub ответил ${res.status}`);
  return res.json();
};

function readCache(): Release[] | null {
  try {
    const list = JSON.parse(fs.readFileSync(file(), 'utf8')) as Release[];
    return Array.isArray(list) ? list : null;
  } catch {
    return null;
  }
}

async function fetchReleases(): Promise<Release[]> {
  // Для сквозных тестов: готовый список из файла вместо GitHub (только в разработке).
  const fake = !app.isPackaged ? process.env.PURPLEFLOW_RELEASES_FILE : undefined;
  if (fake) return JSON.parse(fs.readFileSync(fake, 'utf8')) as Release[];
  const list = parseReleases(await getJson(`${RELEASES_API}/releases?per_page=30`));
  // Заметки старых выпусков без описания возьмём из кэша: коммиты между тегами не меняются.
  const cached = new Map((memo?.releases ?? readCache() ?? []).map((r) => [r.version, r.notes]));
  let filled = 0;
  for (let i = 0; i < list.length; i++) {
    const r = list[i];
    if (r.notes) continue;
    r.notes = cached.get(r.version) ?? '';
    const prev = list[i + 1];
    if (r.notes || !prev || filled >= FILL_LIMIT) continue;
    filled++;
    r.notes = await getJson(`${RELEASES_API}/compare/${prev.version}...${r.version}`)
      .then(notesFromCommits)
      .catch(() => '');
  }
  return list;
}

async function load(): Promise<ReleasesResult> {
  try {
    const releases = await fetchReleases();
    memo = { at: Date.now(), releases };
    try {
      fs.writeFileSync(file(), JSON.stringify(releases));
    } catch {
      /* без кэша на диске — список есть в памяти */
    }
    return { releases };
  } catch (e) {
    return { releases: memo?.releases ?? readCache() ?? [], error: (e as Error).message };
  }
}

export function releases(): Promise<ReleasesResult> {
  if (memo && Date.now() - memo.at < TTL_MS) return Promise.resolve({ releases: memo.releases });
  inflight ??= load().finally(() => (inflight = null));
  return inflight;
}
