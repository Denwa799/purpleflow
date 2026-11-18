// Перед влитием: целевая ветка ушла вперёд, будут ли конфликты, какие ещё прогоны правят те же файлы.
import type { MergeCheck, RunFile } from '@purpleflow/core';
import { GitBranch, TriangleAlert } from 'lucide-react';
import { useEffect, useState } from 'react';
import { bridge } from '../../lib/api';
import { useStore } from '../../lib/store';

/** Проверка один раз на смену цели и на новый коммит прогона — без фонового опроса. */
export function useMergeCheck(run: RunFile | null | undefined, target: string | undefined, enabled: boolean): MergeCheck | null {
  const [check, setCheck] = useState<MergeCheck | null>(null);
  useEffect(() => {
    let alive = true;
    if (!run || !enabled || run.merged || run.status === 'cancelled') {
      setCheck(null);
      return;
    }
    void bridge.core
      .mergeCheck(run.id, target || undefined)
      .then((x) => alive && setCheck(x))
      .catch(() => alive && setCheck(null));
    return () => {
      alive = false;
    };
    // Прогон приходит новым объектом на каждое обновление: перепроверяем только когда меняется то, что влияет на ответ.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, run?.id, target, run?.commit, run?.merged, run?.status, run?.next]);
  return check;
}

const plural = (n: number, one: string, few: string, many: string) => {
  const m10 = n % 10;
  const m100 = n % 100;
  return m10 === 1 && m100 !== 11 ? one : m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14) ? few : many;
};

/** Строка предупреждения; ничего — если цель не ушла вперёд и пересечений нет. */
export function MergeCheckNote({ check, compact }: { check: MergeCheck | null; compact?: boolean }) {
  const { go } = useStore();
  if (!check || (!check.behind && !check.overlaps.length)) return null;
  const bad = check.exact && check.conflicts.length > 0;
  const warn = bad || check.conflicts.length > 0 || check.overlaps.length > 0;
  const files = (list: string[]) => (
    <span className="mono" title={list.join('\n')}>
      {list.slice(0, 3).join(', ')}
      {list.length > 3 ? ` и ещё ${list.length - 3}` : ''}
    </span>
  );
  return (
    <div className={`merge-check ${bad ? 'is-bad' : warn ? 'is-warn' : ''}`}>
      {warn ? <TriangleAlert size={13} /> : <GitBranch size={13} />}
      {check.behind > 0 && (
        <span>
          {check.target} ушла вперёд на {check.behind} {plural(check.behind, 'коммит', 'коммита', 'коммитов')}
          {check.conflicts.length ? (
            <>
              {' '}
              · {check.exact ? 'конфликт при слиянии' : 'те же файлы менялись и там'}: {files(check.conflicts)}
            </>
          ) : check.exact ? (
            ' · конфликтов не будет'
          ) : compact ? (
            ''
          ) : (
            ' · пересечений по файлам нет'
          )}
        </span>
      )}
      {check.overlaps.map((o) => (
        <span key={o.runId}>
          · те же файлы правит{' '}
          <button className="link" onClick={() => go({ name: 'run', runId: o.runId })} title={o.files.join('\n')}>
            «{o.title}»
          </button>
          : {files(o.files)}
        </span>
      ))}
    </div>
  );
}
