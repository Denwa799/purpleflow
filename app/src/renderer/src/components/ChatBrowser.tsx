// Браузер чата — общий с агентом: Chrome без окна в ядре. Вкладки — его вкладки (и человека, и агента), экран
// выбранной транслируется кадрами, ввод — в неё. Агент через pw видит те же вкладки.
import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import {
  ArrowLeft,
  ArrowRight,
  ExternalLink,
  Globe,
  Monitor,
  Plus,
  RotateCw,
  Smartphone,
  SquareMousePointer,
  TriangleAlert,
  X,
} from 'lucide-react';
import { bridge } from '../lib/api';
import { onCoreEvent } from '../lib/store';
import { CANCEL_PICK_SCRIPT, PICK_SCRIPT, type PickedElement } from '../lib/pickElement';
import { normalizeAddress } from '../../../shared/urls';
import { frameInput, tabLabel, type useAgentScreen, type usePreview } from './BrowserPane';
import { Button } from './ui';

type Action = Parameters<typeof bridge.core.controlChatBrowser>[1];
interface Tabs {
  tabs: { id: string; url: string; title: string }[];
  active: string | null;
}

/** Есть ли браузер чата на этой машине (Chrome) — спрашиваем ядро один раз. */
type Mode = 'webview' | 'stream' | false;
let availability: Promise<Mode> | null = null;
export function useChatBrowserAvailable(): Mode | null {
  const [ok, setOk] = useState<Mode | null>(null);
  useEffect(() => {
    const p = (availability ??= bridge.core.chatBrowserAvailable().catch((): Mode => false));
    let alive = true;
    void p.then((v) => alive && setOk(v));
    return () => {
      alive = false;
    };
  }, []);
  return ok;
}

export function ChatBrowser({
  chatId,
  screen,
  preview,
  canRun,
  busy,
  intro,
  onPick,
}: {
  chatId: string;
  /** Кадры выбранной вкладки (трансляция из ядра). */
  screen: ReturnType<typeof useAgentScreen>;
  preview: ReturnType<typeof usePreview>;
  canRun: boolean;
  /** Агент отвечает — в адресе значок «Агент работает». */
  busy: boolean;
  intro?: string;
  onPick?: (el: PickedElement) => void;
}) {
  const [tabs, setTabs] = useState<Tabs>({ tabs: [], active: null });
  const [nav, setNav] = useState({ back: false, forward: false });
  const [error, setError] = useState<string | null>(null);
  /** Страница показываемой вкладки грузится: спиннер на вкладке, крутится «Обновить», полоска над страницей. */
  // Храним, какая вкладка грузится: переключились на другую — индикатор её, а не прежней.
  const [loadingTab, setLoadingTab] = useState<string | null>(null);
  // Только адрес кадра: сами кадры (~15 в секунду) перерисовывают лишь картинку, а не всю панель.
  const frameUrl = useSyncExternalStore(screen.store.subscribe, () => screen.store.get().frame?.url ?? '');
  const ctl = async (a: Action): Promise<unknown> => {
    try {
      const r = await bridge.core.controlChatBrowser(chatId, a);
      if (r && typeof r === 'object') {
        if ('tabs' in r) setTabs(r as Tabs);
        else if ('back' in r) setNav(r as { back: boolean; forward: boolean });
      }
      setError(null);
      return r;
    } catch (e) {
      setError((e as Error).message.replace(/^.*Error: /, ''));
      return null;
    }
  };
  // Вкладки: при открытии панели и по событиям ядра (агент открыл, закрыл, перешёл).
  useEffect(() => {
    void ctl({ type: 'tabs' });
    return onCoreEvent((e) => {
      if (e.type === 'browser.tabs' && e.chatId === chatId) setTabs({ tabs: e.tabs, active: e.active });
      else if (e.type === 'browser.loading' && e.chatId === chatId)
        setLoadingTab((was) => (e.loading ? e.tab : was === e.tab ? null : was));
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chatId]);
  // Chrome отдаёт вкладки от новой к старой — держим порядок, в котором они появились, как в обычном браузере.
  const order = useRef(new Map<string, number>());
  for (const t of tabs.tabs) if (!order.current.has(t.id)) order.current.set(t.id, order.current.size);
  const shown = [...tabs.tabs].sort((x, y) => order.current.get(x.id)! - order.current.get(y.id)!);
  const cur = tabs.tabs.find((t) => t.id === tabs.active) ?? shown[0];
  const url = frameUrl || cur?.url || '';
  const loading = !!cur && loadingTab === cur.id;
  const startLoading = () => cur && setLoadingTab(cur.id);
  // Chrome не сообщил о конце загрузки (вкладку закрыли, связь оборвалась) — не крутим вечно.
  useEffect(() => {
    if (!loadingTab) return;
    const t = setTimeout(() => setLoadingTab(null), 30_000);
    return () => clearTimeout(t);
  }, [loadingTab]);
  // Страница сменилась — обновляем «назад/вперёд».
  useEffect(() => {
    if (cur) void ctl({ type: 'state' });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cur?.id, url]);

  // Приложение проекта поднялось — открываем его во вкладке (один раз на адрес).
  const opened = useRef<string | null>(null);
  useEffect(() => {
    const u = preview.state.status === 'ready' ? preview.state.url : null;
    if (!u || opened.current === u) return;
    opened.current = u;
    if (!tabs.tabs.some((t) => t.url.startsWith(u))) void ctl({ type: 'newTab', url: u });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [preview.state]);

  const [draft, setDraft] = useState('');
  const address = useRef<HTMLInputElement>(null);
  useEffect(() => {
    // Пока человек печатает адрес, переходы агента его не перебивают.
    if (document.activeElement === address.current) return;
    setDraft(url === 'about:blank' ? '' : url);
  }, [url]);
  const go = () => {
    // Индикатор — сразу по Enter, не дожидаясь события от Chrome.
    startLoading();
    void ctl({ type: 'navigate', url: normalizeAddress(draft, url) });
  };

  const [picking, setPicking] = useState(false);
  const togglePick = async () => {
    if (!onPick) return;
    if (picking) return void ctl({ type: 'eval', expression: CANCEL_PICK_SCRIPT });
    setPicking(true);
    try {
      const el = (await ctl({ type: 'eval', expression: PICK_SCRIPT })) as PickedElement | null;
      if (el) onPick(el);
    } finally {
      setPicking(false);
    }
  };

  const [mobile, setMobile] = useState(false);
  const toggleMobile = (m: boolean) => {
    setMobile(m);
    void ctl({ type: 'mobile', on: m });
  };

  const [typed, setTyped] = useState('');
  if (!tabs.tabs.length) {
    return (
      <div className="browser-empty">
        <div className="browser-empty-card">
          <span className="browser-empty-icon">
            {preview.state.status === 'failed' ? <TriangleAlert size={22} /> : <Globe size={22} />}
          </span>
          <strong>Браузер чата</strong>
          <p>{intro ?? 'Откройте сайт или своё приложение — агент видит те же вкладки и может с ними работать.'}</p>
          {preview.state.status === 'starting' && <span className="spinner big" />}
          {preview.state.status === 'failed' && <p className="browser-error">{preview.state.error}</p>}
          {error && <p className="browser-error">{error}</p>}
          {canRun && preview.state.status !== 'starting' && (
            <Button tone="primary" icon={<Globe size={15} />} onClick={() => void preview.start()}>
              Открыть приложение
            </Button>
          )}
          <form
            className="browser-manual"
            onSubmit={(e) => {
              e.preventDefault();
              if (typed.trim()) void ctl({ type: 'newTab', url: normalizeAddress(typed) });
            }}
          >
            <input
              className="input mono"
              value={typed}
              onChange={(e) => setTyped(e.target.value)}
              placeholder="ya.ru, localhost:3000 или запрос"
              aria-label="Адрес"
              spellCheck={false}
            />
            <Button tone={canRun ? 'ghost' : 'primary'} type="submit">
              Открыть адрес
            </Button>
          </form>
        </div>
      </div>
    );
  }

  return (
    <div className="browser">
      <div className="browser-tabs" role="tablist" aria-label="Вкладки браузера">
        {shown.map((t) => {
          const on = t.id === cur?.id;
          const label = tabLabel({ title: t.title === t.url ? '' : t.title, address: t.url === 'about:blank' ? '' : t.url });
          return (
            <div key={t.id} className={`browser-tab ${on ? 'is-on' : ''}`} title={t.url}>
              <button
                type="button"
                role="tab"
                aria-selected={on}
                className="browser-tab-main"
                onClick={() => void ctl({ type: 'select', tab: t.id })}
              >
                {on && loading ? <span className="spinner" /> : <Globe size={13} />}
                <span className="browser-tab-title">{label}</span>
              </button>
              <button
                type="button"
                className="browser-tab-close"
                aria-label={`Закрыть вкладку ${label}`}
                onClick={() => void ctl({ type: 'closeTab', tab: t.id })}
              >
                <X size={12} />
              </button>
            </div>
          );
        })}
        <button
          type="button"
          className="browser-tab-new"
          aria-label="Новая вкладка"
          title="Новая вкладка"
          onClick={() => {
            void ctl({ type: 'newTab', url: 'about:blank' });
            setDraft('');
            address.current?.focus();
          }}
        >
          <Plus size={14} />
        </button>
      </div>
      <div className="browser-bar">
        <Button tone="quiet" icon={<ArrowLeft size={16} />} title="Назад" disabled={!nav.back} onClick={() => void ctl({ type: 'back' })} />
        <Button
          tone="quiet"
          icon={<ArrowRight size={16} />}
          title="Вперёд"
          disabled={!nav.forward}
          onClick={() => void ctl({ type: 'forward' })}
        />
        <Button
          tone="quiet"
          icon={<RotateCw size={15} className={loading ? 'spin' : ''} />}
          title="Обновить"
          onClick={() => {
            startLoading();
            void ctl({ type: 'reload' });
          }}
        />
        <form
          className="browser-address"
          onSubmit={(e) => {
            e.preventDefault();
            go();
          }}
        >
          <input
            ref={address}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            spellCheck={false}
            aria-label="Адрес"
            placeholder="Адрес или поиск"
          />
          {busy && (
            <span className="browser-agent-badge">
              <i />
              Агент работает
            </span>
          )}
        </form>
        {onPick && (
          <Button
            tone="quiet"
            className={`browser-pick ${picking ? 'is-on' : ''}`}
            icon={<SquareMousePointer size={15} />}
            title={picking ? 'Отменить выбор' : 'Указать элемент на странице — описание попадёт в поле ввода чата'}
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
          onClick={() => url && url !== 'about:blank' && void window.open(url, '_blank')}
        />
      </div>
      {error && <p className="browser-error browser-load-error">{error}</p>}
      {picking && <p className="browser-pick-hint">Наведите на элемент и нажмите — описание попадёт в чат.</p>}
      <div className={`browser-stage agent-stage ${loading ? 'is-loading' : ''}`}>
        {loading && <span className="browser-progress" role="progressbar" aria-label="Страница загружается" />}
        <Frame screen={screen} input={frameInput(ctl)} />
      </div>
    </div>
  );
}

/**
 * Экран вкладки — canvas: кадр декодируется вне главного потока (createImageBitmap) и рисуется без React.
 * Пока прошлый кадр декодируется, промежуточные пропускаем — показываем самый свежий.
 */
function Frame({ screen, input }: { screen: ReturnType<typeof useAgentScreen>; input: ReturnType<typeof frameInput> }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const has = useSyncExternalStore(screen.store.subscribe, () => !!screen.store.get().frame);
  useEffect(() => {
    let busy = false;
    let next: string | null = null;
    let alive = true;
    const draw = async (data: string) => {
      busy = true;
      try {
        const bytes = Uint8Array.from(atob(data), (c) => c.charCodeAt(0));
        const bmp = await createImageBitmap(new Blob([bytes], { type: 'image/jpeg' }));
        const c = canvas.current;
        if (alive && c) {
          if (c.width !== bmp.width || c.height !== bmp.height) {
            c.width = bmp.width;
            c.height = bmp.height;
          }
          c.getContext('2d')?.drawImage(bmp, 0, 0);
        }
        bmp.close();
      } catch {
        /* битый кадр — ждём следующий */
      }
      busy = false;
      if (alive && next) {
        const n = next;
        next = null;
        void draw(n);
      }
    };
    const show = () => {
      const f = screen.store.get().frame;
      if (!f) return;
      if (busy) next = f.data;
      else void draw(f.data);
    };
    show();
    const off = screen.store.subscribe(show);
    return () => {
      alive = false;
      off();
    };
  }, [screen.store, has]);
  if (!has) return <span className="spinner big" />;
  return <canvas ref={canvas} className="agent-frame is-live" role="img" aria-label="Экран браузера" tabIndex={0} {...input} />;
}
