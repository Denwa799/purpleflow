import { useEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { CircleAlert, FileCode2, RefreshCw } from 'lucide-react';
import type { DiffFile, LineComment, ReviewItem, RunFile } from '@purpleflow/core';
import { DiffReview } from '../../components/diff/DiffReview';
import { Button, Empty } from '../../components/ui';
import { bridge, cleanErr } from '../../lib/api';

/** Один массив на все отрисовки: иначе карточки в редакторе пересоздавались бы на каждом обновлении прогона. */
const NO_COMMENTS: LineComment[] = [];

/** Изменённые файлы прогона для счётчика на вкладке: пока прогон идёт — раз в несколько секунд, иначе на смене стадии. */
export function useChangedFiles(run: RunFile | undefined): string[] | null {
  const [files, setFiles] = useState<string[] | null>(null);
  const id = run?.id;
  const live = run?.status === 'running';
  useEffect(() => {
    if (!id) return;
    let alive = true;
    const load = () =>
      bridge.core
        .getChangedFiles(id)
        .then((f) => alive && setFiles(f))
        .catch(() => {});
    void load();
    const timer = live ? setInterval(load, 8000) : undefined;
    return () => {
      alive = false;
      if (timer) clearInterval(timer);
    };
  }, [id, live, run?.next, run?.attempts.length]);
  return files;
}

const time = (d: Date) => d.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit', second: '2-digit' });

/** Приёмка ждёт решения: замечания к строкам, выбор замечаний ревью, сводка «Что изменилось». */
export interface AcceptProps {
  picked: ReviewItem[];
  onPicked: (items: ReviewItem[]) => void;
  comments: LineComment[];
  onComments: (c: LineComment[]) => void;
  summary?: string | null;
  banner?: ReactNode;
}

/**
 * Вкладка «Код»: дифф прогона в любой момент. На приёмке — сама приёмка (замечания, выбор, сводка),
 * в остальное время — только просмотр. Дифф перезагружается на смене стадии; посреди работы агента —
 * подсказка «Есть новые изменения», чтобы не сбивать просмотр.
 */
export function CodePane({
  run,
  changed,
  accept,
  tools,
  tab,
  onTab,
}: {
  run: RunFile;
  changed: string[] | null;
  accept?: AcceptProps;
  tools: HTMLElement | null;
  /** «Код» и «Замечания» — две вкладки прогона над одним диффом: клик по замечанию ведёт к строке в коде. */
  tab: 'code' | 'notes';
  onTab: (t: 'code' | 'notes') => void;
}) {
  const [diff, setDiff] = useState<DiffFile[] | null>(null);
  const [at, setAt] = useState<Date | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  /** Номер последнего запроса: медленный старый дифф не должен заменить свежий. */
  const loadSeq = useRef(0);
  const load = async () => {
    const seq = ++loadSeq.current;
    setBusy(true);
    setError(null);
    try {
      const next = await bridge.core.getDiff(run.id);
      if (seq !== loadSeq.current) return;
      setDiff(next);
      setAt(new Date());
    } catch (e) {
      if (seq === loadSeq.current) setError(cleanErr(e));
    } finally {
      if (seq === loadSeq.current) setBusy(false);
    }
  };
  useEffect(() => {
    setDiff(null);
  }, [run.id]);
  // Стадия сменилась (реализация закончилась, пришли на приёмку) — код уже другой, перезагружаем сами.
  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [run.id, run.next, run.attempts.length]);

  // Набор файлов изменился с последней загрузки — подсказываем обновить, а не перезагружаем под рукой.
  const loaded = diff
    ?.map((f) => f.path)
    .sort()
    .join('\n');
  const now = changed ? [...changed].sort().join('\n') : loaded;
  const stale = Boolean(diff && changed && loaded !== now);
  const live = run.status === 'running';
  const lastReview = run.reviews.at(-1);
  const lastVisual = run.visuals?.at(-1);

  // «Обновить» — в строке вкладок прогона, а не отдельной полосой над диффом.
  const bar = (
    <>
      {live && <span className="code-live">Агент работает — дифф может меняться</span>}
      {stale && <span className="code-stale">Есть новые изменения</span>}
      <span className="grow" />
      {at && <span className="code-at">обновлено в {time(at)}</span>}
      <Button
        tone={stale ? 'primary' : 'quiet'}
        className="code-refresh"
        icon={<RefreshCw size={14} />}
        busy={busy}
        aria-label="Обновить"
        title={at ? `Обновить · обновлено в ${time(at)}` : 'Обновить'}
        onClick={() => void load()}
      >
        Обновить
      </Button>
    </>
  );

  return (
    <div className="pane pane-code">
      {tools && createPortal(bar, tools)}
      {error ? (
        <Empty icon={<CircleAlert />} title="Не удалось получить дифф">
          {error}
        </Empty>
      ) : !diff ? (
        <div className="center">
          <span className="spinner big" />
        </div>
      ) : !diff.length && tab === 'code' ? (
        <Empty icon={<FileCode2 />} title="Изменений пока нет">
          Агент ещё не менял файлы — загляните, когда пойдёт реализация.
        </Empty>
      ) : (
        <>
          {accept?.banner}
          <DiffReview
            files={diff}
            viewedKey={run.id}
            review={lastReview}
            blockingTitle={run.mode === 'review' ? 'Важные' : undefined}
            groups={run.taskMap?.groups}
            visualItems={lastVisual ? [...lastVisual.blocking, ...lastVisual.notes] : []}
            visualPassed={lastVisual?.passed}
            history={run.reviews.slice(0, -1)}
            tab={tab}
            onTab={onTab}
            {...(accept
              ? {
                  comments: accept.comments,
                  onComments: accept.onComments,
                  picked: accept.picked,
                  onPicked: accept.onPicked,
                  summary: accept.summary,
                }
              : { comments: NO_COMMENTS, onComments: () => {}, readOnly: true })}
          />
        </>
      )}
    </div>
  );
}
