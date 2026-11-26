// Браузер для агента чата: у CLI нет своих инструментов computer use — даём Playwright (`pw`) и браузер,
// который открывает ядро: Chrome без окна с портом отладки, кадры его экрана идут во вкладку «Браузер» чата.
// Агент только командует уже открытым браузером через pw — так это работает и в песочнице «Правок»
// (claude, codex): Playwright CLI вызывается через node без npx, сокет сессии песочница пропускает.
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
  /https?:\/\/|www\.|\b[\w-]+\.(com|ru|org|net|io|dev|app|me|co|info|рф)\b|localhost|браузер|сайт|страниц|открой|зайди|гугл|google|яндекс|загугли|в интернете|поищи|скриншот|chrome|playwright/i;

/** Открытые ядром браузеры чатов: Chrome, трансляция кадров. */
const live = new Map<string, { cast: Screencast | null }>();
let cliPath: Promise<string | null> | null = null;

/** Имя сессии Playwright — по всему id чата: у разных чатов начало id совпадает («chat-…»). */
const sessionOf = (id: string) => `pf-${id.replace(/[^\w-]/g, '').slice(0, 40)}`;
const groupOf = (id: string) => `chat:${id}:browser`;

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

/** Выключить браузер чата: тесты и e2e (PURPLEFLOW_CHAT_BROWSER=off). */
const disabled = (k: Kernel) => (k.opts.env.PURPLEFLOW_CHAT_BROWSER ?? process.env.PURPLEFLOW_CHAT_BROWSER) === 'off';

/** Открыть браузер чата: Chrome без окна + трансляция во вкладку; Chrome нет — браузер Playwright без окна и без трансляции. */
async function openBrowser(
  k: Kernel,
  id: string,
  dir: string,
  pw: (args: string[], ms: number) => ReturnType<typeof run>,
): Promise<boolean> {
  const chrome = findChrome(k.opts.env);
  if (chrome) {
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
    if (await waitForCdp(port, () => false)) {
      if ((await pw(['attach', `--cdp=http://127.0.0.1:${port}`], 120_000)).code === 0) {
        const cast = new Screencast(port, (frame) => k.emit({ type: 'visual.frame', runId: id, frame }));
        cast.start();
        live.set(id, { cast });
        return true;
      }
    }
    await killGroup(groupOf(id));
  }
  if ((await pw(['open', 'about:blank'], 120_000)).code !== 0) return false;
  live.set(id, { cast: null });
  return true;
}

/**
 * Браузер на ход чата. null — в «Вопросах» (команд нет), на Windows (pw без npx там не собрать) и если Playwright
 * не скачался. Браузер открывается, когда сообщение про веб или он уже открыт в этом чате.
 */
export async function chatBrowser(k: Kernel, o: { id: string; dir: string; text: string; readOnly: boolean }): Promise<ChatBrowser | null> {
  if (o.readOnly || disabled(k) || process.platform === 'win32') return null;
  const dir = path.join(o.dir, 'browser');
  fs.mkdirSync(dir, { recursive: true });
  const session = sessionOf(o.id);
  const env = prependPath(k.opts.env, dir);
  const block = k.prompts.render('chat-browser.md', { dir });
  const pw = (args: string[], timeoutMs: number) =>
    run(path.join(dir, 'pw'), args, { cwd: dir, env: k.opts.env, group: `${groupOf(o.id)}:pw`, timeoutMs });
  // Открыт раньше — жив ли ещё. Иначе открываем, только если сообщение про веб.
  let ready = live.has(o.id) && fs.existsSync(path.join(dir, 'pw')) && (await pw(['tab-list'], 15_000)).code === 0;
  if (!ready && (live.has(o.id) || WEBBY.test(o.text))) {
    await stopCast(o.id);
    const node = which('node', k.opts.env);
    cliPath ??= playwrightCliPath(k.opts.env, dir).catch(() => null);
    const cli = node ? await cliPath : null;
    if (node && cli) {
      writeSandboxPw(dir, session, node, cli, tmpRoot(k));
      ready = await openBrowser(k, o.id, dir, pw).catch(() => false);
    }
  }
  const socks = ready ? socketDirs(tmpRoot(k)) : [];
  return {
    dir,
    env,
    block,
    sockets: socks.length ? socks : undefined,
    note: ready
      ? '[PurpleFlow: браузер открыт и подключён к pw — переходи командой `pw goto <url>`; человек видит его во вкладке «Браузер».]'
      : '[PurpleFlow: браузер сейчас не запущен. Если он нужен — скажи человеку попросить открыть сайт ещё раз (например, «открой браузер»).]',
  };
}

async function stopCast(id: string) {
  const cur = live.get(id);
  cur?.cast?.stop();
  live.delete(id);
}

/** Чат удалён — его браузер закрывается, трансляция гаснет. */
export async function closeChatBrowser(k: Kernel, id: string, chatDir: string): Promise<void> {
  const had = live.has(id);
  await stopCast(id);
  const dir = path.join(chatDir, 'browser');
  if (fs.existsSync(path.join(dir, 'pw')))
    await run(path.join(dir, 'pw'), ['close'], { cwd: dir, env: k.opts.env, timeoutMs: 20_000 }).catch(() => undefined);
  await killGroup(groupOf(id));
  if (had) k.emit({ type: 'visual.frame', runId: id, frame: null });
}

/** Действие человека в браузере агента: вкладка «Агент» работает как обычная вкладка браузера. */
export type ChatBrowserAction =
  | { type: 'navigate'; url: string }
  | { type: 'back' | 'forward' | 'reload' | 'state' }
  | { type: 'mobile'; on: boolean }
  /** x, y — доли кадра (0…1): ядро переводит их в точку страницы. */
  | { type: 'mouse'; event: 'move' | 'down' | 'up'; x: number; y: number; button?: 'left' | 'right' | 'middle'; clicks?: number }
  | { type: 'wheel'; x: number; y: number; dx: number; dy: number }
  | { type: 'key'; key: string; code?: string; text?: string; keyCode?: number; modifiers?: number }
  /** Скрипт в странице агента: выбор элемента «Указать элемент». */
  | { type: 'eval'; expression: string };

const MOBILE_UA =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1';
let desktopUa: string | null = null;

/** Состояние вкладки агента для панели: можно ли назад/вперёд. */
export interface ChatBrowserState {
  back: boolean;
  forward: boolean;
}

/** Выполнить действие человека в браузере агента чата. Без Chrome (браузер Playwright без трансляции) — недоступно. */
export async function controlChatBrowser(id: string, a: ChatBrowserAction): Promise<ChatBrowserState | unknown> {
  const cast = live.get(id)?.cast;
  if (!cast) throw new Error('Браузер агента сейчас не открыт');
  const history = async (): Promise<ChatBrowserState & { index: number; entries: { id: number }[] }> => {
    const h = await cast.command<{ currentIndex: number; entries: { id: number }[] }>('Page.getNavigationHistory');
    return { back: h.currentIndex > 0, forward: h.currentIndex < h.entries.length - 1, index: h.currentIndex, entries: h.entries };
  };
  // Сразу после перехода страница ещё грузится и историю не отдаёт — пробуем ещё раз; не вышло — не беда, панель спросит позже.
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
    case 'navigate':
      if (!/^https?:\/\//.test(a.url) && a.url !== 'about:blank') throw new Error('Только адреса http(s)');
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
      const r = await cast.command<{ result?: { value?: unknown }; exceptionDetails?: unknown }>(
        'Runtime.evaluate',
        { expression: a.expression, awaitPromise: true, returnByValue: true, userGesture: true },
        10 * 60_000,
      );
      return r.result?.value ?? null;
    }
  }
}
