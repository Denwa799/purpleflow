// Слой окна, где живут вкладки браузера чатов (<webview>). Открыта панель «Браузер» этого чата — слой стоит ровно
// над её местом (slot); нет — прячется за приложением: невидим, но страница жива и рисуется, агент с ней работает.
import { useEffect, useRef, useState, type CSSProperties } from 'react';
import type { WebviewTag } from 'electron';
import { bridge } from '../lib/api';
import { partitionOf, patchTab, setView, slotOf, useAllChatWeb, type ChatWeb, type WebTab } from '../lib/chatWeb';

/** Размер страницы, пока панели нет: последний показанный, иначе обычное окно ноутбука. */
const lastSize = new Map<string, { width: number; height: number }>();

export function ChatWebHost() {
  const all = useAllChatWeb();
  return (
    <>
      {all.map(([chatId, c]) => (
        <ChatLayer key={chatId} chatId={chatId} web={c} />
      ))}
    </>
  );
}

function ChatLayer({ chatId, web }: { chatId: string; web: ChatWeb }) {
  const layer = useRef<HTMLDivElement>(null);
  // Размер слоя — чтобы страницу заданного агентом размера уменьшить, если она не влезает.
  const [box, setBox] = useState({ width: 0, height: 0 });
  useEffect(() => {
    let raf = 0;
    let prev = '';
    const place = () => {
      const el = layer.current;
      const slot = slotOf(chatId);
      if (el) {
        // Панель спрятана (другой инструмент, hidden) — у места нулевой размер: страница остаётся прежнего размера.
        const r = slot?.isConnected ? slot.getBoundingClientRect() : null;
        const shown = Boolean(r && r.width > 0 && r.height > 0);
        let css: string;
        let size: { width: number; height: number };
        if (r && shown) {
          size = { width: r.width, height: r.height };
          lastSize.set(chatId, size);
          css = `left:${r.left}px;top:${r.top}px;width:${r.width}px;height:${r.height}px`;
        } else {
          size = lastSize.get(chatId) ?? { width: 1280, height: 800 };
          css = `left:0;top:0;width:${size.width}px;height:${size.height}px`;
        }
        const key = `${css}|${shown}`;
        if (key !== prev) {
          prev = key;
          el.style.cssText = css;
          el.classList.toggle('is-shown', shown);
          setBox((b) => (b.width === size.width && b.height === size.height ? b : size));
        }
      }
      raf = requestAnimationFrame(place);
    };
    place();
    return () => cancelAnimationFrame(raf);
  }, [chatId]);
  return (
    <div ref={layer} className="chatweb-layer">
      {web.tabs.map((t) => (
        <WebTabView key={t.key} chatId={chatId} tab={t} hidden={t.key !== web.active} mobile={t.mobile} style={sized(t, box)} />
      ))}
    </div>
  );
}

/**
 * Вкладка размера, заданного агентом (pw resize): настоящие W×H пикселей — страница рисуется в этом размере, — уменьшенные
 * целиком, если не влезают в панель, и по центру.
 */
function sized(t: WebTab, box: { width: number; height: number }): CSSProperties | undefined {
  if (!t.size || !box.width || !box.height) return undefined;
  const { width, height } = t.size;
  const scale = Math.min(1, box.width / width, box.height / height);
  return {
    width,
    height,
    left: Math.max(0, (box.width - width * scale) / 2),
    top: 0,
    right: 'auto',
    bottom: 'auto',
    transform: scale < 1 ? `scale(${scale})` : undefined,
    transformOrigin: '0 0',
  };
}

function WebTabView({
  chatId,
  tab,
  hidden,
  mobile,
  style,
}: {
  chatId: string;
  tab: WebTab;
  hidden: boolean;
  mobile: boolean;
  style?: CSSProperties;
}) {
  const ref = useRef<WebviewTag | null>(null);
  const mobileRef = useRef(mobile);
  mobileRef.current = mobile;
  const reqId = useRef(tab.reqId);
  useEffect(() => {
    const w = ref.current;
    if (!w) return;
    const key = tab.key;
    setView(key, w);
    let registered = false;
    const patch = (p: Partial<WebTab>) => patchTab(chatId, key, p);
    const sync = () => {
      try {
        const url = w.getURL();
        patch({
          url: url === 'about:blank' ? '' : url,
          title: w.getTitle() || '',
          back: w.canGoBack(),
          forward: w.canGoForward(),
          loading: w.isLoading(),
        });
      } catch {
        /* webview ещё не готов */
      }
    };
    const ready = () => {
      sync();
      if (registered) return;
      registered = true;
      let wcId: number;
      try {
        wcId = w.getWebContentsId();
      } catch {
        registered = false;
        return;
      }
      patch({ wcId });
      if (mobileRef.current) void bridge.previewEmulate(wcId, true);
      // Вкладку видит агент: мост подключает к ней отладчик и сообщает Playwright.
      void bridge
        .chatWebTab(chatId, wcId, reqId.current)
        .then((targetId) => targetId && patch({ targetId, reqId: undefined }))
        .catch(() => {});
    };
    const loading = () => patch({ loading: true, error: null });
    const titled = (e: Electron.PageTitleUpdatedEvent) => patch({ title: e.title });
    const failed = (e: Electron.DidFailLoadEvent) => {
      // -3 — навигацию отменили (новый переход), это не сбой.
      if (e.isMainFrame && e.errorCode !== -3)
        patch({ error: `Страница не открылась: ${e.errorDescription || e.errorCode} — ${e.validatedURL}` });
    };
    w.addEventListener('dom-ready', ready);
    w.addEventListener('did-navigate', sync);
    w.addEventListener('did-navigate-in-page', sync);
    w.addEventListener('did-stop-loading', sync);
    w.addEventListener('did-start-loading', loading);
    w.addEventListener('page-title-updated', titled);
    w.addEventListener('did-fail-load', failed);
    return () => {
      w.removeEventListener('dom-ready', ready);
      w.removeEventListener('did-navigate', sync);
      w.removeEventListener('did-navigate-in-page', sync);
      w.removeEventListener('did-stop-loading', sync);
      w.removeEventListener('did-start-loading', loading);
      w.removeEventListener('page-title-updated', titled);
      w.removeEventListener('did-fail-load', failed);
      setView(key, null);
    };
    // Вкладка одна и та же на всю жизнь: src не меняется, переходы — через loadURL.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return (
    <webview
      ref={(el) => {
        ref.current = el as unknown as WebviewTag | null;
      }}
      src={tab.src}
      partition={partitionOf(chatId)}
      className={`chatweb-view ${hidden ? 'is-hidden' : ''} ${style ? 'is-sized' : ''}`}
      style={style}
    />
  );
}
