// Панель «Браузер» чата: вкладки, адрес и место под страницу. Сами страницы — настоящие <webview> в слое окна
// (ChatWebHost): панель только показывает, где их поставить. Агент работает с теми же вкладками через мост.
import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  ArrowLeft,
  ArrowRight,
  ExternalLink,
  Globe,
  Monitor,
  Plus,
  RotateCw,
  Smartphone,
  Maximize2,
  Tablet,
  SquareMousePointer,
  TriangleAlert,
  X,
} from 'lucide-react';
import { CANCEL_PICK_SCRIPT, PICK_SCRIPT, type PickedElement } from '../lib/pickElement';
import { normalizeAddress } from '../../../shared/urls';
import { SIZES, closeTab, openTab, patchTab, selectTab, setSlot, setTabSize, useChatWeb, viewOf, type WebTab } from '../lib/chatWeb';
import { tabLabel, type usePreview } from './BrowserPane';
import { Button } from './ui';

export function ChatWebPane({
  chatId,
  preview,
  canRun,
  busy,
  onPick,
}: {
  chatId: string;
  preview: ReturnType<typeof usePreview>;
  canRun: boolean;
  /** Агент отвечает — в адресе значок «Агент работает». */
  busy: boolean;
  onPick?: (el: PickedElement) => void;
}) {
  const web = useChatWeb(chatId);
  const cur = web.tabs.find((t) => t.key === web.active) ?? web.tabs[0];
  const view = () => (cur ? viewOf(cur.key) : null);
  /** Вызов webview: до dom-ready его методы бросают — тогда просто ничего. */
  const call = (fn: (w: NonNullable<ReturnType<typeof viewOf>>) => unknown) => {
    const w = view();
    if (!w) return;
    try {
      const r = fn(w);
      if (r instanceof Promise) r.catch(() => {});
    } catch {
      /* ещё не готов */
    }
  };

  // Приложение проекта поднялось — открываем его во вкладке (один раз на адрес).
  const opened = useRef<string | null>(null);
  useEffect(() => {
    const u = preview.state.status === 'ready' ? preview.state.url : null;
    if (!u || opened.current === u) return;
    opened.current = u;
    if (!web.tabs.some((t) => t.url.startsWith(u))) openTab(chatId, u);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [preview.state]);

  const url = cur?.url ?? '';
  const [draft, setDraft] = useState('');
  const address = useRef<HTMLInputElement>(null);
  useEffect(() => {
    // Пока человек печатает адрес, переходы агента его не перебивают.
    if (document.activeElement === address.current) return;
    setDraft(url);
  }, [url, cur?.key]);
  const go = () => {
    if (!draft.trim()) return;
    // Вкладок ещё нет — адрес открывает первую.
    if (!cur) {
      openTab(chatId, normalizeAddress(draft));
      address.current?.blur();
      return;
    }
    const to = normalizeAddress(draft, url);
    // Индикатор — сразу по Enter, не дожидаясь событий страницы.
    patchTab(chatId, cur.key, { loading: true, error: null });
    call((w) => w.loadURL(to));
    address.current?.blur();
  };

  const [picking, setPicking] = useState(false);
  const togglePick = async () => {
    if (!onPick) return;
    if (picking) return call((w) => w.executeJavaScript(CANCEL_PICK_SCRIPT));
    const w = view();
    if (!w) return;
    setPicking(true);
    try {
      const el = (await w.executeJavaScript(PICK_SCRIPT, true)) as PickedElement | null;
      if (el) onPick(el);
    } catch {
      /* страница ушла */
    } finally {
      setPicking(false);
    }
  };

  const loading = Boolean(cur?.loading);
  return (
    <div className="browser">
      <div className="browser-tabs" role="tablist" aria-label="Вкладки браузера">
        {web.tabs.map((t) => {
          const on = t.key === cur?.key;
          const label = tabLabel({ title: t.title, address: t.url });
          return (
            <div key={t.key} className={`browser-tab ${on ? 'is-on' : ''}`} title={t.url}>
              <button type="button" role="tab" aria-selected={on} className="browser-tab-main" onClick={() => selectTab(chatId, t.key)}>
                {t.loading ? <span className="spinner" /> : <Globe size={13} />}
                <span className="browser-tab-title">{label}</span>
              </button>
              <button
                type="button"
                className="browser-tab-close"
                aria-label={`Закрыть вкладку ${label}`}
                onClick={() => closeTab(chatId, t.key)}
              >
                <X size={12} />
              </button>
            </div>
          );
        })}
        {/* Вкладок нет — пустая «Новая вкладка», как в обычном браузере; настоящая появится с первым адресом. */}
        {!web.tabs.length && (
          <div className="browser-tab is-on">
            <button type="button" role="tab" aria-selected className="browser-tab-main" onClick={() => address.current?.focus()}>
              <Globe size={13} />
              <span className="browser-tab-title">Новая вкладка</span>
            </button>
          </div>
        )}
        <button
          type="button"
          className="browser-tab-new"
          aria-label="Новая вкладка"
          title="Новая вкладка"
          onClick={() => {
            // Пустая «Новая вкладка» уже показана — второй пустой не нужно.
            if (web.tabs.length) openTab(chatId, 'about:blank');
            setDraft('');
            address.current?.focus();
          }}
        >
          <Plus size={14} />
        </button>
      </div>
      <div className="browser-bar">
        <Button tone="quiet" icon={<ArrowLeft size={16} />} title="Назад" disabled={!cur?.back} onClick={() => call((w) => w.goBack())} />
        <Button
          tone="quiet"
          icon={<ArrowRight size={16} />}
          title="Вперёд"
          disabled={!cur?.forward}
          onClick={() => call((w) => w.goForward())}
        />
        <Button
          tone="quiet"
          icon={<RotateCw size={15} className={loading ? 'spin' : ''} />}
          title="Обновить"
          disabled={!cur}
          onClick={() => {
            if (cur) patchTab(chatId, cur.key, { loading: true, error: null });
            call((w) => w.reload());
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
            disabled={!cur}
            onClick={() => void togglePick()}
          />
        )}
        {cur && <SizeMenu chatId={chatId} tab={cur} />}
        <Button
          tone="quiet"
          icon={<ExternalLink size={15} />}
          title="Открыть в системном браузере"
          disabled={!url}
          onClick={() => url && void window.open(url, '_blank')}
        />
        {loading && <span className="browser-progress" role="progressbar" aria-label="Страница загружается" />}
      </div>
      {cur?.error && <p className="browser-error browser-load-error">{cur.error}</p>}
      {picking && <p className="browser-pick-hint">Наведите на элемент и нажмите — описание попадёт в чат.</p>}
      {web.tabs.length ? (
        /* Место страницы: слой окна ставит сюда webview показанной вкладки. */
        <div
          className="browser-stage chatweb-slot"
          ref={(el) => {
            setSlot(chatId, el);
          }}
        />
      ) : (
        /* Вкладок нет — как новая вкладка обычного браузера: адрес сверху, здесь — подсказка и своё приложение. */
        <div className="browser-stage browser-newtab">
          <span className="browser-empty-icon">
            {preview.state.status === 'failed' ? <TriangleAlert size={22} /> : <Globe size={22} />}
          </span>
          <p>Введите адрес или запрос сверху — агент видит те же вкладки и может с ними работать.</p>
          {preview.state.status === 'starting' && <span className="spinner big" />}
          {preview.state.status === 'failed' && <p className="browser-error">{preview.state.error}</p>}
          {canRun && preview.state.status !== 'starting' && (
            <Button tone="primary" icon={<Globe size={15} />} onClick={() => void preview.start()}>
              Открыть приложение
            </Button>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * Размер страницы: по панели или настоящие пиксели устройства. Меню — в портале над окном: страница вкладки лежит в
 * слое окна поверх панели и закрыла бы выпадающий список.
 */
function SizeMenu({ chatId, tab }: { chatId: string; tab: WebTab }) {
  const [at, setAt] = useState<{ top: number; right: number } | null>(null);
  const btn = useRef<HTMLButtonElement>(null);
  const preset = SIZES.find((p) => tab.size && p.width === tab.size.width && p.height === tab.size.height);
  const label = tab.size ? `${tab.size.width}×${tab.size.height}` : null;
  const open = () => {
    const r = btn.current?.getBoundingClientRect();
    if (r) setAt({ top: r.bottom + 6, right: window.innerWidth - r.right });
  };
  const pick = (size: { width: number; height: number } | null, mobile: boolean) => {
    setTabSize(chatId, tab.key, size, mobile);
    setAt(null);
  };
  return (
    <>
      <button
        ref={btn}
        type="button"
        className={`browser-size ${tab.size ? 'is-on' : ''}`}
        aria-haspopup="menu"
        aria-expanded={Boolean(at)}
        aria-label="Размер страницы"
        title={tab.size ? `Размер страницы ${label}${preset ? ` — ${preset.label}` : ''}` : 'Размер страницы: по панели'}
        onClick={() => (at ? setAt(null) : open())}
      >
        {tab.mobile ? <Smartphone size={14} /> : <Monitor size={14} />}
        {label && <span>{label}</span>}
      </button>
      {at &&
        createPortal(
          <>
            <div className="side-create-scrim" onClick={() => setAt(null)} />
            <div
              className="side-create-menu browser-size-menu"
              role="menu"
              aria-label="Размер страницы"
              style={{ top: at.top, right: at.right }}
            >
              <button role="menuitemradio" aria-checked={!tab.size} className={!tab.size ? 'is-on' : ''} onClick={() => pick(null, false)}>
                <Maximize2 size={15} />
                <span>
                  <strong>По панели</strong>
                  <small>Страница занимает всю панель</small>
                </span>
              </button>
              {SIZES.map((p) => {
                const on = preset?.id === p.id;
                return (
                  <button
                    key={p.id}
                    role="menuitemradio"
                    aria-checked={on}
                    className={on ? 'is-on' : ''}
                    onClick={() => pick({ width: p.width, height: p.height }, p.mobile)}
                  >
                    {p.mobile ? <Smartphone size={15} /> : p.id === 'tablet' ? <Tablet size={15} /> : <Monitor size={15} />}
                    <span>
                      <strong>{p.label}</strong>
                      <small>
                        {p.width}×{p.height}
                        {p.mobile ? ' · мобильная версия сайта' : ''}
                      </small>
                    </span>
                  </button>
                );
              })}
            </div>
          </>,
          document.body,
        )}
    </>
  );
}
