// Вкладка «Обзор»: ветка, origin, готовность к PR, скиллы и MCP; вкладка «Статистика» — цифры, прогоны и чаты.
import type { ProjectKnowledge, ProjectOverview, ProjectStats, ChatSkill } from '@purpleflow/core';
import { GitBranch, GitPullRequest, MessageSquare, Plus, TriangleAlert } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Button } from '../../components/ui';
import { shortPath, tokens, when } from '../../lib/format';
import { MODES, stageTitle } from '../../lib/stages';
import { useStore, type ProjectTab } from '../../lib/store';
import { CmdChips, InitRepoButton, type LoadedProject, plural } from './common';
import { useSkills } from '../../components/SkillList';
import { McpPanel } from '../../components/McpManager';
import { SkillGroups, SkillSearchDialog } from '../../components/SkillManager';
import { bridge, cleanErr } from '../../lib/api';

export function Overview({ p, onTab, onReload }: { p: LoadedProject; onTab: (t: ProjectTab) => void; onReload: () => void }) {
  const { go } = useStore();
  const [o, setO] = useState<ProjectOverview | null>(null);
  const [k, setK] = useState<ProjectKnowledge | null>(null);
  const [forgetting, setForgetting] = useState(false);
  const [forgetError, setForgetError] = useState<string | null>(null);
  const repo = p.info.path;
  useEffect(() => {
    if (!p.info.isRepo) return;
    void bridge.core
      .projectOverview(repo)
      .then(setO)
      .catch(() => {});
    void bridge.core
      .getKnowledge(repo)
      .then(setK)
      .catch(() => {});
  }, [repo, p.info.isRepo]);
  const sections = (k?.profile?.match(/^##\s/gm) ?? []).length;

  if (!p.info.isRepo) {
    return (
      <section className="panel knowledge-empty-card">
        <span className="browser-empty-icon">
          <TriangleAlert size={22} />
        </span>
        <strong>
          {p.info.repoRoot ? 'Папка внутри другого репозитория' : p.info.empty ? 'В репозитории нет коммитов' : 'Это не git-репозиторий'}
        </strong>
        <p>
          {p.info.repoRoot ? (
            <>
              Папка лежит в репозитории <code>{p.info.repoRoot}</code> — задачи ушли бы в него. Выполните в папке <code>git init</code> или
              откройте корень репозитория.
            </>
          ) : (
            <>
              Прогоны работают в отдельных ветках — нужен репозиторий с первым коммитом. Создадим его: ветка main, .gitignore и коммит того,
              что есть в папке.
            </>
          )}
        </p>
        <InitRepoButton
          dir={repo}
          tone={p.info.repoRoot ? 'ghost' : 'primary'}
          label={p.info.repoRoot ? 'Сделать отдельным репозиторием' : p.info.empty ? 'Сделать первый коммит' : 'Создать репозиторий'}
          onDone={onReload}
        />
      </section>
    );
  }

  return (
    <>
      <div className="overview-grid">
        <section className="panel overview-card">
          <h3>Репозиторий</h3>
          <dl className="facts">
            <dt>Папка</dt>
            <dd>
              <span className="mono">{shortPath(repo)}</span>
              <button className="link" onClick={() => void bridge.openPath(repo)}>
                Открыть
              </button>
            </dd>
            <dt>Ветка</dt>
            <dd>
              {o ? (
                <>
                  <GitBranch size={13} /> <span className="mono">{o.branch ?? '—'}</span>
                  <span className="muted">{o.dirty ? ` · изменённых файлов: ${o.dirty}` : ' · без изменений'}</span>
                </>
              ) : (
                <span className="muted">…</span>
              )}
            </dd>
            <dt>origin</dt>
            <dd>
              {o ? (
                o.remote ? (
                  <span className="mono">{o.remote.replace(/^https?:\/\/|\.git$/g, '').replace(/^git@([^:]+):/, '$1/')}</span>
                ) : (
                  <span className="muted">не задан</span>
                )
              ) : (
                <span className="muted">…</span>
              )}
            </dd>
            <dt>Pull Request</dt>
            <dd>
              {o ? (
                o.prReady ? (
                  <span className="muted">{o.prReady}</span>
                ) : (
                  <>
                    <GitPullRequest size={13} className="ok" /> можно создавать MR/PR
                  </>
                )
              ) : (
                <span className="muted">…</span>
              )}
            </dd>
          </dl>
        </section>

        <section className="panel overview-card">
          <h3>Настройка</h3>
          <button className="overview-row" onClick={() => onTab('commands')}>
            <span className="overview-row-head">
              <strong>Команды и окружение</strong>
              {!p.cfg && <span className="tag is-wait">не сохранены</span>}
            </span>
            <span className="overview-chips">
              <CmdChips cmds={p.cmds} />
            </span>
          </button>
          <button className="overview-row" onClick={() => onTab('knowledge')}>
            <span className="overview-row-head">
              <strong>Знания о проекте</strong>
            </span>
            <span className="muted">
              {!k
                ? '…'
                : k.profile
                  ? `Профиль: ${sections || 1} ${plural(sections || 1, 'раздел', 'раздела', 'разделов')}, собран ${k.profileAt ? when(k.profileAt) : ''} · уроков: ${k.lessons?.length ?? 0}`
                  : 'Профиль ещё не собран — соберётся перед первым планом'}
            </span>
          </button>
        </section>
      </div>

      <SkillsPanel repo={repo} />

      <McpPanel repo={repo} />

      {p.cfg && (
        <div className="overview-forget">
          {forgetting ? (
            <>
              <span className={forgetError ? 'actionbar-error' : 'muted'}>
                {forgetError ?? 'Команды и знания проекта удалятся, прогоны останутся.'}
              </span>
              <Button tone="quiet" onClick={() => setForgetting(false)}>
                Отмена
              </Button>
              <Button
                tone="danger"
                onClick={() =>
                  void bridge.core
                    .forgetProject(repo)
                    .then(() => go({ name: 'projects' }))
                    .catch((e) => setForgetError(cleanErr(e)))
                }
              >
                Удалить настройки
              </Button>
            </>
          ) : (
            <Button tone="quiet" onClick={() => setForgetting(true)}>
              Удалить настройки проекта…
            </Button>
          )}
        </div>
      )}
    </>
  );
}
// ——— Скиллы ———
function SkillsPanel({ repo }: { repo: string }) {
  const loaded = useSkills(repo);
  // После установки или удаления — свежий список из ответа ядра, без повторной загрузки.
  const [fresh, setFresh] = useState<{ repo: string; skills: ChatSkill[] } | null>(null);
  const skills = fresh?.repo === repo ? fresh.skills : loaded;
  const [adding, setAdding] = useState(false);
  const update = (s: ChatSkill[]) => setFresh({ repo, skills: s });
  const { state, go } = useStore();
  const userConfig = state.settings?.userConfig ?? true;
  const own = skills?.filter((s) => s.source === 'project').length ?? 0;
  return (
    <section className="panel overview-skills">
      <header className="overview-runs-head">
        <h3>Скиллы и команды</h3>
        <span className="muted">{skills?.length || ''}</span>
        <span className="grow" />
        <Button tone="ghost" icon={<Plus size={14} />} onClick={() => setAdding(true)}>
          Добавить скиллы
        </Button>
      </header>
      <p className="muted skill-intro">
        Агенты подключают их сами, когда задача подходит под описание; в чате любой можно вызвать через «/».
        {skills && !own && ' Свои скиллы проекта кладите в .claude/skills/<имя>/SKILL.md и коммитьте — их увидят все агенты прогона.'}
      </p>
      {!userConfig && (
        <p className="muted skill-intro">
          Ваши скиллы из ~/.claude, ~/.codex и плагины агенты сейчас не видят: выключено «Подключать мои настройки».{' '}
          <button className="link" onClick={() => go({ name: 'settings' })}>
            Настройки
          </button>
        </p>
      )}
      {!skills ? (
        <p className="muted">…</p>
      ) : skills.length ? (
        <SkillGroups skills={skills} projectPath={repo} onChange={update} />
      ) : (
        <p className="muted">Скиллов пока нет — добавьте из каталога.</p>
      )}
      {adding && skills && (
        <SkillSearchDialog projectPath={repo} installed={skills} onClose={() => setAdding(false)} onInstalled={update} />
      )}
    </section>
  );
}

// ——— Статистика ———
function ms(n: number | null): string {
  if (n == null) return '—';
  const m = Math.round(n / 60_000);
  if (m < 1) return '< 1 мин';
  if (m < 60) return `${m} мин`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h} ч${m % 60 ? ` ${m % 60} мин` : ''}`;
  return `${Math.floor(h / 24)} д${h % 24 ? ` ${h % 24} ч` : ''}`;
}
const pct = (a: number, b: number) => (b ? Math.round((a / b) * 100) : 0);
/** Вкладка «Статистика» проекта: пересчитывается, когда меняются прогоны. */
export function ProjectStats({ repo, multiRoot }: { repo: string; multiRoot?: string }) {
  const { state, go } = useStore();
  const runs = state.runs.filter((r) => r.projectPath === repo);
  // Чат проекта из нескольких репозиториев открывают на верхней папке — он тоже этого проекта.
  const chats = state.chats.filter((c) => c.projectPath === repo || (multiRoot && c.projectPath === multiRoot));
  const runsKey = runs.map((r) => r.status + r.updatedAt).join();
  return (
    <>
      <StatsPanel repo={repo} runsKey={runsKey} />

      <section className="panel overview-runs">
        <header className="overview-runs-head">
          <h3>Прогоны</h3>
          <span className="muted">{runs.length || ''}</span>
        </header>
        {runs.length ? (
          <ul className="run-list">
            {runs.slice(0, 12).map((r) => (
              <li key={r.id}>
                <button className={`side-run st-${r.status}`} onClick={() => go({ name: 'run', runId: r.id })}>
                  <span className="side-dot" />
                  <span className="side-run-title">{r.title}</span>
                  <span className="run-list-mode">{MODES.find((m) => m.id === (r.mode ?? 'task'))?.title}</span>
                  <time className="muted">{when(r.createdAt)}</time>
                </button>
              </li>
            ))}
          </ul>
        ) : (
          <p className="muted">Прогонов в этом проекте ещё не было.</p>
        )}
      </section>

      {chats.length > 0 && (
        <section className="panel overview-runs overview-chats">
          <header className="overview-runs-head">
            <h3>Чаты</h3>
            <span className="muted">{chats.length}</span>
          </header>
          <ul className="run-list">
            {chats.slice(0, 8).map((c) => (
              <li key={c.id}>
                <button className="side-run" onClick={() => go({ name: 'chat', chatId: c.id })}>
                  <MessageSquare size={14} className="muted" />
                  <span className="side-run-title">{c.title}</span>
                  <span className="run-list-mode">{c.agent}</span>
                  <time className="muted">{when(c.updatedAt)}</time>
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}
    </>
  );
}

function StatsPanel({ repo, runsKey }: { repo: string; runsKey: string }) {
  const [s, setS] = useState<ProjectStats | null>(null);
  useEffect(() => {
    void bridge.core
      .projectStats(repo)
      .then(setS)
      .catch(() => setS(null));
  }, [repo, runsKey]);
  if (!s || s.total === 0) return null;

  const peak = Math.max(1, ...s.daily.map((d) => d.started));
  const returns = [
    { label: 'План вернули на доработку', n: s.returns.plan },
    { label: 'Замечания на приёмке', n: s.returns.acceptance },
    { label: 'Красные линтер или тесты', n: s.returns.tests },
    { label: 'Ревью нашло проблемы', n: s.returns.review },
    { label: 'Визуальная проверка нашла проблемы', n: s.returns.visual },
  ];
  const maxRet = Math.max(1, ...returns.map((r) => r.n));
  const time = s.agentMs + s.waitMs;
  const fmtDay = (d: string) => new Date(d).toLocaleDateString('ru-RU', { day: 'numeric', month: 'short' });

  return (
    <section className="panel stats">
      <header className="overview-runs-head">
        <h3>Статистика</h3>
      </header>
      <div className="kpis">
        <div className="kpi">
          <span className="kpi-label">Прогонов</span>
          <strong>{s.total}</strong>
          <span className="kpi-sub">
            готово {s.finished}
            {s.active ? ` · идут ${s.active}` : ''}
            {s.stopped ? ` · остановлено ${s.stopped}` : ''}
            {s.cancelled ? ` · отменено ${s.cancelled}` : ''}
          </span>
        </div>
        <div className="kpi">
          <span className="kpi-label">Приняты с первого раза</span>
          <strong>{s.finished ? `${pct(s.firstPass, s.finished)}%` : '—'}</strong>
          <span className="kpi-sub">
            {s.finished ? `${s.firstPass} из ${s.finished} без возврата плана и результата` : 'пока нет готовых'}
          </span>
        </div>
        <div className="kpi">
          <span className="kpi-label">До готового коммита</span>
          <strong>{ms(s.medianLeadMs)}</strong>
          <span className="kpi-sub">медиана, вместе с ожиданием решений</span>
        </div>
        <div className="kpi">
          <span className="kpi-label">Попыток реализации</span>
          <strong>{s.avgImplAttempts == null ? '—' : s.avgImplAttempts.toFixed(1).replace('.', ',')}</strong>
          <span className="kpi-sub">в среднем на готовую задачу</span>
        </div>
      </div>

      <div className="activity">
        <div className="activity-head">
          <span className="kpi-label">Активность за 4 недели</span>
          <span className="activity-legend">
            <i className="is-started" />
            начато <i className="is-done" />
            готово
          </span>
        </div>
        <div className="activity-bars">
          {s.daily.map((d) => (
            <span key={d.day} className="activity-day" title={`${fmtDay(d.day)}: начато ${d.started}, готово ${d.finished}`}>
              <i className="is-started" style={{ height: `${(d.started / peak) * 100}%` }} />
              <i className="is-done" style={{ height: `${(Math.min(d.finished, peak) / peak) * 100}%` }} />
            </span>
          ))}
        </div>
        <div className="activity-axis">
          <span>{fmtDay(s.daily[0].day)}</span>
          <span>сегодня</span>
        </div>
      </div>

      <div className="stats-cols">
        <div className="stats-block">
          <span className="kpi-label">Возвраты</span>
          <ul className="hbars">
            {returns.map((r) => (
              <li key={r.label} className={r.n ? '' : 'is-zero'}>
                <span>{r.label}</span>
                <b>{r.n}</b>
                <i style={{ width: `${(r.n / maxRet) * 100}%` }} />
              </li>
            ))}
          </ul>
          {s.stops.length > 0 && (
            <p className="stats-note">
              Останавливались на: {s.stops.map((x) => `${stageTitle({ mode: 'task', visual: true }, x.stage)} — ${x.count}`).join(', ')}
            </p>
          )}
        </div>
        <div className="stats-block">
          <span className="kpi-label">Куда уходит время</span>
          {time > 0 ? (
            <>
              <div className="time-split">
                <i className="is-agent" style={{ width: `${pct(s.agentMs, time)}%` }} />
                <i className="is-wait" style={{ width: `${100 - pct(s.agentMs, time)}%` }} />
              </div>
              <div className="time-split-legend">
                <span>
                  <i className="is-agent" />
                  Агенты работают · {ms(s.agentMs)}
                </span>
                <span>
                  <i className="is-wait" />
                  Ждут вашего решения · {ms(s.waitMs)}
                </span>
              </div>
            </>
          ) : (
            <p className="stats-note">Нет данных</p>
          )}
          <span className="kpi-label stats-sub-head">По режимам</span>
          <div className="mode-stats">
            {s.byMode.map((m) => (
              <span key={m.mode} className="tag">
                {MODES.find((x) => x.id === m.mode)?.title ?? m.mode} · {m.total}
                {m.finished !== m.total ? ` (готово ${m.finished})` : ''}
              </span>
            ))}
          </div>
          <p className="stats-note">
            Токенов: {tokens(s.tokens)}
            {s.prs ? ` · PR: ${s.prs}` : ''}
            {s.merged ? ` · влито из приложения: ${s.merged}` : ''}
          </p>
        </div>
      </div>
    </section>
  );
}
