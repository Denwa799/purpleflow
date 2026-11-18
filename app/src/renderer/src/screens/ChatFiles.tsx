// Вкладка «Файлы» чата: дерево файлов проекта. Клик по файлу — его содержимое; «+» или перетаскивание в поле ввода — «@путь».
import { useEffect, useMemo, useState, type DragEvent } from 'react';
import { ArrowLeft, ChevronDown, ChevronRight, CircleAlert, File, Folder, FolderTree, Plus, RefreshCw, Search } from 'lucide-react';
import Editor from '@monaco-editor/react';
import '../components/diff/monaco';
import { langOfContent } from '../lib/lang';
import { buildTree, type TreeNode } from '../lib/fileTree';
import { PATH_DRAG, rankFiles } from '../lib/mentions';
import { Button, Empty } from '../components/ui';
import { bridge, cleanErr } from '../lib/api';

const drag = (path: string) => (e: DragEvent) => {
  e.dataTransfer.setData(PATH_DRAG, path);
  e.dataTransfer.setData('text/plain', `@${path}`);
  e.dataTransfer.effectAllowed = 'copy';
};

export function ChatFiles({
  projectPath,
  refresh,
  onMention,
}: {
  projectPath: string;
  refresh: string;
  onMention: (path: string) => void;
}) {
  const [files, setFiles] = useState<string[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState<Set<string>>(() => new Set());
  const [viewing, setViewing] = useState<string | null>(null);
  const load = async () => {
    setLoading(true);
    setError(null);
    try {
      setFiles(await Promise.resolve().then(() => bridge.core.listChatFiles(projectPath)));
    } catch (e) {
      setError(cleanErr(e));
    } finally {
      setLoading(false);
    }
  };
  // Ход агента закончился — файлы могли появиться или пропасть.
  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectPath, refresh]);
  const tree = useMemo(() => (files ? buildTree(files) : []), [files]);
  const found = useMemo(() => (files && query.trim() ? rankFiles(files, query.trim(), 200) : null), [files, query]);
  const toggle = (p: string) =>
    setOpen((s) => {
      const n = new Set(s);
      if (n.has(p)) n.delete(p);
      else n.add(p);
      return n;
    });

  const row = (n: TreeNode, depth: number) => {
    const dir = Boolean(n.children);
    const isOpen = open.has(n.path);
    return (
      <div key={n.path} role="treeitem" aria-expanded={dir ? isOpen : undefined} aria-label={n.name}>
        <div
          className={`chat-tree-row ${dir ? 'is-dir' : ''}`}
          style={{ paddingLeft: 8 + depth * 14 }}
          draggable
          onDragStart={drag(n.path)}
          title={n.path}
        >
          <button type="button" className="chat-tree-open" onClick={() => (dir ? toggle(n.path) : setViewing(n.path))}>
            {dir ? isOpen ? <ChevronDown size={13} /> : <ChevronRight size={13} /> : <span className="chat-tree-pad" />}
            {dir ? <Folder size={14} /> : <File size={14} />}
            <span>{n.name}</span>
          </button>
          <AddButton path={n.path} onMention={onMention} />
        </div>
        {dir && isOpen && <div role="group">{n.children!.map((c) => row(c, depth + 1))}</div>}
      </div>
    );
  };

  if (viewing) return <FileView projectPath={projectPath} path={viewing} onBack={() => setViewing(null)} onMention={onMention} />;

  return (
    <div className="chat-code chat-files-pane">
      <div className="chat-code-bar">
        <label className="chat-tree-search">
          <Search size={13} />
          <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Найти файл" aria-label="Найти файл" />
        </label>
        <Button tone="quiet" icon={<RefreshCw size={14} />} busy={loading} onClick={() => void load()}>
          Обновить
        </Button>
      </div>
      {error ? (
        <Empty icon={<CircleAlert />} title="Не удалось получить файлы">
          {error}
        </Empty>
      ) : !files ? (
        <div className="center">
          <span className="spinner big" />
        </div>
      ) : !files.length ? (
        <Empty icon={<FolderTree />} title="Файлов нет">
          В папке проекта пока пусто.
        </Empty>
      ) : found ? (
        <div className="chat-tree" role="list" aria-label="Найденные файлы">
          {found.map((f) => (
            <div key={f} role="listitem" aria-label={f} className="chat-tree-row" draggable onDragStart={drag(f)} title={f}>
              <button type="button" className="chat-tree-open" onClick={() => setViewing(f)}>
                <File size={14} />
                <span>{f}</span>
              </button>
              <AddButton path={f} onMention={onMention} />
            </div>
          ))}
          {!found.length && <p className="muted chat-tree-hint">Ничего не нашлось</p>}
        </div>
      ) : (
        <div className="chat-tree" role="tree" aria-label="Файлы проекта">
          {tree.map((n) => row(n, 0))}
        </div>
      )}
    </div>
  );
}

function AddButton({ path, onMention }: { path: string; onMention: (path: string) => void }) {
  return (
    <button
      type="button"
      className="chat-tree-add"
      aria-label={`Добавить в контекст: ${path}`}
      title="Добавить в контекст"
      onClick={() => onMention(path)}
    >
      <Plus size={13} />
    </button>
  );
}

type Content = Awaited<ReturnType<typeof bridge.core.readChatFile>>;

/** Содержимое файла только для чтения, с подсветкой по расширению. */
function FileView({
  projectPath,
  path,
  onBack,
  onMention,
}: {
  projectPath: string;
  path: string;
  onBack: () => void;
  onMention: (path: string) => void;
}) {
  const [content, setContent] = useState<Content | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    setContent(null);
    setError(null);
    // Через Promise: если метода нет (окно старше ядра), ошибка — в панели, а не падение окна.
    Promise.resolve()
      .then(() => bridge.core.readChatFile(projectPath, path))
      .then((c) => alive && setContent(c))
      .catch((e) => alive && setError(cleanErr(e)));
    return () => {
      alive = false;
    };
  }, [projectPath, path]);
  return (
    <div className="chat-code chat-files-pane">
      <div className="chat-code-bar">
        <Button tone="quiet" icon={<ArrowLeft size={14} />} onClick={onBack}>
          Файлы
        </Button>
        <code className="chat-file-path" title={path}>
          {path}
        </code>
        <Button tone="quiet" icon={<Plus size={14} />} onClick={() => onMention(path)}>
          В контекст
        </Button>
      </div>
      {error ? (
        <Empty icon={<CircleAlert />} title="Не удалось открыть файл">
          {error}
        </Empty>
      ) : !content ? (
        <div className="center">
          <span className="spinner big" />
        </div>
      ) : content.media ? (
        <MediaView path={path} media={content.media} size={content.size} />
      ) : content.binary ? (
        <Empty icon={<File />} title="Двоичный файл">
          Содержимое не показывается — агент всё равно может открыть его по пути.
        </Empty>
      ) : (
        <>
          {content.truncated && <p className="muted chat-tree-hint">Показаны первые 512 КБ из {Math.round(content.size / 1024)} КБ.</p>}
          <div className="chat-file-view">
            <Editor
              value={content.text}
              language={langOfContent(path, content.text)}
              theme="purpleflow-night"
              options={{
                readOnly: true,
                domReadOnly: true,
                minimap: { enabled: false },
                fontFamily: "'Geist Mono Variable', ui-monospace, Menlo, monospace",
                fontSize: 12.5,
                lineHeight: 21,
                scrollBeyondLastLine: false,
                overviewRulerLanes: 0,
                padding: { top: 12, bottom: 12 },
                automaticLayout: true,
                wordWrap: 'on',
                // Обрезанный файл: незакрытые скобки в конце не красим как ошибку.
                bracketPairColorization: { enabled: !content.truncated },
              }}
            />
          </div>
        </>
      )}
    </div>
  );
}

/** Картинка или видео из проекта: байты из ядра — через blob-URL, без чтения файлов окном. */
function MediaView({ path, media, size }: { path: string; media: NonNullable<Content['media']>; size: number }) {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    if (!media.data) return;
    const u = URL.createObjectURL(new Blob([media.data as BlobPart], { type: media.mime }));
    setUrl(u);
    return () => URL.revokeObjectURL(u);
  }, [media]);
  if (media.tooBig)
    return (
      <Empty icon={<File />} title="Файл слишком большой для просмотра">
        {Math.round(size / 1024 / 1024)} МБ — агент всё равно может открыть его по пути.
      </Empty>
    );
  if (!url)
    return (
      <div className="center">
        <span className="spinner big" />
      </div>
    );
  return (
    <div className="chat-media-view">
      {media.mime.startsWith('video/') ? <video src={url} controls aria-label={path} /> : <img src={url} alt={path} />}
    </div>
  );
}
