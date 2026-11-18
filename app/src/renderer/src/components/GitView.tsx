// Вкладка «Git» (только просмотр): ветки, история всех веток с графом и дифф коммита. В репозитории ничего не меняет.
import { useEffect, useMemo, useRef, useState } from 'react';
import { ArrowLeft, ChevronDown, ChevronRight, CircleAlert, GitBranch, GitCommitHorizontal, RefreshCw, Workflow } from 'lucide-react';
import type { DiffFile, GitBranchInfo, GitCommitInfo, GitGraph } from '@purpleflow/core';
import { layoutGraph, type GraphRow } from '../lib/gitGraph';
import { DiffReview } from './diff/DiffReview';
import { Button, Empty } from './ui';
import { bridge, cleanErr } from '../lib/api';
import { when } from '../lib/format';
import { useStore } from '../lib/store';

const PAGE = 400;
const ROW = 30;
const LANE = 14;
const COLORS = ['#8a74ee', '#74c4a0', '#e0a458', '#6fb3e0', '#df7e8d', '#c39ae8', '#9fcf6a', '#e6c86e'];
const laneColor = (i: number) => COLORS[i % COLORS.length];
const x = (lane: number) => 9 + lane * LANE;

/** refresh — меняется, когда репозиторий мог измениться (закончился ход агента). */
/** focus — ветка, коммит которой подсветить сразу (ветка прогона). */
export function GitView({ projectPath, refresh, focus }: { projectPath: string; refresh?: string; focus?: string }) {
  const [graph, setGraph] = useState<GitGraph | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [limit, setLimit] = useState(PAGE);
  const [branchesOpen, setBranchesOpen] = useState(false);
  const [picked, setPicked] = useState<GitCommitInfo | null>(null);
  const [mark, setMark] = useState<string | null>(null);
  const list = useRef<HTMLDivElement>(null);
  const load = async (n = limit) => {
    setLoading(true);
    setError(null);
    try {
      setGraph(await Promise.resolve().then(() => bridge.core.getGitGraph(projectPath, n)));
    } catch (e) {
      setError(cleanErr(e));
    } finally {
      setLoading(false);
    }
  };
  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectPath, refresh]);
  // Ветка прогона — сразу подсвечена и видна.
  useEffect(() => {
    const b = focus && graph?.branches.find((x) => x.name === focus);
    if (!b) return;
    setMark(b.hash);
    requestAnimationFrame(() => list.current?.querySelector(`[data-hash="${b.hash}"]`)?.scrollIntoView({ block: 'center' }));
  }, [focus, graph]);
  const rows = useMemo(() => (graph ? layoutGraph(graph.commits) : []), [graph]);
  const lanes = Math.min(12, Math.max(1, ...rows.map((r) => r.width)));

  // Клик по ветке — к её коммиту в истории.
  const showBranch = (b: GitBranchInfo) => {
    setMark(b.hash);
    setBranchesOpen(false);
    requestAnimationFrame(() => list.current?.querySelector(`[data-hash="${b.hash}"]`)?.scrollIntoView({ block: 'center' }));
  };

  if (picked) return <CommitView projectPath={projectPath} c={picked} onBack={() => setPicked(null)} />;

  return (
    <div className="git-view">
      <div className="git-bar">
        {graph && (
          <button className="git-branches-toggle" aria-expanded={branchesOpen} onClick={() => setBranchesOpen(!branchesOpen)}>
            {branchesOpen ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
            <GitBranch size={14} />
            <span className="mono">{graph.current ?? `HEAD ${graph.head.slice(0, 7)}`}</span>
            <span className="muted">· веток: {graph.branches.length}</span>
          </button>
        )}
        <span className="grow" />
        <Button tone="quiet" icon={<RefreshCw size={14} />} busy={loading} onClick={() => void load()}>
          Обновить
        </Button>
      </div>
      {error ? (
        <Empty icon={<CircleAlert />} title="Не удалось прочитать git">
          {error}
        </Empty>
      ) : !graph ? (
        <div className="center">
          <span className="spinner big" />
        </div>
      ) : (
        <>
          {branchesOpen && <BranchList graph={graph} onPick={showBranch} />}
          {!graph.commits.length ? (
            <Empty icon={<GitCommitHorizontal />} title="Коммитов пока нет">
              История появится после первого коммита.
            </Empty>
          ) : (
            <div className="git-log" ref={list} role="list" aria-label="История коммитов">
              {graph.commits.map((c, i) => (
                <button
                  key={c.hash}
                  role="listitem"
                  data-hash={c.hash}
                  className={`git-row ${mark === c.hash ? 'is-marked' : ''} ${c.hash === graph.head ? 'is-head' : ''}`}
                  onClick={() => setPicked(c)}
                  title={`${c.hash.slice(0, 7)} · ${c.author} · ${when(c.at)}`}
                >
                  <GraphCell row={rows[i]} lanes={lanes} />
                  <span className="git-subject">
                    {c.refs.map((r) => (
                      <span
                        key={r}
                        className={`git-ref ${r.startsWith('tag: ') ? 'is-tag' : r.includes('/') && r.startsWith('origin/') ? 'is-remote' : ''} ${r === graph.current ? 'is-current' : ''}`}
                      >
                        {r.replace(/^tag: /, '')}
                      </span>
                    ))}
                    <span className="git-msg">{c.subject}</span>
                  </span>
                  <span className="git-meta muted">
                    {c.author} · {when(c.at)}
                  </span>
                  <span className="git-hash mono muted">{c.hash.slice(0, 7)}</span>
                </button>
              ))}
              {graph.more && (
                <button
                  className="git-more"
                  onClick={() => {
                    setLimit(limit + PAGE);
                    void load(limit + PAGE);
                  }}
                >
                  Показать ещё
                </button>
              )}
            </div>
          )}
        </>
      )}
    </div>
  );
}

function GraphCell({ row, lanes }: { row: GraphRow; lanes: number }) {
  const w = x(lanes - 1) + 9;
  const mid = ROW / 2;
  const seg = (x1: number, y1: number, x2: number, y2: number) =>
    x1 === x2 ? `M${x1} ${y1}V${y2}` : `M${x1} ${y1}C${x1} ${(y1 + y2) / 2} ${x2} ${(y1 + y2) / 2} ${x2} ${y2}`;
  const clip = (l: number) => Math.min(l, lanes - 1);
  return (
    <svg className="git-graph" width={w} height={ROW} aria-hidden>
      {row.top.map((s, i) => (
        <path key={`t${i}`} d={seg(x(clip(s.from)), 0, x(clip(s.to)), mid)} stroke={laneColor(s.color)} />
      ))}
      {row.bottom.map((s, i) => (
        <path key={`b${i}`} d={seg(x(clip(s.from)), mid, x(clip(s.to)), ROW)} stroke={laneColor(s.color)} />
      ))}
      <circle cx={x(clip(row.col))} cy={mid} r={4} fill={laneColor(row.color)} />
    </svg>
  );
}

function BranchList({ graph, onPick }: { graph: GitGraph; onPick: (b: GitBranchInfo) => void }) {
  const { go } = useStore();
  return (
    <div className="git-branches" role="list" aria-label="Ветки">
      {graph.branches.map((b) => (
        <div key={b.name} role="listitem" className={`git-branch ${b.name === graph.current ? 'is-current' : ''}`}>
          <button className="git-branch-main" onClick={() => onPick(b)} title="Показать в истории">
            <GitBranch size={13} />
            <span className={`mono ${b.remote ? 'muted' : ''}`}>{b.name}</span>
            {b.name === graph.current && <span className="git-chip">открыта</span>}
            {b.name === graph.base && b.name !== graph.current && <span className="git-chip">основная</span>}
          </button>
          {b.run && (
            <button className="git-branch-run" title="Открыть прогон" onClick={() => go({ name: 'run', runId: b.run!.id })}>
              <Workflow size={12} />
              <span>{b.run.title}</span>
            </button>
          )}
          <span className="grow" />
          {(b.ahead != null || b.behind != null) && (
            <span className="git-ab muted" title={`Относительно ${graph.base}: впереди на ${b.ahead}, позади на ${b.behind}`}>
              ↑{b.ahead} ↓{b.behind}
            </span>
          )}
          <span className="muted git-branch-at">{b.at ? when(b.at) : ''}</span>
        </div>
      ))}
    </div>
  );
}

function CommitView({ projectPath, c, onBack }: { projectPath: string; c: GitCommitInfo; onBack: () => void }) {
  const [diff, setDiff] = useState<DiffFile[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    Promise.resolve()
      .then(() => bridge.core.getGitCommitDiff(projectPath, c.hash))
      .then((d) => alive && setDiff(d))
      .catch((e) => alive && setError(cleanErr(e)));
    return () => {
      alive = false;
    };
  }, [projectPath, c.hash]);
  return (
    <div className="git-view">
      <div className="git-bar">
        <Button tone="quiet" icon={<ArrowLeft size={14} />} onClick={onBack}>
          История
        </Button>
        <span className="git-commit-title" title={c.subject}>
          {c.subject}
        </span>
      </div>
      <p className="git-commit-meta muted">
        <span className="mono">{c.hash.slice(0, 10)}</span> · {c.author} · {when(c.at)}
        {c.parents.length > 1 ? ' · слияние: изменения относительно основной линии' : ''}
      </p>
      {error ? (
        <Empty icon={<CircleAlert />} title="Не удалось получить дифф">
          {error}
        </Empty>
      ) : !diff ? (
        <div className="center">
          <span className="spinner big" />
        </div>
      ) : !diff.length ? (
        <Empty icon={<GitCommitHorizontal />} title="Файлы не менялись">
          Пустой коммит или слияние без изменений относительно основной линии.
        </Empty>
      ) : (
        <div className="git-diff">
          <DiffReview
            files={diff}
            viewedKey={`git:${c.hash}`}
            visualItems={[]}
            comments={[]}
            onComments={() => {}}
            readOnly
            tab="code"
            onTab={() => {}}
          />
        </div>
      )}
    </div>
  );
}
