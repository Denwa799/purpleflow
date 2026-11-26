// Браузер чата — настоящие <webview> в окне. Агенту они отдаются через этот мост: он говорит с Playwright на языке
// CDP «браузера целиком», а внутри ведёт в webContents.debugger вкладок своего чата. Порт отладки Electron не
// открывается, поэтому окно самого приложения агенту недоступно — только вкладки его чата.
// Адрес у каждого чата свой и подписан ключом этого запуска: чужой процесс на машине к вкладкам не подключится.
import crypto from 'node:crypto';
import http from 'node:http';
import type { AddressInfo, Socket } from 'node:net';
import { app, webContents, type WebContents } from 'electron';

interface Tab {
  chatId: string;
  targetId: string;
  wc: WebContents;
  /** Сессия вкладки у подключённого Playwright. */
  sessionId: string;
}

/** Окно, где живут вкладки: просим его открыть, закрыть или показать вкладку. */
export interface ChatWebHost {
  send(channel: 'chatweb:open', chatId: string, url: string, reqId: string): void;
  send(channel: 'chatweb:close' | 'chatweb:select', chatId: string, targetId: string): void;
  send(channel: 'chatweb:size', chatId: string, targetId: string, width: number, height: number): void;
}

const key = crypto.randomBytes(32);
const sign = (chatId: string) => crypto.createHmac('sha256', key).update(chatId).digest('hex').slice(0, 32);
const tabs = new Map<string, Tab>();
/** Дочерние сессии (iframe из другого процесса, воркеры) → вкладка. */
const children = new Map<string, string>();
const clients = new Map<string, Client>();
const waiting = new Map<string, (targetId: string | null) => void>();
let host: (() => ChatWebHost | null) | null = null;
let port = 0;

/** Ядру: порт и ключ — оно само строит адрес чата (та же подпись, что в chatWebEndpoint). */
export function chatWebBridge(): { port: number; key: string } | null {
  return port ? { port, key: key.toString('hex') } : null;
}

/** Адрес CDP для pw чата: ws://127.0.0.1:<порт>/cdp/<чат>/<подпись>. */
export function chatWebEndpoint(chatId: string): string | null {
  if (!port) return null;
  return `ws://127.0.0.1:${port}/cdp/${Buffer.from(chatId).toString('base64url')}/${sign(chatId)}`;
}

const chatTabs = (chatId: string) => [...tabs.values()].filter((t) => t.chatId === chatId);

function targetInfo(t: Tab) {
  let url = '';
  let title = '';
  try {
    url = t.wc.getURL();
    title = t.wc.getTitle();
  } catch {
    /* вкладка закрывается */
  }
  return { targetId: t.targetId, type: 'page', title, url, attached: true, canAccessOpener: false, browserContextId: 'purpleflow-chat' };
}

/** Окно зарегистрировало вкладку чата: подключаем отладчик и сообщаем Playwright. Возвращает targetId. */
export async function registerChatTab(sender: WebContents, chatId: string, wcId: number, reqId?: string): Promise<string | null> {
  const wc = webContents.fromId(wcId);
  // Только webview этого окна — чужой webContents (само окно, другие окна) мостом не отдаётся.
  if (!wc || wc.getType() !== 'webview' || wc.hostWebContents !== sender || typeof chatId !== 'string') return null;
  const known = [...tabs.values()].find((t) => t.wc === wc);
  if (known) return known.targetId;
  try {
    if (!wc.debugger.isAttached()) wc.debugger.attach('1.3');
  } catch {
    return null;
  }
  const { targetInfo: ti } = (await wc.debugger.sendCommand('Target.getTargetInfo')) as { targetInfo: { targetId: string } };
  const t: Tab = { chatId, targetId: ti.targetId, wc, sessionId: `pf-${ti.targetId}` };
  tabs.set(t.targetId, t);
  wc.debugger.on('message', (_e, method, params, sessionId) => {
    if (method === 'Target.attachedToTarget') children.set((params as { sessionId: string }).sessionId, t.targetId);
    if (method === 'Target.detachedFromTarget') children.delete((params as { sessionId: string }).sessionId);
    clients.get(t.chatId)?.event(t, method, params, sessionId || undefined);
  });
  // Отладчик отключился, а вкладка жива (сброс после ухода Playwright, DevTools) — подключаемся снова, иначе агент её потеряет.
  wc.debugger.on('detach', () =>
    setTimeout(() => {
      if (wc.isDestroyed()) return drop(t);
      try {
        if (!wc.debugger.isAttached()) wc.debugger.attach('1.3');
      } catch {
        drop(t);
      }
    }, 0),
  );
  wc.once('destroyed', () => drop(t));
  clients.get(chatId)?.attached(t);
  if (reqId) {
    waiting.get(reqId)?.(t.targetId);
    waiting.delete(reqId);
  }
  return t.targetId;
}

function drop(t: Tab) {
  if (tabs.get(t.targetId) !== t) return;
  tabs.delete(t.targetId);
  for (const [s, target] of children) if (target === t.targetId) children.delete(s);
  clients.get(t.chatId)?.detached(t);
}

/** Попросить окно открыть вкладку и дождаться, пока она зарегистрируется. */
function openTab(chatId: string, url: string): Promise<string | null> {
  const h = host?.();
  if (!h) return Promise.resolve(null);
  const reqId = crypto.randomUUID();
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      waiting.delete(reqId);
      resolve(null);
    }, 20_000);
    waiting.set(reqId, (id) => {
      clearTimeout(timer);
      resolve(id);
    });
    h.send('chatweb:open', chatId, url, reqId);
  });
}

/**
 * Page.navigate с запасным ответом. Переход на другой сайт меняет процесс страницы, и отладчик Electron отвечает
 * «target closed», хотя переход идёт. Playwright без loaderId не узнаёт свою навигацию и ждёт вечно — берём его из
 * события frameStartedNavigating этого перехода.
 */
async function navigate(t: Tab, params: Record<string, unknown>): Promise<unknown> {
  let started: { frameId: string; loaderId: string } | null = null;
  const watch = (_e: unknown, method: string, p: { frameId?: string; loaderId?: string }, sessionId?: string) => {
    if (method === 'Page.frameStartedNavigating' && !sessionId && p.frameId === t.targetId && p.loaderId && !started)
      started = { frameId: p.frameId, loaderId: p.loaderId };
  };
  t.wc.debugger.on('message', watch);
  try {
    return await t.wc.debugger.sendCommand('Page.navigate', params);
  } catch (e) {
    if (started && /target closed/i.test((e as Error).message)) return started;
    throw e;
  } finally {
    t.wc.debugger.off('message', watch);
  }
}

const SKIP_EMULATION = new Set(['Page.setScreenSizeOverride', 'Emulation.setOrientationOverride', 'Emulation.clearOrientationOverride']);

/**
 * Размер страницы (pw resize). Эмуляция устройства в webview ломает отрисовку — застывшие и размноженные кадры, —
 * поэтому вкладке задаётся настоящий размер: окно ставит webview W×H (и уменьшает, если не влезает в панель).
 * 0×0 — снова по размеру панели. Отвечаем, когда страница приняла размер: следующий снимок уже в нём.
 */
async function resize(t: Tab, width: number, height: number): Promise<unknown> {
  host?.()?.send('chatweb:size', t.chatId, t.targetId, width, height);
  if (!width || !height) return {};
  for (let i = 0; i < 30; i++) {
    try {
      const r = (await t.wc.debugger.sendCommand('Runtime.evaluate', {
        expression: 'innerWidth + "x" + innerHeight',
        returnByValue: true,
      })) as {
        result?: { value?: string };
      };
      if (r.result?.value === `${width}x${height}`) break;
    } catch {
      /* страница меняется */
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  return {};
}

type Msg = { id: number; method: string; params?: Record<string, unknown>; sessionId?: string };

/** Подключённый Playwright одного чата. */
class Client {
  private autoAttach = false;
  constructor(
    private chatId: string,
    private ws: Ws,
  ) {}

  closeSocket() {
    this.ws.close();
  }

  private send(m: object) {
    this.ws.send(JSON.stringify(m));
  }

  attached(t: Tab) {
    if (!this.autoAttach) return;
    this.send({
      method: 'Target.attachedToTarget',
      params: { sessionId: t.sessionId, targetInfo: targetInfo(t), waitingForDebugger: false },
    });
  }

  detached(t: Tab) {
    if (!this.autoAttach) return;
    this.send({ method: 'Target.detachedFromTarget', params: { sessionId: t.sessionId, targetId: t.targetId } });
  }

  event(t: Tab, method: string, params: unknown, sessionId?: string) {
    if (!this.autoAttach) return;
    this.send({ method, params, sessionId: sessionId ?? t.sessionId });
  }

  async handle(m: Msg) {
    try {
      const result = m.sessionId ? await this.toTab(m) : await this.browser(m);
      this.send({ id: m.id, result: result ?? {}, sessionId: m.sessionId });
    } catch (e) {
      this.send({ id: m.id, error: { code: -32000, message: (e as Error).message || String(e) }, sessionId: m.sessionId });
    }
  }

  /** Команда вкладке (или её iframe/воркеру) — в её отладчик. */
  private async toTab(m: Msg) {
    const own = [...tabs.values()].find((t) => t.sessionId === m.sessionId && t.chatId === this.chatId);
    const viaChild = own ? null : tabs.get(children.get(m.sessionId!) ?? '');
    const t = own ?? (viaChild?.chatId === this.chatId ? viaChild : null);
    if (!t) throw new Error(`Session with given id not found.`);
    if (own && m.method === 'Page.navigate') return navigate(t, m.params ?? {});
    // Подмена экрана и поворота в webview тоже ломает отрисовку, а при настоящем размере вкладки не нужна.
    if (own && SKIP_EMULATION.has(m.method)) return {};
    if (own && (m.method === 'Emulation.setDeviceMetricsOverride' || m.method === 'Emulation.clearDeviceMetricsOverride')) {
      const p = m.method === 'Emulation.setDeviceMetricsOverride' ? (m.params ?? {}) : {};
      return resize(t, Number(p.width) || 0, Number(p.height) || 0);
    }
    return t.wc.debugger.sendCommand(m.method, m.params ?? {}, own ? undefined : m.sessionId);
  }

  /** Команды уровня браузера: только то, что нужно Playwright, и только про вкладки этого чата. */
  private async browser(m: Msg): Promise<unknown> {
    const p = m.params ?? {};
    const mine = () => chatTabs(this.chatId);
    const tab = (id: unknown) => {
      const t = tabs.get(String(id));
      if (!t || t.chatId !== this.chatId) throw new Error('No target with given id found');
      return t;
    };
    switch (m.method) {
      case 'Browser.getVersion':
        return {
          protocolVersion: '1.3',
          product: `Chrome/${process.versions.chrome}`,
          revision: '',
          userAgent: app.userAgentFallback,
          jsVersion: process.versions.v8,
        };
      case 'Target.setAutoAttach': {
        // Агенту нужна хотя бы одна вкладка — пустая, если человек ещё ничего не открыл.
        if (!mine().length) await openTab(this.chatId, 'about:blank');
        this.autoAttach = true;
        for (const t of mine()) this.attached(t);
        return {};
      }
      case 'Target.getTargetInfo':
        if (p.targetId) return { targetInfo: targetInfo(tab(p.targetId)) };
        return {
          targetInfo: { targetId: 'purpleflow-browser', type: 'browser', title: '', url: '', attached: true, canAccessOpener: false },
        };
      case 'Target.getTargets':
        return { targetInfos: mine().map(targetInfo) };
      case 'Target.createTarget': {
        const url = typeof p.url === 'string' && p.url ? p.url : 'about:blank';
        const id = await openTab(this.chatId, url);
        if (!id) throw new Error('Не удалось открыть вкладку');
        return { targetId: id };
      }
      case 'Target.closeTarget':
        host?.()?.send('chatweb:close', this.chatId, tab(p.targetId).targetId);
        return { success: true };
      case 'Target.activateTarget':
        host?.()?.send('chatweb:select', this.chatId, tab(p.targetId).targetId);
        return {};
      // Куки — общие у вкладок чата: берём через любую из них.
      case 'Storage.getCookies':
      case 'Storage.setCookies':
      case 'Storage.clearCookies': {
        const t = mine()[0];
        if (!t) return m.method === 'Storage.getCookies' ? { cookies: [] } : {};
        if (m.method === 'Storage.getCookies') return t.wc.debugger.sendCommand('Network.getAllCookies');
        if (m.method === 'Storage.setCookies') return t.wc.debugger.sendCommand('Network.setCookies', { cookies: p.cookies });
        return t.wc.debugger.sendCommand('Network.clearBrowserCookies');
      }
      case 'Target.setDiscoverTargets':
      case 'Target.detachFromTarget':
      case 'Browser.setDownloadBehavior':
      case 'Browser.grantPermissions':
      case 'Browser.resetPermissions':
      case 'Browser.close':
        return {};
      default:
        throw new Error(`'${m.method}' wasn't found`);
    }
  }

  /** Playwright отключился: сбрасываем отладчики вкладок, иначе новые iframe ждали бы его вечно (waitForDebuggerOnStart). */
  closed() {
    for (const t of chatTabs(this.chatId)) {
      try {
        t.wc.debugger.detach();
        t.wc.debugger.attach('1.3');
      } catch {
        /* вкладка закрылась */
      }
    }
  }
}

// ——— Минимальный WebSocket-сервер (RFC 6455): только текст, без расширений ———

class Ws {
  private buf = Buffer.alloc(0);
  private parts: Buffer[] = [];
  onMessage: (s: string) => void = () => {};
  onClose: () => void = () => {};
  private closed = false;
  constructor(private socket: Socket) {
    socket.setNoDelay(true);
    socket.on('data', (d) => this.read(d));
    socket.on('close', () => this.end());
    socket.on('error', () => this.end());
  }
  private end() {
    if (this.closed) return;
    this.closed = true;
    this.onClose();
  }
  close() {
    try {
      this.frame(0x8, Buffer.alloc(0));
    } catch {
      /* уже закрыт */
    }
    this.socket.end();
  }
  send(s: string) {
    if (!this.closed) this.frame(0x1, Buffer.from(s));
  }
  private frame(op: number, payload: Buffer) {
    const n = payload.length;
    const head = n < 126 ? Buffer.from([0x80 | op, n]) : n < 65536 ? Buffer.alloc(4) : Buffer.alloc(10);
    if (n >= 126) {
      head[0] = 0x80 | op;
      if (n < 65536) {
        head[1] = 126;
        head.writeUInt16BE(n, 2);
      } else {
        head[1] = 127;
        head.writeBigUInt64BE(BigInt(n), 2);
      }
    }
    this.socket.write(Buffer.concat([head, payload]));
  }
  private read(d: Buffer) {
    this.buf = Buffer.concat([this.buf, d]);
    for (;;) {
      if (this.buf.length < 2) return;
      const fin = (this.buf[0] & 0x80) !== 0;
      const op = this.buf[0] & 0x0f;
      const masked = (this.buf[1] & 0x80) !== 0;
      let len = this.buf[1] & 0x7f;
      let off = 2;
      if (len === 126) {
        if (this.buf.length < 4) return;
        len = this.buf.readUInt16BE(2);
        off = 4;
      } else if (len === 127) {
        if (this.buf.length < 10) return;
        len = Number(this.buf.readBigUInt64BE(2));
        off = 10;
      }
      const maskAt = off;
      if (masked) off += 4;
      if (this.buf.length < off + len) return;
      const payload = Buffer.from(this.buf.subarray(off, off + len));
      if (masked) for (let i = 0; i < len; i++) payload[i] ^= this.buf[maskAt + (i % 4)];
      this.buf = this.buf.subarray(off + len);
      if (op === 0x8) return this.close();
      if (op === 0x9) {
        this.frame(0xa, payload);
        continue;
      }
      if (op === 0xa) continue;
      this.parts.push(payload);
      if (fin) {
        const text = Buffer.concat(this.parts).toString('utf8');
        this.parts = [];
        this.onMessage(text);
      }
    }
  }
}

/** Чат по пути /cdp/<чат>/<подпись>[/…]; подпись не сошлась — null. */
function chatOf(url: string | undefined): string | null {
  const m = /^\/cdp\/([\w-]+)\/([0-9a-f]{32})(?:\/|$)/.exec(url ?? '');
  if (!m) return null;
  const chatId = Buffer.from(m[1], 'base64url').toString();
  const want = Buffer.from(sign(chatId));
  const got = Buffer.from(m[2]);
  return want.length === got.length && crypto.timingSafeEqual(want, got) ? chatId : null;
}

/** Поднять мост (один на запуск приложения). getHost — окно, где живут вкладки. */
export async function startChatWeb(getHost: () => ChatWebHost | null): Promise<void> {
  host = getHost;
  const server = http.createServer((req, res) => {
    const chatId = chatOf(req.url);
    // /json/version — для подключения по http://…; агенту отдаём сразу ws://.
    if (!chatId || !/\/json\/version\/?$/.test(req.url ?? '')) return void res.writeHead(404).end();
    res.writeHead(200, { 'content-type': 'application/json' }).end(
      JSON.stringify({
        Browser: `Chrome/${process.versions.chrome}`,
        'Protocol-Version': '1.3',
        'User-Agent': app.userAgentFallback,
        webSocketDebuggerUrl: chatWebEndpoint(chatId),
      }),
    );
  });
  server.on('upgrade', (req, socket: Socket) => {
    const chatId = chatOf(req.url);
    const wsKey = req.headers['sec-websocket-key'];
    if (!chatId || typeof wsKey !== 'string') return void socket.destroy();
    const accept = crypto.createHash('sha1').update(`${wsKey}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest('base64');
    socket.write(
      `HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`,
    );
    const ws = new Ws(socket);
    // Один Playwright на чат: новый вытесняет прежнего.
    const prev = clients.get(chatId);
    const client = new Client(chatId, ws);
    clients.set(chatId, client);
    if (prev) prev.closeSocket();
    ws.onMessage = (s) => {
      let m: Msg;
      try {
        m = JSON.parse(s) as Msg;
      } catch {
        return;
      }
      void client.handle(m);
    };
    ws.onClose = () => {
      if (clients.get(chatId) !== client) return;
      clients.delete(chatId);
      client.closed();
    };
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  port = (server.address() as AddressInfo).port;
}
