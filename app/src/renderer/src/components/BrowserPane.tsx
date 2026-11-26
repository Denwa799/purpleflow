import { forwardRef, useEffect, useImperativeHandle, useRef, useState, useSyncExternalStore } from 'react';
import type { WebviewTag } from 'electron';
import {
  ArrowLeft,
  ArrowRight,
  ExternalLink,
  Globe,
  Monitor,
  Plus,
  RotateCw,
  Smartphone,
  Square,
  SquareMousePointer,
  TriangleAlert,
  X,
} from 'lucide-react';
import { CANCEL_PICK_SCRIPT, PICK_SCRIPT, type PickedElement } from '../lib/pickElement';
import type { PreviewState } from '@purpleflow/core';
import { Button } from './ui';
import { onCoreEvent } from '../lib/store';
import { bridge, cleanErr } from '../lib/api';
import { normalizeAddress } from '../../../shared/urls';

/** Состояние приложения прогона для ручной проверки (общее для вкладки и строки приёмки). */
export function usePreview(runId: string) {
  const [state, setState] = useState<PreviewState>({ status: 'idle' });
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    bridge.core
      .getPreview(runId)
      .then((s) => alive && setState(s))
      .catch((e) => alive && setError(cleanErr(e)));
    const off = onCoreEvent((e) => {
      if (e.type === 'preview.state' && e.runId === runId) setState(e.state);
    });
    return () => {
      alive = false;
      off();
    };
  }, [runId]);
  const start = async () => {
    setError(null);
    try {
      setState(await bridge.core.startPreview(runId));
    } catch (e) {
      setError(cleanErr(e));
    }
  };
  const stop = () => bridge.core.stopPreview(runId);
  return { state, error, start, stop };
}

type AgentView = { frame: { data: string; url: string } | null; action: string | null };

/**
 * Живая трансляция браузера агента визуальной проверки и его последнее действие.
 * Кадры идут часто и хранятся вне состояния: экран прогона перерисовывается, только когда трансляция началась или кончилась,
 * а каждый кадр получает один AgentScreen. Подписка живёт на экране прогона: Chrome шлёт кадр лишь при изменении страницы,
 * и вкладка, открытая позже, иначе ждала бы следующего.
 */
export function useAgentScreen(runId: string) {
  const [store] = useState(() => {
    let view: AgentView = { frame: null, action: null };
    const subs = new Set<() => void>();
    return {
      get: () => view,
      set(patch: Partial<AgentView>) {
        view = { ...view, ...patch };
        subs.forEach((fn) => fn());
      },
      subscribe(fn: () => void) {
        subs.add(fn);
        return () => subs.delete(fn);
      },
    };
  });
  const [live, setLive] = useState(false);
  useEffect(() => {
    let buf = '';
    return onCoreEvent((e) => {
      if (e.type === 'visual.frame' && e.runId === runId) {
        store.set(e.frame ? { frame: { data: e.frame.data, url: e.frame.url } } : { frame: null, action: null });
        setLive(Boolean(e.frame));
      } else if (e.type === 'agent.output' && e.runId === runId && e.stage === 'visual') {
        // Вывод приходит кусками — склеиваем и берём последнюю завершённую строку с командой pw.

        buf = (buf + e.text.replace(/\x1b\[[0-9;]*m/g, '')).slice(-4000);
        const lines = buf.split(/\r?\n/).slice(0, -1);
        for (let i = lines.length - 1; i >= 0; i--) {
          const m = lines[i].match(/(?:^|[\s;&|(])pw\s+([a-z][a-z-]*[^;&|]*)/);
          if (m) {
            store.set({ action: m[1].trim().slice(0, 120) });
            break;
          }
        }
      }
    });
  }, [runId, store]);
  return { store, live };
}

/** Экран браузера агента: только смотреть, управляет агент. */
export function AgentScreen({ screen, label = 'Агент проверяет' }: { screen: ReturnType<typeof useAgentScreen>; label?: string }) {
  const { frame, action } = useSyncExternalStore(screen.store.subscribe, screen.store.get);
  if (!frame) {
    return (
      <div className="browser-empty">
        <div className="browser-empty-card">
          <span className="spinner big" />
          <strong>Агент открывает браузер…</strong>
          <p>Как только страница загрузится, здесь будет видно всё, что он делает.</p>
        </div>
      </div>
    );
  }
  return (
    <div className="browser is-agent">
      <div className="browser-bar">
        <span className="agent-live">
          <i />
          {label}
        </span>
        <div className="browser-address">
          <input value={frame.url} readOnly aria-label="Адрес" />
        </div>
        {action && (
          <span className="agent-action" title={action}>
            pw {action}
          </span>
        )}
      </div>
      <div className="browser-stage agent-stage">
        <img className="agent-frame" src={`data:image/jpeg;base64,${frame.data}`} alt="Экран браузера агента" draggable={false} />
      </div>
    </div>
  );
}

/** Что вкладка сообщает панели: адрес, заголовок, навигация, ошибка загрузки. */
interface TabInfo {
  address: string;
  title: string;
  back: boolean;
  forward: boolean;
  loading: boolean;
  error: string | null;
}
interface TabHandle {
  back(): void;
  forward(): void;
  reload(): void;
  load(url: string): void;
  emulate(mobile: boolean): void;
  pick(): Promise<PickedElement | null>;
  cancelPick(): void;
}

/** Одна вкладка браузера: свой webview со своей историей; неактивная остаётся жить, просто скрыта. */
const BrowserTab = forwardRef<
  TabHandle,
  { src: string; hidden: boolean; mobile: boolean; onInfo: (i: Partial<TabInfo>) => void; onId: (id: number) => void }
>(function BrowserTab({ src, hidden, mobile, onInfo, onId }, ref) {
  const view = useRef<WebviewTag | null>(null);
  /**
   * Webview готов к вызовам методов (был dom-ready). До этого loadURL, getWebContentsId, reload и прочие
   * бросают синхронно — «The WebView must be attached to the DOM and the dom-ready event emitted…».
   */
  const domReady = useRef(false);
  const mobileRef = useRef(mobile);
  mobileRef.current = mobile;
  const info = useRef(onInfo);
  info.current = onInfo;
  const idRef = useRef(onId);
  idRef.current = onId;
  const call = (fn: (w: WebviewTag) => void, fallback?: (w: WebviewTag) => void) => {
    const w = view.current;
    if (!w) return;
    if (!domReady.current) return fallback?.(w);
    try {
      fn(w);
    } catch {
      fallback?.(w);
    }
  };
  useImperativeHandle(ref, () => ({
    back: () => call((w) => w.goBack()),
    forward: () => call((w) => w.goForward()),
    reload: () => call((w) => w.reload()),
    load: (url) =>
      call(
        (w) => void w.loadURL(url).catch(() => {}),
        (w) => {
          w.src = url;
        },
      ),
    emulate: (m) => call((w) => void bridge.previewEmulate(w.getWebContentsId(), m)),
    async pick() {
      const w = view.current;
      // До dom-ready executeJavaScript бросает синхронно — выбирать ещё не из чего.
      if (!w || !domReady.current) return null;
      return ((await w.executeJavaScript(PICK_SCRIPT, true)) as PickedElement | null) ?? null;
    },
    cancelPick: () => call((w) => void w.executeJavaScript(CANCEL_PICK_SCRIPT).catch(() => {})),
  }));
  useEffect(() => {
    const w = view.current;
    if (!w) return;
    domReady.current = false;
    const onReady = () => {
      domReady.current = true;
      try {
        idRef.current(w.getWebContentsId());
      } catch {
        /* ещё не готов */
      }
      // «Телефон» выбрали до загрузки — применяем, как только webview готов.
      if (mobileRef.current) void bridge.previewEmulate(w.getWebContentsId(), true);
    };
    const sync = () => {
      try {
        const url = w.getURL();
        info.current({
          address: url === 'about:blank' ? '' : url,
          title: w.getTitle() || '',
          back: w.canGoBack(),
          forward: w.canGoForward(),
          loading: w.isLoading(),
        });
      } catch {
        /* webview ещё не готов */
      }
    };
    const loading = () => info.current({ loading: true, error: null });
    const titled = (e: Electron.PageTitleUpdatedEvent) => info.current({ title: e.title });
    const failed = (e: Electron.DidFailLoadEvent) => {
      // -3 — навигацию отменили (новый переход), это не сбой.
      if (e.isMainFrame && e.errorCode !== -3)
        info.current({ error: `Страница не открылась: ${e.errorDescription || e.errorCode} — ${e.validatedURL}` });
    };
    w.addEventListener('did-navigate', sync);
    w.addEventListener('did-navigate-in-page', sync);
    w.addEventListener('did-stop-loading', sync);
    w.addEventListener('did-start-loading', loading);
    w.addEventListener('page-title-updated', titled);
    w.addEventListener('dom-ready', onReady);
    w.addEventListener('dom-ready', sync);
    w.addEventListener('did-fail-load', failed);
    return () => {
      w.removeEventListener('dom-ready', onReady);
      w.removeEventListener('did-navigate', sync);
      w.removeEventListener('did-navigate-in-page', sync);
      w.removeEventListener('did-stop-loading', sync);
      w.removeEventListener('did-start-loading', loading);
      w.removeEventListener('page-title-updated', titled);
      w.removeEventListener('dom-ready', sync);
      w.removeEventListener('did-fail-load', failed);
    };
  }, []);
  return (
    <webview
      ref={(el) => {
        view.current = el as unknown as WebviewTag | null;
      }}
      src={src}
      partition="purpleflow-preview"
      className={`browser-view ${hidden ? 'is-hidden' : ''}`}
    />
  );
});

/** Подпись вкладки: заголовок страницы, иначе хост, иначе «Новая вкладка». */
export const tabLabel = (t: { title: string; address: string }) => {
  if (t.title.trim()) return t.title.trim();
  try {
    return t.address ? new URL(t.address).host || t.address : 'Новая вкладка';
  } catch {
    return t.address || 'Новая вкладка';
  }
};

/**
 * Вкладка «Браузер»: приложение проекта и любые сайты во встроенном webview, с вкладками.
 * Отдельная сессия, без preload и Node, только http(s); камеру, микрофон и загрузки сайты не получают (см. main).
 */
export function BrowserPane({
  preview,
  canRun,
  manual = false,
  intro,
  onPick,
}: {
  preview: ReturnType<typeof usePreview>;
  canRun: boolean;
  /** Можно открыть свой адрес без команды запуска. */
  manual?: boolean;
  intro?: string;
  /** Есть — в панели кнопка «Указать элемент»: выбранный на странице элемент уходит сюда (в поле ввода чата). */
  onPick?: (el: PickedElement) => void;
}) {
  const { error, start, stop: stopApp } = preview;
  const [typed, setTyped] = useState('localhost:3000');
  const state: PreviewState = preview.state;
  const openManual = () => {
    const t = typed.trim();
    if (!t) return;
    newTab(normalizeAddress(t));
  };
  const appReady = state.status === 'ready' && state.url;

  /** app — вкладка запущенного приложения: закрыть её — остановить приложение. */
  type Tab = TabInfo & { id: string; src: string; wcId?: number; app?: boolean };
  const [tabs, setTabs] = useState<Tab[]>([]);
  const [active, setActive] = useState<string | null>(null);
  const handles = useRef(new Map<string, TabHandle>());
  const blank: TabInfo = { address: '', title: '', back: false, forward: false, loading: true, error: null };
  const newTab = (src: string, activate = true) => {
    const id = crypto.randomUUID();
    setTabs((t) => [...t, { ...blank, id, src, address: src === 'about:blank' ? '' : src }]);
    if (activate) setActive(id);
    return id;
  };
  // Приложение запустилось (или сменило адрес) — его вкладка первой; остановили — она закрывается, остальные остаются.
  useEffect(() => {
    if (!appReady || !state.url) {
      setTabs((all) => all.filter((t) => !t.app));
      return;
    }
    const id = crypto.randomUUID();
    setTabs((all) => [{ ...blank, id, src: state.url!, address: state.url!, app: true }, ...all.filter((t) => !t.app)]);
    setActive(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [appReady, state.url]);
  const tabsRef = useRef(tabs);
  tabsRef.current = tabs;
  // Ссылка в новое окно со страницы одной из наших вкладок — новая вкладка рядом.
  useEffect(
    () =>
      bridge.onPreviewNewTab((fromId, url) => {
        if (tabsRef.current.some((t) => t.wcId === fromId)) newTab(url);
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );
  const cur = tabs.find((t) => t.id === active) ?? tabs[0];
  const info: Partial<TabInfo> | undefined = cur;
  const h = (): TabHandle | undefined => (cur ? handles.current.get(cur.id) : undefined);
  const setInfo = (id: string, i: Partial<Tab>) => setTabs((all) => all.map((t) => (t.id === id ? { ...t, ...i } : t)));
  const closeTab = (id: string) => {
    const tab = tabs.find((t) => t.id === id);
    // Вкладка приложения — остановить приложение: вкладка уйдёт, когда оно остановится.
    if (tab?.app) return void stopApp();
    const rest = tabs.filter((t) => t.id !== id);
    handles.current.delete(id);
    setTabs(rest);
    if (active === id) setActive(rest[Math.max(0, tabs.findIndex((t) => t.id === id) - 1)]?.id ?? null);
  };

  const [draft, setDraft] = useState('');
  const addressInput = useRef<HTMLInputElement>(null);
  // Адресная строка показывает адрес выбранной вкладки; пустая новая — фокус в строку.
  useEffect(() => {
    setDraft(info?.address ?? '');
    if (cur && !cur.address) addressInput.current?.focus();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cur?.id, info?.address]);
  const go = () => {
    if (!cur) return;
    h()?.load(normalizeAddress(draft, info?.address || state.url));
  };

  // Выбор элемента: скрипт в странице подсвечивает элемент под курсором и отдаёт описание по клику.
  const [picking, setPicking] = useState(false);
  const togglePick = async () => {
    const tab = h();
    if (!tab || !onPick) return;
    if (picking) return tab.cancelPick();
    setPicking(true);
    try {
      const el = await tab.pick();
      if (el) onPick(el);
    } catch {
      // Страница ушла на другой адрес посреди выбора — просто выходим из режима.
    } finally {
      setPicking(false);
    }
  };
  // Уход со страницы или на другую вкладку снимает выбор.
  useEffect(() => {
    if (picking) return () => h()?.cancelPick();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [picking, cur?.id]);

  const [mobile, setMobile] = useState(false);
  const toggleMobile = (m: boolean) => {
    setMobile(m);
    // Не готовые вкладки применят на dom-ready.
    for (const t of handles.current.values()) t.emulate(m);
  };

  if (!tabs.length) {
    return (
      <div className="browser-empty">
        <div className="browser-empty-card">
          <span className="browser-empty-icon">
            {state.status === 'failed' || error ? <TriangleAlert size={22} /> : <Globe size={22} />}
          </span>
          {state.status === 'starting' ? (
            <>
              <strong>Запускаю приложение…</strong>
              <p>
                <code>{state.command}</code>
              </p>
              <p className="muted">Ждём ответа на {state.url}</p>
              <span className="spinner big" />
              <Button tone="quiet" onClick={() => void stop()}>
                Отменить
              </Button>
            </>
          ) : state.status === 'failed' ? (
            <>
              <strong>Приложение не запустилось</strong>
              <p>{state.error}</p>
              {state.output && <pre className="browser-output">{state.output.trim().split('\n').slice(-20).join('\n')}</pre>}
              <Button tone="primary" icon={<RotateCw size={14} />} onClick={() => void start()}>
                Попробовать снова
              </Button>
            </>
          ) : (
            <>
              <strong>Проверьте результат сами</strong>
              <p>
                {intro ??
                  'Приложение поднимется из ветки прогона на свободном порту и откроется прямо здесь — можно протыкать изменения перед приёмкой.'}
              </p>
              {error && <p className="browser-error">{error}</p>}
              {canRun ? (
                <Button tone="primary" icon={<Globe size={15} />} onClick={() => void start()}>
                  Открыть приложение
                </Button>
              ) : (
                <p className="muted">
                  Задайте «Запуск приложения» и «Адрес» в настройках проекта (раздел «Проекты»){manual ? ' или откройте адрес вручную' : ''}
                  .
                </p>
              )}
              {manual && (
                <form
                  className="browser-manual"
                  onSubmit={(e) => {
                    e.preventDefault();
                    openManual();
                  }}
                >
                  <input
                    className="input mono"
                    value={typed}
                    onChange={(e) => setTyped(e.target.value)}
                    placeholder="localhost:3000, ya.ru или запрос"
                    aria-label="Адрес"
                    spellCheck={false}
                  />
                  <Button tone={canRun ? 'ghost' : 'primary'} type="submit">
                    Открыть адрес
                  </Button>
                </form>
              )}
            </>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="browser">
      <div className="browser-tabs" role="tablist" aria-label="Вкладки браузера">
        {tabs.map((t) => (
          <div key={t.id} className={`browser-tab ${t.id === cur?.id ? 'is-on' : ''}`} title={t.address || 'Новая вкладка'}>
            <button type="button" role="tab" aria-selected={t.id === cur?.id} className="browser-tab-main" onClick={() => setActive(t.id)}>
              {t.loading ? <span className="spinner" /> : <Globe size={13} />}
              <span className="browser-tab-title">{tabLabel(t)}</span>
            </button>
            <button
              type="button"
              className="browser-tab-close"
              aria-label={`Закрыть вкладку ${tabLabel(t)}`}
              onClick={() => closeTab(t.id)}
            >
              <X size={12} />
            </button>
          </div>
        ))}
        <button
          type="button"
          className="browser-tab-new"
          aria-label="Новая вкладка"
          title="Новая вкладка"
          onClick={() => newTab('about:blank')}
        >
          <Plus size={14} />
        </button>
      </div>
      <div className="browser-bar">
        <Button tone="quiet" icon={<ArrowLeft size={16} />} title="Назад" disabled={!info?.back} onClick={() => h()?.back()} />
        <Button tone="quiet" icon={<ArrowRight size={16} />} title="Вперёд" disabled={!info?.forward} onClick={() => h()?.forward()} />
        <Button
          tone="quiet"
          icon={<RotateCw size={15} className={info?.loading ? 'spin' : ''} />}
          title="Обновить"
          onClick={() => h()?.reload()}
        />
        <form
          className="browser-address"
          onSubmit={(e) => {
            e.preventDefault();
            go();
          }}
        >
          <input
            ref={addressInput}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            spellCheck={false}
            aria-label="Адрес"
            placeholder="Адрес или поиск"
          />
        </form>
        {onPick && (
          <Button
            tone="quiet"
            className={`browser-pick ${picking ? 'is-on' : ''}`}
            icon={<SquareMousePointer size={15} />}
            title={picking ? 'Отменить выбор (Esc)' : 'Указать элемент на странице — описание попадёт в поле ввода чата'}
            aria-label="Указать элемент"
            aria-pressed={picking}
            onClick={() => void togglePick()}
          />
        )}
        <div className="segmented small" role="radiogroup" aria-label="Устройство">
          <button
            role="radio"
            aria-checked={!mobile}
            className={!mobile ? 'is-on' : ''}
            title="Десктоп"
            onClick={() => toggleMobile(false)}
          >
            <Monitor size={14} />
          </button>
          <button role="radio" aria-checked={mobile} className={mobile ? 'is-on' : ''} title="Телефон" onClick={() => toggleMobile(true)}>
            <Smartphone size={14} />
          </button>
        </div>
        <Button
          tone="quiet"
          icon={<ExternalLink size={15} />}
          title="Открыть в системном браузере"
          onClick={() => void window.open(cur?.address || state.url, '_blank')}
        />
        {tabs.some((t) => t.app) && (
          <Button tone="quiet" icon={<Square size={13} />} title="Остановить приложение" onClick={() => void stopApp()} />
        )}
      </div>
      {cur?.error && <p className="browser-error browser-load-error">{cur.error}</p>}
      {picking && <p className="browser-pick-hint">Наведите на элемент и нажмите — описание попадёт в чат. Esc — отмена.</p>}
      <div className={`browser-stage ${mobile ? 'is-mobile' : ''}`}>
        {tabs.map((t) => (
          <BrowserTab
            key={t.id}
            ref={(el) => {
              if (el) handles.current.set(t.id, el);
            }}
            src={t.src}
            hidden={t.id !== cur?.id}
            mobile={mobile}
            onInfo={(i) => setInfo(t.id, i)}
            onId={(wcId) => setInfo(t.id, { wcId })}
          />
        ))}
      </div>
    </div>
  );
}
