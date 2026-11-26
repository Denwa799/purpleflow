// Трансляция экрана браузера агента (Chrome DevTools Protocol, Page.startScreencast) во вкладку «Браузер».
import fs from 'node:fs';
import path from 'node:path';
import { discardBody } from './net.js';

/** Установленный Chrome / Chromium — тот же, что берёт Playwright CLI. null — не найден. */
export function findChrome(env: NodeJS.ProcessEnv = process.env): string | null {
  const candidates =
    process.platform === 'darwin'
      ? ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/Applications/Chromium.app/Contents/MacOS/Chromium']
      : process.platform === 'win32'
        ? [
            path.join(env.PROGRAMFILES ?? 'C:\\Program Files', 'Google/Chrome/Application/chrome.exe'),
            path.join(env['PROGRAMFILES(X86)'] ?? 'C:\\Program Files (x86)', 'Google/Chrome/Application/chrome.exe'),
            path.join(env.LOCALAPPDATA ?? '', 'Google/Chrome/Application/chrome.exe'),
          ]
        : ['/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium', '/usr/bin/chromium-browser'];
  return candidates.find((p) => p && fs.existsSync(p)) ?? null;
}

/** Дождаться, пока Chrome откроет порт отладки. */
export async function waitForCdp(port: number, shouldStop: () => boolean, timeoutMs = 20_000): Promise<boolean> {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until && !shouldStop()) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(1000) });
      await discardBody(r);
      if (r.ok) return true;
    } catch {
      /* ещё не поднялся */
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  return false;
}

interface Target {
  id: string;
  type: string;
  url: string;
  webSocketDebuggerUrl?: string;
}

/**
 * Следит за вкладкой, с которой работает агент, и шлёт кадры не чаще раза в minIntervalMs.
 * command — команда CDP той же вкладке: человек управляет браузером агента из вкладки «Браузер».
 */
export class Screencast {
  private ws: WebSocket | null = null;
  private target: string | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private lastFrame = 0;
  private msgId = 0;
  private stopped = false;
  private waiting = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();

  constructor(
    private port: number,
    private onFrame: (frame: { data: string; url: string; width: number; height: number }) => void,
    private minIntervalMs = 250,
    /** Вкладки браузера изменились (браузер чата): список и та, что показывается. */
    private onTabs?: (tabs: { id: string; url: string; title: string }[], active: string | null) => void,
    private pollMs = 1500,
    /** Страница показываемой вкладки начала или закончила загружаться (индикатор в панели). */
    private onLoading?: (loading: boolean, tab: string) => void,
  ) {}

  /** Вкладка, которую показывать; null — первая. */
  private preferred: string | null = null;
  private known: Set<string> | null = null;
  private tabsKey = '';

  start() {
    void this.pick();
    // Агент может открыть новую вкладку или перейти по ссылке — переподключаемся к актуальной.
    this.timer = setInterval(() => void this.pick(), this.pollMs);
  }

  /** Показывать эту вкладку (человек выбрал её в панели); готово — когда подключились к ней. */
  async select(id: string) {
    this.preferred = id;
    this.known?.add(id);
    await this.pick();
  }

  /** Сейчас показываемая вкладка. */
  get active() {
    return this.target;
  }

  stop() {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    try {
      this.ws?.close();
    } catch {
      /* уже закрыт */
    }
    this.ws = null;
  }

  /** Качество JPEG кадров: браузеру, которым работают руками, важнее плавность, чем чёткость. */
  quality = 85;
  private url = '';
  private pendingFrame: Parameters<Screencast['onFrame']>[0] | null = null;
  private frameTimer: ReturnType<typeof setTimeout> | null = null;
  private flushFrame() {
    if (this.frameTimer) clearTimeout(this.frameTimer);
    this.frameTimer = null;
    const f = this.pendingFrame;
    this.pendingFrame = null;
    if (!f || this.stopped) return;
    this.lastFrame = Date.now();
    this.onFrame(f);
  }
  /** Размер страницы в CSS-пикселях по последнему кадру. */
  size = { width: 0, height: 0 };

  /** Команда CDP открытой вкладке (ждём, пока подключимся, до 5 с). */
  async command<T = unknown>(method: string, params: object = {}, timeoutMs = 15_000): Promise<T> {
    for (let i = 0; i < 20 && (!this.ws || this.ws.readyState !== WebSocket.OPEN); i++) await new Promise((r) => setTimeout(r, 250));
    const ws = this.ws;
    if (!ws || ws.readyState !== WebSocket.OPEN) throw new Error('Браузер агента не отвечает');
    const id = ++this.msgId;
    return new Promise<T>((resolve, reject) => {
      const t = setTimeout(() => {
        this.waiting.delete(id);
        reject(new Error(`${method}: нет ответа`));
      }, timeoutMs);
      this.waiting.set(id, {
        resolve: (v) => {
          clearTimeout(t);
          resolve(v as T);
        },
        reject: (e) => {
          clearTimeout(t);
          reject(e);
        },
      });
      ws.send(JSON.stringify({ id, method, params }));
    });
  }

  private async pick() {
    if (this.stopped) return;
    let list: Target[];
    try {
      list = (await (await fetch(`http://127.0.0.1:${this.port}/json/list`)).json()) as Target[];
    } catch {
      return;
    }
    const pages = list.filter((t) => t.type === 'page' && !/^(chrome|devtools|chrome-extension):/.test(t.url));
    // Новая вкладка (агент открыл её через pw tab-new или страница — в новом окне) — показываем её.
    const ids = new Set(pages.map((p) => p.id));
    if (this.known) for (const p of pages) if (!this.known.has(p.id)) this.preferred = p.id;
    this.known = ids;
    if (this.preferred && !ids.has(this.preferred)) this.preferred = null;
    const page = pages.find((p) => p.id === this.preferred) ?? pages.find((p) => p.id === this.target) ?? pages[0];
    if (this.onTabs) {
      const tabs = pages.map((p) => ({ id: p.id, url: p.url, title: (p as Target & { title?: string }).title ?? '' }));
      const key = JSON.stringify([tabs, page?.id ?? null]);
      if (key !== this.tabsKey) {
        this.tabsKey = key;
        this.onTabs(tabs, page?.id ?? null);
      }
    }
    if (!page?.webSocketDebuggerUrl) return;
    this.url = page.url;
    if (page.id === this.target && this.ws) return;
    this.target = page.id;
    try {
      this.ws?.close();
    } catch {
      /* старое соединение */
    }
    const ws = new WebSocket(page.webSocketDebuggerUrl);
    this.ws = ws;
    // Команды после select идут уже в новую вкладку: ждём подключения (до 5 с).
    const opened = new Promise<void>((resolve) => {
      const done = () => resolve();
      ws.addEventListener('open', done, { once: true });
      ws.addEventListener('error', done, { once: true });
      setTimeout(done, 5000);
    });
    const send = (method: string, params: object = {}) => ws.send(JSON.stringify({ id: ++this.msgId, method, params }));
    ws.addEventListener('open', () => {
      send('Page.startScreencast', { format: 'jpeg', quality: this.quality, maxWidth: 2880, maxHeight: 2000, everyNthFrame: 1 });
      // События загрузки — только если панели нужен индикатор.
      if (this.onLoading) send('Page.enable');
    });
    ws.addEventListener('message', (ev) => {
      let m: {
        id?: number;
        result?: unknown;
        error?: { message?: string };
        method?: string;
        params?: { data: string; sessionId: number; metadata?: { deviceWidth?: number; deviceHeight?: number } };
      };
      try {
        m = JSON.parse(String(ev.data));
      } catch {
        return;
      }
      // Ответ на command.
      if (m.id && this.waiting.has(m.id)) {
        const w = this.waiting.get(m.id)!;
        this.waiting.delete(m.id);
        if (m.error) w.reject(new Error(m.error.message ?? 'Ошибка CDP'));
        else w.resolve(m.result);
        return;
      }
      // Загрузка главного кадра: его id совпадает с id вкладки (iframe индикатор не дёргают).
      if (this.onLoading && (m.method === 'Page.frameStartedLoading' || m.method === 'Page.frameStoppedLoading')) {
        const frameId = (m.params as unknown as { frameId?: string })?.frameId;
        if (frameId === this.target) this.onLoading(m.method === 'Page.frameStartedLoading', frameId);
        return;
      }
      if (m.method !== 'Page.screencastFrame' || !m.params) return;
      send('Page.screencastFrameAck', { sessionId: m.params.sessionId });
      // Размер страницы в CSS-пикселях: по нему ввод человека попадает в нужную точку.
      this.size = { width: m.params.metadata?.deviceWidth ?? this.size.width, height: m.params.metadata?.deviceHeight ?? this.size.height };
      const frame = {
        data: m.params.data,
        url: this.url,
        width: m.params.metadata?.deviceWidth ?? 0,
        height: m.params.metadata?.deviceHeight ?? 0,
      };
      // Чаще minIntervalMs не шлём, но последний кадр не теряем — иначе экран «застывает» на промежуточном.
      const wait = this.minIntervalMs - (Date.now() - this.lastFrame);
      this.pendingFrame = frame;
      if (wait <= 0) this.flushFrame();
      else this.frameTimer ??= setTimeout(() => this.flushFrame(), wait);
    });
    ws.addEventListener('close', () => {
      if (this.ws === ws) {
        this.ws = null;
        this.target = null;
      }
    });
    ws.addEventListener('error', () => {
      /* переподключимся на следующем опросе */
    });
    await opened;
    // Вкладку только что показали: грузится ли она ещё (событие начала загрузки могло пройти раньше).
    if (this.onLoading && this.ws === ws) {
      const tab = page.id;
      this.command<{ result?: { value?: string } }>('Runtime.evaluate', { expression: 'document.readyState', returnByValue: true }, 3000)
        .then((r) => this.onLoading?.(r.result?.value !== 'complete', tab))
        .catch(() => this.onLoading?.(false, tab));
    }
  }
}
