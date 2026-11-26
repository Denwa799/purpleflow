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
 * Следит за вкладкой, с которой работает агент визуальной проверки (Chrome без окна — запасной путь, когда браузера
 * в окне нет), и шлёт кадры не чаще раза в minIntervalMs, не теряя последний.
 */
export class Screencast {
  private ws: WebSocket | null = null;
  private target: string | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private lastFrame = 0;
  private msgId = 0;
  private stopped = false;
  /** Вкладка, которую показывать: новая, которую открыл агент. */
  private preferred: string | null = null;
  private known: Set<string> | null = null;
  private url = '';
  private pendingFrame: Parameters<Screencast['onFrame']>[0] | null = null;
  private frameTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private port: number,
    private onFrame: (frame: { data: string; url: string; width: number; height: number }) => void,
    private minIntervalMs = 250,
  ) {}

  start() {
    void this.pick();
    // Агент может открыть новую вкладку или перейти по ссылке — переподключаемся к актуальной.
    this.timer = setInterval(() => void this.pick(), 1500);
  }

  stop() {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    if (this.frameTimer) clearTimeout(this.frameTimer);
    try {
      this.ws?.close();
    } catch {
      /* уже закрыт */
    }
    this.ws = null;
  }

  private flushFrame() {
    if (this.frameTimer) clearTimeout(this.frameTimer);
    this.frameTimer = null;
    const f = this.pendingFrame;
    this.pendingFrame = null;
    if (!f || this.stopped) return;
    this.lastFrame = Date.now();
    this.onFrame(f);
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
    const send = (method: string, params: object = {}) => ws.send(JSON.stringify({ id: ++this.msgId, method, params }));
    ws.addEventListener('open', () =>
      send('Page.startScreencast', { format: 'jpeg', quality: 85, maxWidth: 2880, maxHeight: 2000, everyNthFrame: 1 }),
    );
    ws.addEventListener('message', (ev) => {
      let m: { method?: string; params?: { data: string; sessionId: number; metadata?: { deviceWidth?: number; deviceHeight?: number } } };
      try {
        m = JSON.parse(String(ev.data));
      } catch {
        return;
      }
      if (m.method !== 'Page.screencastFrame' || !m.params) return;
      send('Page.screencastFrameAck', { sessionId: m.params.sessionId });
      // Чаще minIntervalMs не шлём, но последний кадр не теряем — иначе экран «застывает» на промежуточном.
      this.pendingFrame = {
        data: m.params.data,
        url: this.url,
        width: m.params.metadata?.deviceWidth ?? 0,
        height: m.params.metadata?.deviceHeight ?? 0,
      };
      const wait = this.minIntervalMs - (Date.now() - this.lastFrame);
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
  }
}
