import { useEffect, useState, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react';
import { Activity, CircleAlert, FileCode2, FolderTree, GitBranch, Globe, PanelRightClose, Play, RefreshCw } from 'lucide-react';
import { GitView } from '../components/GitView';
import { ChatFiles } from './ChatFiles';
import { ChatRunPane } from './ChatRunPane';
import { chatSession } from '../lib/chatSession';
import type { PickedElement } from '../lib/pickElement';
import { ChatSessionPane, ContextRing } from './ChatSessionPane';
import type { ChatFile, DiffFile, ProjectConfig } from '@purpleflow/core';
import { BrowserPane, usePreview } from '../components/BrowserPane';
import { DiffReview } from '../components/diff/DiffReview';
import { PillTabs } from '../components/PillTabs';
import { Button, Empty } from '../components/ui';
import { bridge, cleanErr } from '../lib/api';

export type ChatPane = 'session' | 'files' | 'code' | 'git' | 'run' | 'browser';

/** Изменённые файлы проекта чата — счётчик на кнопке «Код»; обновляется после каждого хода агента. */
export function useChatChanged(chat: ChatFile | null, busy: boolean): string[] | null {
  const [files, setFiles] = useState<string[] | null>(null);
  const id = chat?.id;
  const project = chat?.projectPath;
  const done = busy ? 'busy' : chat?.updatedAt;
  useEffect(() => {
    if (!id || !project) return setFiles(null);
    let alive = true;
    bridge.core
      .getChatChangedFiles(id)
      .then((f) => alive && setFiles(f))
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [id, project, done]);
  return files;
}

const WIDTH_KEY = 'purpleflow.chatSideW';
const MIN_W = 380;

/** Ширина правой панели чата: тянется за ручку слева, запоминается для всех чатов. */
export function useSideWidth() {
  const [width, setWidth] = useState<number>(() => {
    try {
      const v = Number(localStorage.getItem(WIDTH_KEY));
      return v >= MIN_W ? v : 640;
    } catch {
      return 640;
    }
  });
  const startResize = (e: ReactPointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    const x0 = e.clientX;
    const w0 = width;
    let w = w0;
    // Чату слева оставляем не меньше 360 px.
    const max = Math.max(MIN_W, (e.currentTarget.closest('.chat-body')?.clientWidth ?? window.innerWidth) - 360);
    const move = (ev: PointerEvent) => {
      w = Math.min(max, Math.max(MIN_W, w0 - (ev.clientX - x0)));
      setWidth(w);
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      document.body.classList.remove('is-col-resizing', 'is-side-resizing');
      try {
        localStorage.setItem(WIDTH_KEY, String(Math.round(w)));
      } catch {
        /* без памяти о ширине */
      }
    };
    document.body.classList.add('is-col-resizing', 'is-side-resizing');
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };
  const reset = () => {
    setWidth(640);
    try {
      localStorage.removeItem(WIDTH_KEY);
    } catch {
      /* без памяти о ширине */
    }
  };
  return { width, startResize, reset };
}

/**
 * Правая панель чата — карточка со вкладками «Сессия», «Код» и «Браузер», как у прогона.
 * Обе вкладки остаются смонтированными — страница в браузере не перезагружается.
 */
export function ChatSide({
  chat,
  busy,
  pane,
  onPane,
  changed,
  width,
  onResize,
  onResetWidth,
  model,
  onPick,
  onMention,
}: {
  chat: ChatFile;
  /** Файл или папка из вкладки «Файлы» — «@путь» в поле ввода. */
  onMention: (path: string) => void;
  /** Выбранная модель: своя у чата или по умолчанию. */
  model: string;
  /** Элемент, указанный во вкладке «Браузер», — в поле ввода чата. */
  onPick: (el: PickedElement) => void;
  busy: boolean;
  pane: ChatPane;
  onPane: (p: ChatPane | null) => void;
  changed: string[] | null;
  width: number;
  onResize: (e: ReactPointerEvent<HTMLDivElement>) => void;
  onResetWidth: () => void;
}) {
  const [cfg, setCfg] = useState<ProjectConfig | null>(null);
  const preview = usePreview(chat.id);
  useEffect(() => {
    if (chat.projectPath)
      bridge.core
        .getProjectConfig(chat.projectPath)
        .then(setCfg)
        .catch(() => {});
  }, [chat.projectPath]);
  const canRun = Boolean(cfg?.runCommand && cfg.appUrl);

  return (
    <section className="run-main chat-side" style={{ width }} aria-label="Код и браузер">
      <div
        className="side-resize"
        onPointerDown={onResize}
        onDoubleClick={onResetWidth}
        title="Потяните, чтобы изменить ширину; двойной клик — по умолчанию"
      />
      <div className="tab-groups">
        <PillTabs<ChatPane>
          className="tabs"
          value={pane}
          onChange={onPane}
          items={[
            { id: 'session', label: 'Сессия', icon: <Activity size={15} /> },
            ...(chat.projectPath
              ? [
                  { id: 'files' as const, label: 'Файлы', icon: <FolderTree size={15} /> },
                  {
                    id: 'code' as const,
                    label: 'Код',
                    icon: <FileCode2 size={15} />,
                    extra: changed?.length ? <span className="tab-badge">{changed.length}</span> : undefined,
                  },
                  { id: 'git' as const, label: 'Git', icon: <GitBranch size={15} /> },
                  {
                    id: 'run' as const,
                    label: 'Запуск',
                    icon: <Play size={15} />,
                    extra:
                      preview.state.status === 'ready' ? (
                        <span className="tab-dot is-ok" />
                      ) : preview.state.status === 'starting' ? (
                        <span className="tab-live" />
                      ) : preview.state.status === 'failed' ? (
                        <span className="tab-dot is-error" />
                      ) : undefined,
                  },
                ]
              : []),
            {
              id: 'browser',
              label: 'Браузер',
              icon: <Globe size={15} />,
              extra:
                preview.state.status === 'ready' ? (
                  <span className="tab-dot is-ok" />
                ) : preview.state.status === 'starting' ? (
                  <span className="tab-live" />
                ) : undefined,
            },
          ]}
        />
        <span className="grow" />
        <button className="manager-collapse" title="Скрыть панель" aria-label="Скрыть панель" onClick={() => onPane(null)}>
          <PanelRightClose size={16} />
        </button>
      </div>
      <div className="chat-side-body" hidden={pane !== 'session'}>
        {pane === 'session' && <ChatSessionPane chat={chat} model={model} busy={busy} />}
      </div>
      <div className="chat-side-body" hidden={pane !== 'files'}>
        {chat.projectPath && pane === 'files' && (
          <ChatFiles projectPath={chat.projectPath} refresh={busy ? 'busy' : chat.updatedAt} onMention={onMention} />
        )}
      </div>
      <div className="chat-side-body" hidden={pane !== 'code'}>
        {chat.projectPath && <ChatCode chat={chat} busy={busy} />}
      </div>
      <div className="chat-side-body" hidden={pane !== 'git'}>
        {chat.projectPath && pane === 'git' && (
          <div className="chat-code">
            <GitView projectPath={chat.projectPath} refresh={busy ? 'busy' : chat.updatedAt} />
          </div>
        )}
      </div>
      <div className="chat-side-body" hidden={pane !== 'run'}>
        {chat.projectPath && pane === 'run' && (
          <ChatRunPane projectPath={chat.projectPath} cfg={cfg} preview={preview} onOpenBrowser={() => onPane('browser')} />
        )}
      </div>
      <div className="chat-side-body" hidden={pane !== 'browser'}>
        <BrowserPane
          preview={preview}
          canRun={canRun}
          manual
          onPick={onPick}
          intro={
            canRun
              ? 'Приложение поднимется из папки проекта на свободном порту и откроется прямо здесь.'
              : 'Откройте страницу своего локального сервера — проверьте, что поменял агент.'
          }
        />
      </div>
    </section>
  );
}

/**
 * Свёрнутая панель — узкая полоса справа: сверху заполнение контекста («Сессия»),
 * ниже — иконки доступных вкладок; клик открывает панель сразу на нужной.
 */
export function ChatSideRail({ chat, changed, onOpen }: { chat: ChatFile; changed: string[] | null; onOpen: (p: ChatPane) => void }) {
  const ctx = chatSession(chat).context;
  const preview = usePreview(chat.id);
  // Свои подсказки: системные title в окне Electron появляются не всегда.
  // Полоса обрезает переполнение, поэтому подсказка — fixed, слева от кнопки.
  const [tip, setTip] = useState<{ label: string; top: number; right: number } | null>(null);
  const showTip = (label: string, el: HTMLElement) => {
    const r = el.getBoundingClientRect();
    setTip({ label, top: r.top + r.height / 2, right: window.innerWidth - r.left + 8 });
  };
  const live =
    preview.state.status === 'ready' ? (
      <span className="tab-dot is-ok" />
    ) : preview.state.status === 'starting' ? (
      <span className="tab-live" />
    ) : preview.state.status === 'failed' ? (
      <span className="tab-dot is-error" />
    ) : null;
  const items: { id: ChatPane; label: string; icon: ReactNode; extra?: ReactNode }[] = [
    ...(chat.projectPath
      ? [
          { id: 'files' as const, label: 'Файлы проекта', icon: <FolderTree size={16} /> },
          {
            id: 'code' as const,
            label: changed?.length ? `Изменения: ${changed.length}` : 'Изменения',
            icon: <FileCode2 size={16} />,
            extra: changed?.length ? <span className="chat-rail-count">{changed.length}</span> : null,
          },
          { id: 'git' as const, label: 'Git', icon: <GitBranch size={16} /> },
          { id: 'run' as const, label: 'Запуск приложения', icon: <Play size={16} />, extra: live },
        ]
      : []),
    {
      id: 'browser',
      label: 'Браузер',
      icon: <Globe size={16} />,
      extra: preview.state.status === 'ready' ? <span className="tab-dot is-ok" /> : null,
    },
  ];
  const sessionTip = ctx
    ? `Сессия · контекст ${ctx.pct != null ? `${ctx.pct}% окна` : `${Math.round(ctx.used / 1000)} тыс. токенов`}`
    : 'Сессия';
  return (
    <aside className="run-main chat-side is-collapsed" aria-label="Панель чата">
      <button
        className="chat-rail-session"
        onClick={() => {
          setTip(null);
          onOpen('session');
        }}
        onMouseEnter={(e) => showTip(sessionTip, e.currentTarget)}
        onMouseLeave={() => setTip(null)}
        onFocus={(e) => showTip(sessionTip, e.currentTarget)}
        onBlur={() => setTip(null)}
        aria-label="Сессия"
      >
        <ContextRing pct={ctx?.pct} />
        {ctx?.pct != null && <span className="chat-rail-pct">{ctx.pct}%</span>}
      </button>
      <nav className="chat-rail-tabs" aria-label="Вкладки панели">
        {items.map((it) => (
          <button
            key={it.id}
            className="chat-rail-tab"
            aria-label={it.label}
            onMouseEnter={(e) => showTip(it.label, e.currentTarget)}
            onMouseLeave={() => setTip(null)}
            onFocus={(e) => showTip(it.label, e.currentTarget)}
            onBlur={() => setTip(null)}
            onClick={() => {
              setTip(null);
              onOpen(it.id);
            }}
          >
            {it.icon}
            {it.extra}
          </button>
        ))}
      </nav>
      {tip && (
        <span className="chat-rail-tip" role="tooltip" style={{ top: tip.top, right: tip.right }}>
          {tip.label}
        </span>
      )}
    </aside>
  );
}

const time = (d: Date) => d.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });

/** Незакоммиченные изменения проекта: всё, что сделал агент (и вы), относительно последнего коммита. */
function ChatCode({ chat, busy }: { chat: ChatFile; busy: boolean }) {
  const [diff, setDiff] = useState<DiffFile[] | null>(null);
  const [at, setAt] = useState<Date | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const load = async () => {
    setLoading(true);
    setError(null);
    try {
      setDiff(await bridge.core.getChatDiff(chat.id));
      setAt(new Date());
    } catch (e) {
      setError(cleanErr(e));
    } finally {
      setLoading(false);
    }
  };
  // Ход агента закончился — код мог поменяться.
  const done = busy ? 'busy' : chat.updatedAt;
  useEffect(() => {
    if (!busy) void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chat.id, done]);

  return (
    <div className="chat-code">
      <div className="chat-code-bar">
        <span className="muted">Незакоммиченные изменения проекта{busy ? ' · агент работает, обновится после ответа' : ''}</span>
        <span className="grow" />
        {at && <span className="code-at">в {time(at)}</span>}
        <Button tone="quiet" icon={<RefreshCw size={14} />} busy={loading} onClick={() => void load()}>
          Обновить
        </Button>
      </div>
      {error ? (
        <Empty icon={<CircleAlert />} title="Не удалось получить дифф">
          {error}
        </Empty>
      ) : !diff ? (
        <div className="center">
          <span className="spinner big" />
        </div>
      ) : !diff.length ? (
        <Empty icon={<FileCode2 />} title="Изменений нет">
          Рабочая копия совпадает с последним коммитом. Попросите агента что-нибудь поправить — изменения появятся здесь.
        </Empty>
      ) : (
        <DiffReview
          files={diff}
          viewedKey={`chat:${chat.id}`}
          visualItems={[]}
          comments={[]}
          onComments={() => {}}
          readOnly
          tab="code"
          onTab={() => {}}
        />
      )}
    </div>
  );
}
