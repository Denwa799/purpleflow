// Браузер чата — один на человека и агента: настоящие <webview> окна. Агенту их отдаёт мост main-процесса
// (app/src/main/chatweb.ts) по CDP, pw подключается к нему (`pw attach`), поэтому агент видит вкладки человека,
// а человек — вкладки агента. Без моста (ядро вне приложения, e2e с PURPLEFLOW_CHAT_BROWSER=off) браузера у агента
// чата нет, а окно показывает свой встроенный браузер.
// В песочнице «Правок» (claude, codex) pw вызывается через node без npx, сокет сессии песочница пропускает.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { prependPath, which } from '../env.js';
import type { Kernel } from '../kernel.js';
import { killGroup, run } from '../proc.js';
import { playwrightCliPath } from '../stages/selfcheck.js';
import { hasWebBridge, webEndpoint } from '../webbridge.js';

/** Сообщение похоже на просьбу про веб — браузер подключаем заранее. */
const WEBBY =
  /https?:\/\/|www\.|\b[\w-]+\.(com|ru|org|net|io|dev|app|me|co|info|рф)\b|localhost|браузер|сайт|страниц|вкладк|открой|зайди|гугл|google|яндекс|загугли|в интернете|поищи|скриншот|chrome|playwright/i;

let cliPath: Promise<string | null> | null = null;
/** Чаты, где браузер открыт в окне (человек открыл вкладку) или pw уже подключён к мосту. */
const webOpen = new Set<string>();
const webAttached = new Set<string>();

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

/**
 * Есть ли у агента чата браузер: мост к окну есть и не выключен, не Windows (pw без npx там не собрать).
 * Нет — окно показывает свой встроенный браузер, а агенту браузера нет.
 */
export function chatBrowserAvailable(k: Kernel): boolean {
  return process.platform !== 'win32' && hasWebBridge(k);
}

/** Подключить pw агента к вкладкам окна через мост. Вкладок нет — мост попросит окно открыть пустую. */
async function ensureWebAttached(k: Kernel, id: string, dir: string): Promise<boolean> {
  const endpoint = webEndpoint(id);
  if (!endpoint) return false;
  const pw = path.join(dir, 'pw');
  if (webAttached.has(id) && fs.existsSync(pw)) return true;
  const node = which('node', k.opts.env);
  cliPath ??= playwrightCliPath(k.opts.env, dir).catch(() => null);
  const cli = node ? await cliPath : null;
  if (!node || !cli) return false;
  writeSandboxPw(dir, sessionOf(id), node, cli, tmpRoot(k));
  const r = await run(pw, ['attach', `--cdp=${endpoint}`], {
    cwd: dir,
    env: k.opts.env,
    group: `${groupOf(id)}:pw`,
    timeoutMs: 120_000,
  });
  if (r.code === 0) webAttached.add(id);
  return r.code === 0;
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
 * Человек открыл вкладку, агент уже подключён или сообщение про веб — подключаем агента к вкладкам окна.
 */
export async function chatBrowser(k: Kernel, o: { id: string; dir: string; text: string; readOnly: boolean }): Promise<ChatBrowser | null> {
  if (o.readOnly || !chatBrowserAvailable(k)) return null;
  const dir = browserDir(o.dir);
  fs.mkdirSync(dir, { recursive: true });
  const block = k.prompts.render('chat-browser.md', { dir });
  const ready =
    webOpen.has(o.id) || webAttached.has(o.id) || WEBBY.test(o.text) ? await ensureWebAttached(k, o.id, dir).catch(() => false) : false;
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

/** Чат удалён — pw отключается от его вкладок (окно закрывает их само). */
export async function closeChatBrowser(k: Kernel, id: string, chatDir: string): Promise<void> {
  webOpen.delete(id);
  webAttached.delete(id);
  const pw = path.join(browserDir(chatDir), 'pw');
  if (fs.existsSync(pw)) await run(pw, ['close'], { cwd: browserDir(chatDir), env: k.opts.env, timeoutMs: 20_000 }).catch(() => undefined);
  await killGroup(groupOf(id));
}

/** Окно сообщает о браузере чата: человек открыл вкладку — агент подключится к нему в следующем ходе. */
export type ChatBrowserAction = { type: 'opened' };

export function controlChatBrowser(k: Kernel, id: string, a: ChatBrowserAction): null {
  if (!chatBrowserAvailable(k)) throw new Error('Браузер чата недоступен на этой машине');
  if (a.type === 'opened') webOpen.add(id);
  return null;
}
