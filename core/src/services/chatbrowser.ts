// Браузер чата — один на человека и агента. В приложении это настоящие <webview> окна: агенту их отдаёт мост
// main-процесса (app/src/main/chatweb.ts) по CDP, pw подключается к нему. Без моста (ядро вне приложения) —
// Chrome без окна, который открывает ядро. Его вкладки — вкладки панели
// «Браузер»: экран выбранной транслируется кадрами, ввод человека уходит в неё по CDP. Агент работает в том же Chrome
// через Playwright (`pw attach`), поэтому видит вкладки человека, а человек — вкладки агента.
// В песочнице «Правок» (claude, codex) pw вызывается через node без npx, сокет сессии песочница пропускает.
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { prependPath, which } from '../env.js';
import type { Kernel } from '../kernel.js';
import { freePort } from '../net.js';
import { killGroup, run } from '../proc.js';
import { Screencast, findChrome, waitForCdp } from '../screencast.js';
import { playwrightCliPath } from '../stages/selfcheck.js';

/** Сообщение похоже на просьбу про веб — браузер открываем заранее. */
const WEBBY =
  /https?:\/\/|www\.|\b[\w-]+\.(com|ru|org|net|io|dev|app|me|co|info|рф)\b|localhost|браузер|сайт|страниц|вкладк|открой|зайди|гугл|google|яндекс|загугли|в интернете|поищи|скриншот|chrome|playwright/i;

interface Live {
  port: number;
  cast: Screencast;
  dir: string;
  /** pw подключён к этому Chrome (агенту можно работать). */
  attached: boolean;
}
/** Открытые браузеры чатов. */
const live = new Map<string, Live>();
/** Открытие в процессе — второй запрос ждёт того же. */
const opening = new Map<string, Promise<Live | null>>();
let cliPath: Promise<string | null> | null = null;

/** Имя сессии Playwright — по всему id чата: у разных чатов начало id совпадает («chat-…»). */
const sessionOf = (id: string) => `pf-${id.replace(/[^\w-]/g, '').slice(0, 40)}`;
const groupOf = (id: string) => `chat:${id}:browser`;
const browserDir = (chatDir: string) => path.join(chatDir, 'browser');

/** Временная папка ядра: там Playwright CLI держит сокет сессии. В песочнице у агента своя — pw закрепляет нашу. */
const tmpRoot = (k: Kernel) => {
  try {
    return fs.realpathSync(k.opts.env.TMPDIR || os.tmpdir());
  } catch {
    return os.tmpdir();
  }
};

/** pw для песочницы: node и Playwright CLI напрямую, без npx, и та же временная папка, что у ядра. */
function writeSandboxPw(dir: string, session: string, node: string, cli: string, tmp: string): void {
  fs.writeFileSync(
    path.join(dir, 'pw'),
    `#!/bin/sh\nexport TMPDIR="${tmp}/"\ncd "${dir}" && exec "${node}" "${cli}" -s=${session} "$@"\n`,
    { mode: 0o755 },
  );
}

/**
 * Папки сокетов Playwright CLI во временной папке: pw-<хэш>/cli. Сокет сессии с длинным именем называется
 * одним хэшем, поэтому разрешаем папку целиком — в ней только сокеты Playwright.
 */
function socketDirs(tmp: string): string[] {
  try {
    return fs
      .readdirSync(tmp)
      .filter((d) => d.startsWith('pw-'))
      .map((d) => path.join(tmp, d, 'cli'))
      .filter((d) => fs.existsSync(d));
  } catch {
    return [];
  }
}

/** Мост main-процесса к webview окна: порт и ключ подписи адресов (см. app/src/main/chatweb.ts). */
let bridge: { port: number; key: string } | null = null;
export function setChatWebBridge(b: { port: number; key: string } | null): void {
  bridge = b;
}
/** Адрес CDP чата у моста — подпись та же, что в chatWebEndpoint. */
const webEndpoint = (b: { port: number; key: string }, id: string) =>
  `ws://127.0.0.1:${b.port}/cdp/${Buffer.from(id).toString('base64url')}/${crypto
    .createHmac('sha256', Buffer.from(b.key, 'hex'))
    .update(id)
    .digest('hex')
    .slice(0, 32)}`;
/** Чаты, где браузер открыт в окне (человек открыл вкладку) или pw уже подключён к мосту. */
const webOpen = new Set<string>();
const webAttached = new Set<string>();

/** Выключить браузер чата: тесты и e2e (PURPLEFLOW_CHAT_BROWSER=off). */
const disabled = (k: Kernel) => (k.opts.env.PURPLEFLOW_CHAT_BROWSER ?? process.env.PURPLEFLOW_CHAT_BROWSER) === 'off';

/**
 * Можно ли браузер чата на этой машине: есть Chrome, не Windows (pw без npx там не собрать), не выключен.
 * Нет — окно показывает свой встроенный браузер, а агенту браузера нет.
 */
export function chatBrowserAvailable(k: Kernel): 'webview' | 'stream' | false {
  if (disabled(k) || process.platform === 'win32') return false;
  if (bridge) return 'webview';
  return findChrome(k.opts.env) ? 'stream' : false;
}

/** Подключить pw агента к вкладкам окна через мост. Вкладок нет — мост попросит окно открыть пустую. */
async function ensureWebAttached(k: Kernel, id: string, dir: string): Promise<boolean> {
  const b = bridge;
  if (!b) return false;
  const pw = path.join(dir, 'pw');
  if (webAttached.has(id) && fs.existsSync(pw)) return true;
  const node = which('node', k.opts.env);
  cliPath ??= playwrightCliPath(k.opts.env, dir).catch(() => null);
  const cli = node ? await cliPath : null;
  if (!node || !cli) return false;
  writeSandboxPw(dir, sessionOf(id), node, cli, tmpRoot(k));
  const r = await run(pw, ['attach', `--cdp=${webEndpoint(b, id)}`], {
    cwd: dir,
    env: k.opts.env,
    group: `${groupOf(id)}:pw`,
    timeoutMs: 120_000,
  });
  if (r.code === 0) webAttached.add(id);
  return r.code === 0;
}

async function alive(l: Live): Promise<boolean> {
  return waitForCdp(l.port, () => false, 1500);
}

/** Открыть Chrome чата (или вернуть открытый): без окна, с портом отладки, кадры — в окно. */
async function ensureChrome(k: Kernel, id: string, chatDir: string): Promise<Live | null> {
  const cur = live.get(id);
  if (cur && (await alive(cur))) return cur;
  if (cur) await stopLive(id);
  const pending = opening.get(id);
  if (pending) return pending;
  const p = (async (): Promise<Live | null> => {
    const chrome = findChrome(k.opts.env);
    if (!chrome) return null;
    const dir = browserDir(chatDir);
    fs.mkdirSync(dir, { recursive: true });
    const port = await freePort();
    void run(
      chrome,
      [
        '--headless=new',
        `--remote-debugging-port=${port}`,
        '--remote-debugging-address=127.0.0.1',
        `--user-data-dir=${path.join(dir, 'chrome-profile')}`,
        '--no-first-run',
        '--no-default-browser-check',
        '--window-size=1280,860',
        '--force-device-scale-factor=2',
        'about:blank',
      ],
      { cwd: dir, env: k.opts.env, group: groupOf(id) },
    ).catch(() => undefined);
    if (!(await waitForCdp(port, () => false))) {
      await killGroup(groupOf(id));
      return null;
    }
    const cast = new Screencast(
      port,
      (frame) => k.emit({ type: 'visual.frame', runId: id, frame }),
      // Человек работает с этим браузером руками — до ~30 кадров в секунду, а не 4, как в наблюдении за этапом.
      33,
      (tabs, active) => k.emit({ type: 'browser.tabs', chatId: id, tabs, active }),
      700,
      (loading, tab) => k.emit({ type: 'browser.loading', chatId: id, tab, loading }),
    );
    cast.quality = 70;
    cast.start();
    const l: Live = { port, cast, dir, attached: false };
    live.set(id, l);
    return l;
  })().finally(() => opening.delete(id));
  opening.set(id, p);
  return p;
}

/** Подключить pw к Chrome чата — агенту. Playwright CLI скачивается при первом разе. */
async function ensureAttached(k: Kernel, id: string, l: Live): Promise<boolean> {
  const pw = path.join(l.dir, 'pw');
  if (l.attached && fs.existsSync(pw)) return true;
  const node = which('node', k.opts.env);
  cliPath ??= playwrightCliPath(k.opts.env, l.dir).catch(() => null);
  const cli = node ? await cliPath : null;
  if (!node || !cli) return false;
  writeSandboxPw(l.dir, sessionOf(id), node, cli, tmpRoot(k));
  const r = await run(pw, ['attach', `--cdp=http://127.0.0.1:${l.port}`], {
    cwd: l.dir,
    env: k.opts.env,
    group: `${groupOf(id)}:pw`,
    timeoutMs: 120_000,
  });
  l.attached = r.code === 0;
  return l.attached;
}

export interface ChatBrowser {
  /** Блок для системного промпта: команды pw и правила. */
  block: string;
  /** Пометка в сообщение хода: открыт ли браузер сейчас — системный промпт уходит только в начале сессии. */
  note: string;
  /** Окружение агента: pw в PATH. */
  env: NodeJS.ProcessEnv;
  /** Папка скриншотов — агенту на чтение. */
  dir: string;
  /** claude в песочнице: папки сокетов Playwright — подключение к браузеру разрешаем. */
  sockets?: string[];
}

/**
 * Браузер на ход чата. null — в «Вопросах» (команд нет) и где браузера чата нет (см. chatBrowserAvailable).
 * Открыт человеком или сообщение про веб — подключаем агента к тому же Chrome.
 */
export async function chatBrowser(k: Kernel, o: { id: string; dir: string; text: string; readOnly: boolean }): Promise<ChatBrowser | null> {
  if (o.readOnly || !chatBrowserAvailable(k)) return null;
  const dir = browserDir(o.dir);
  fs.mkdirSync(dir, { recursive: true });
  const block = k.prompts.render('chat-browser.md', { dir });
  let ready = false;
  if (chatBrowserAvailable(k) === 'webview') {
    if (webOpen.has(o.id) || webAttached.has(o.id) || WEBBY.test(o.text)) ready = await ensureWebAttached(k, o.id, dir).catch(() => false);
  } else if (live.has(o.id) || WEBBY.test(o.text)) {
    const l = await ensureChrome(k, o.id, o.dir).catch(() => null);
    ready = Boolean(l && (await ensureAttached(k, o.id, l).catch(() => false)));
  }
  const socks = ready ? socketDirs(tmpRoot(k)) : [];
  return {
    dir,
    env: prependPath(k.opts.env, dir),
    block,
    sockets: socks.length ? socks : undefined,
    note: ready
      ? '[PurpleFlow: браузер открыт и подключён к pw — общий с человеком: `pw tab-list` покажет и его вкладки. Переходи командой `pw goto <url>`.]'
      : '[PurpleFlow: браузер сейчас не запущен. Если он нужен — скажи человеку попросить открыть сайт ещё раз (например, «открой браузер») или открыть его во вкладке «Браузер».]',
  };
}

async function stopLive(id: string) {
  live.get(id)?.cast.stop();
  live.delete(id);
}

/** Чат удалён — его браузер закрывается, трансляция гаснет. */
export async function closeChatBrowser(k: Kernel, id: string, chatDir: string): Promise<void> {
  const had = live.has(id);
  webOpen.delete(id);
  webAttached.delete(id);
  await stopLive(id);
  const pw = path.join(browserDir(chatDir), 'pw');
  if (fs.existsSync(pw)) await run(pw, ['close'], { cwd: browserDir(chatDir), env: k.opts.env, timeoutMs: 20_000 }).catch(() => undefined);
  await killGroup(groupOf(id));
  if (had) {
    k.emit({ type: 'visual.frame', runId: id, frame: null });
    k.emit({ type: 'browser.tabs', chatId: id, tabs: [], active: null });
  }
}

/** Действие человека в браузере чата из панели «Браузер». */
export type ChatBrowserAction =
  /** Вкладки и показываемая сейчас; open — открыть браузер, если ещё не открыт. */
  | { type: 'tabs'; open?: boolean }
  /** Окно открыло браузер чата (webview): агент подключится к нему в следующем ходе. */
  | { type: 'opened' }
  | { type: 'newTab'; url: string }
  | { type: 'closeTab' | 'select'; tab: string }
  | { type: 'navigate'; url: string }
  | { type: 'back' | 'forward' | 'reload' | 'state' }
  | { type: 'mobile'; on: boolean }
  /** x, y — доли кадра (0…1): ядро переводит их в точку страницы. */
  | { type: 'mouse'; event: 'move' | 'down' | 'up'; x: number; y: number; button?: 'left' | 'right' | 'middle'; clicks?: number }
  | { type: 'wheel'; x: number; y: number; dx: number; dy: number }
  | { type: 'key'; key: string; code?: string; text?: string; keyCode?: number; modifiers?: number }
  /** Скрипт в странице: выбор элемента «Указать элемент». */
  | { type: 'eval'; expression: string };

const MOBILE_UA =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1';
let desktopUa: string | null = null;

/** Состояние показываемой вкладки для панели: можно ли назад/вперёд. */
export interface ChatBrowserState {
  back: boolean;
  forward: boolean;
}
export interface ChatBrowserTabs {
  tabs: { id: string; url: string; title: string }[];
  active: string | null;
}

const webUrl = (u: string) => /^https?:\/\//.test(u) || u === 'about:blank';

/** Выполнить действие человека в браузере чата. */
export async function controlChatBrowser(
  k: Kernel,
  id: string,
  chatDir: string,
  a: ChatBrowserAction,
): Promise<ChatBrowserState | ChatBrowserTabs | unknown> {
  if (!chatBrowserAvailable(k)) throw new Error('Браузер чата недоступен на этой машине');
  if (a.type === 'opened') {
    webOpen.add(id);
    return null;
  }
  // Открыть вкладку можно и до агента — браузер поднимается по первому запросу.
  const l = a.type === 'newTab' || (a.type === 'tabs' && a.open) ? await ensureChrome(k, id, chatDir) : live.get(id);
  if (!l) {
    if (a.type === 'tabs') return { tabs: [], active: null } satisfies ChatBrowserTabs;
    throw new Error('Браузер чата сейчас не открыт');
  }
  const { cast } = l;
  const http = (p: string, method = 'GET') => fetch(`http://127.0.0.1:${l.port}${p}`, { method, signal: AbortSignal.timeout(10_000) });
  const tabs = async (): Promise<ChatBrowserTabs> => {
    const list = (await (await http('/json/list')).json()) as { id: string; type: string; url: string; title: string }[];
    return {
      tabs: list
        .filter((t) => t.type === 'page' && !/^(chrome|devtools|chrome-extension):/.test(t.url))
        .map((t) => ({ id: t.id, url: t.url, title: t.title })),
      active: cast.active,
    };
  };
  const history = async (): Promise<ChatBrowserState & { index: number; entries: { id: number }[] }> => {
    const h = await cast.command<{ currentIndex: number; entries: { id: number }[] }>('Page.getNavigationHistory');
    return { back: h.currentIndex > 0, forward: h.currentIndex < h.entries.length - 1, index: h.currentIndex, entries: h.entries };
  };
  // Сразу после перехода страница ещё грузится и историю не отдаёт — пробуем ещё раз; не вышло — панель спросит позже.
  const settled = async (): Promise<ChatBrowserState | null> => {
    for (let i = 0; i < 4; i++) {
      try {
        const h = await history();
        return { back: h.back, forward: h.forward };
      } catch {
        await new Promise((r) => setTimeout(r, 300));
      }
    }
    return null;
  };
  const at = (x: number, y: number) => ({ x: Math.round(x * (cast.size.width || 1280)), y: Math.round(y * (cast.size.height || 860)) });
  switch (a.type) {
    case 'tabs':
      return tabs();
    case 'newTab': {
      if (!webUrl(a.url)) throw new Error('Только адреса http(s)');
      // Показываемая вкладка пустая (Chrome только открылся или «+») — адрес открываем в ней, а не рядом.
      const now = await tabs();
      const blank = now.tabs.find((t) => t.id === cast.active && t.url === 'about:blank');
      if (blank && a.url !== 'about:blank') {
        await cast.command('Page.navigate', { url: a.url });
        return { ...(await tabs()), active: blank.id };
      }
      // Новая вкладка — через HTTP Chrome; сразу показываем её.
      const made = (await (await http(`/json/new?${encodeURI(a.url)}`, 'PUT')).json()) as { id?: string };
      if (made.id) await cast.select(made.id);
      return tabs();
    }
    case 'closeTab': {
      const list = await tabs();
      // Последнюю не закрываем — иначе Chrome останется без страниц; вместо этого — пустая.
      if (list.tabs.length <= 1) await http(`/json/new?about:blank`, 'PUT');
      await http(`/json/close/${encodeURIComponent(a.tab)}`);
      return tabs();
    }
    case 'select':
      await cast.select(a.tab);
      await http(`/json/activate/${encodeURIComponent(a.tab)}`).catch(() => undefined);
      return tabs();
    case 'navigate':
      if (!webUrl(a.url)) throw new Error('Только адреса http(s)');
      await cast.command('Page.navigate', { url: a.url });
      return settled();
    case 'back':
    case 'forward': {
      const h = await history();
      const to = h.entries[h.index + (a.type === 'back' ? -1 : 1)];
      if (to) await cast.command('Page.navigateToHistoryEntry', { entryId: to.id });
      return settled();
    }
    case 'reload':
      await cast.command('Page.reload');
      return settled();
    case 'state':
      return settled();
    case 'mobile': {
      if (!desktopUa) {
        const v = await cast.command<{ userAgent: string }>('Browser.getVersion').catch(() => null);
        desktopUa = v?.userAgent.replace('HeadlessChrome', 'Chrome') ?? null;
      }
      if (a.on) {
        await cast.command('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 3, mobile: true });
        await cast.command('Emulation.setUserAgentOverride', { userAgent: MOBILE_UA });
      } else {
        await cast.command('Emulation.clearDeviceMetricsOverride');
        if (desktopUa) await cast.command('Emulation.setUserAgentOverride', { userAgent: desktopUa });
      }
      await cast.command('Page.reload');
      return settled();
    }
    case 'mouse': {
      const p = at(a.x, a.y);
      const type = a.event === 'move' ? 'mouseMoved' : a.event === 'down' ? 'mousePressed' : 'mouseReleased';
      await cast.command('Input.dispatchMouseEvent', {
        type,
        ...p,
        button: a.event === 'move' ? 'none' : (a.button ?? 'left'),
        clickCount: a.event === 'move' ? 0 : (a.clicks ?? 1),
      });
      return null;
    }
    case 'wheel': {
      const p = at(a.x, a.y);
      await cast.command('Input.dispatchMouseEvent', { type: 'mouseWheel', ...p, deltaX: a.dx, deltaY: a.dy });
      return null;
    }
    case 'key': {
      // Печатный символ — вставкой текста; служебные клавиши — нажатием.
      if (a.text && a.text.length === 1 && !(a.modifiers ?? 0)) {
        await cast.command('Input.insertText', { text: a.text });
        return null;
      }
      const base = {
        key: a.key,
        code: a.code,
        windowsVirtualKeyCode: a.keyCode,
        nativeVirtualKeyCode: a.keyCode,
        modifiers: a.modifiers ?? 0,
      };
      await cast.command('Input.dispatchKeyEvent', { type: 'rawKeyDown', ...base });
      await cast.command('Input.dispatchKeyEvent', { type: 'keyUp', ...base });
      return null;
    }
    case 'eval': {
      const r = await cast.command<{ result?: { value?: unknown } }>(
        'Runtime.evaluate',
        { expression: a.expression, awaitPromise: true, returnByValue: true, userGesture: true },
        10 * 60_000,
      );
      return r.result?.value ?? null;
    }
  }
}
