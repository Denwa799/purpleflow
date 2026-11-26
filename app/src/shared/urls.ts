// Куда можно уходить окну и вкладке «Браузер». Без Electron — чтобы проверялось тестами.

/** Адрес на этой машине: вкладка «Браузер» показывает только приложение проекта. */
export function isLocalUrl(u: string): boolean {
  try {
    const { protocol, hostname } = new URL(u);
    return /^https?:$/.test(protocol) && ['localhost', '127.0.0.1', '[::1]', '::1'].includes(hostname);
  } catch {
    return false;
  }
}

/** Ссылка, которую можно отдать системному браузеру. */
export function isWebUrl(u: string): boolean {
  try {
    return /^https?:$/.test(new URL(u).protocol);
  } catch {
    return false;
  }
}

/** Тот же путь приложения без учёта параметров и якоря: такой адрес не открываем в системном браузере. */
export function isSamePage(target: string, current: string): boolean {
  try {
    const a = new URL(target);
    const b = new URL(current);
    return a.origin === b.origin && a.pathname === b.pathname && a.protocol === b.protocol;
  } catch {
    return false;
  }
}

/** Адрес из адресной строки: путь — от текущей страницы, домен — по https (локальный — по http), остальное — поиск. */
export function normalizeAddress(t: string, base?: string): string {
  const v = t.trim();
  if (!v) return 'about:blank';
  if (v.startsWith('/') && base && isWebUrl(base)) return new URL(v, base).toString();
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(v) || v === 'about:blank') return v;
  if (/^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?(\/.*)?$/i.test(v)) return `http://${v}`;
  if (/^[^\s/]+\.[a-z]{2,}(:\d+)?(\/\S*)?$/i.test(v)) return `https://${v}`;
  return `https://www.google.com/search?q=${encodeURIComponent(v)}`;
}
