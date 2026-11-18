// Вкладка «Команды и окружение»: команды проекта, где работать по умолчанию, файлы окружения, проверка окружения.
import type { CommandIssue, EnvCheck, ForgeDetectionInfo, ForgeRef, RelatedRepo, Workspace } from '@purpleflow/core';
import {
  Check,
  DatabaseZap,
  FileLock2,
  FolderGit2,
  FolderSearch,
  GitBranch,
  GitPullRequest,
  Globe,
  KeyRound,
  MonitorPlay,
  PackageOpen,
  Plus,
  ScanSearch,
  Sparkles,
  Stethoscope,
  TestTubeDiagonal,
  TriangleAlert,
  X,
  Zap,
} from 'lucide-react';
import { useEffect, useState, type ReactNode } from 'react';
import { Button, Input, TextArea } from '../../components/ui';
import { shortPath } from '../../lib/format';
import { type Cmd, type Cmds, type LoadedProject, RepoChecklist, WORKSPACES, saveLoaded } from './common';
import { bridge, cleanErr } from '../../lib/api';

// ——— Команды и окружение ———
export function CommandsPanel({ p, onSaved, onDirty }: { p: LoadedProject; onSaved: () => void; onDirty: (d: boolean) => void }) {
  const repo = p.info.path;
  const [cmds, setCmds] = useState<Cmds>(p.cmds);
  const [notes, setNotes] = useState<Cmds>(p.notes);
  const [workspace, setWorkspace] = useState<Workspace>(p.workspace);
  const [visualNotes, setVisualNotes] = useState(p.visualNotes);
  const [quickTest, setQuickTest] = useState(p.quickTest ?? '');
  const [prepare, setPrepare] = useState(p.prepare ?? '');
  const [envFiles, setEnvFiles] = useState(p.envFiles.join(', '));
  const [related, setRelated] = useState<RelatedRepo[]>(p.related ?? []);
  // Проект из нескольких репозиториев: участники (без основного) и все репозитории верхней папки для галочек.
  const [members, setMembers] = useState<string[]>(p.multi?.repos ?? []);
  const [nested, setNested] = useState<string[] | null>(null);
  const root = p.multi?.root;
  const mainRel = root ? repo.slice(root.replace(/[\\/]+$/, '').length + 1).replace(/\\/g, '/') : '';
  useEffect(() => {
    if (!root) return;
    void bridge.core
      .detectProject(root)
      .then((d) => setNested(d.nested ?? []))
      .catch(() => setNested([]));
  }, [root]);
  const [forge, setForge] = useState<ForgeRef | null>(p.forge ?? null);
  const [forgeTouched, setForgeTouched] = useState(false);
  const [saved, setSavedState] = useState<'saved' | 'draft' | 'dirty'>(p.cfg ? 'saved' : 'draft');
  const [issues, setIssues] = useState<Record<string, CommandIssue[]>>({});
  const [aiBusy, setAiBusy] = useState(false);
  const [aiDone, setAiDone] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const setSaved = (s: 'saved' | 'draft' | 'dirty') => {
    setSavedState(s);
    onDirty(s === 'dirty');
  };
  const touch = () => saved === 'saved' && setSaved('dirty');

  useEffect(() => {
    const t = setTimeout(() => {
      void bridge.core
        // Команды проекта из нескольких репозиториев запускаются из верхней папки — и проверяются от неё.
        .checkCommands(root ?? repo, { setup: cmds.setup, lint: cmds.lint, test: cmds.test, run: cmds.run })
        .then(setIssues)
        .catch(() => setIssues({}));
    }, 350);
    return () => clearTimeout(t);
  }, [repo, root, cmds.setup, cmds.lint, cmds.test, cmds.run]);

  const edit = (k: Cmd, v: string) => {
    setCmds({ ...cmds, [k]: v });
    setNotes({ ...notes, [k]: v ? 'указано вручную' : '' });
    setSaved('dirty');
  };

  const detectAI = async () => {
    setAiBusy(true);
    setError(null);
    try {
      const r = await bridge.core.detectCommandsAI(repo);
      setCmds({ setup: r.setupCommand, lint: r.lintCommand, test: r.testCommand, run: r.runCommand, url: r.appUrl });
      if (r.visualNotes) setVisualNotes(r.visualNotes);
      setNotes({ setup: r.notes.setup, lint: r.notes.lint, test: r.notes.test, run: r.notes.run, url: '' });
      setAiDone(true);
      setSaved('dirty');
    } catch (e) {
      setError(cleanErr(e));
    } finally {
      setAiBusy(false);
    }
  };

  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      await saveLoaded({
        path: repo,
        cmds,
        notes,
        workspace,
        visualNotes,
        quickTest,
        prepare,
        related,
        // Сняли все галочки — проект снова из одного репозитория.
        ...(root ? { multi: members.length ? { root, repos: members } : null } : {}),
        forge: forgeTouched ? (forge && forge.host.trim() ? forge : null) : undefined,
        envFiles: envFiles
          .split(/[,\n]/)
          .map((f) => f.trim())
          .filter(Boolean),
      });
      setForgeTouched(false);
      setSaved('saved');
      onSaved();
    } catch (e) {
      setError(cleanErr(e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <section className="panel commands">
      <header className="panel-head">
        <div>
          <h2>Команды проекта</h2>
          <p>
            Подставляются в каждую задачу. Подготовка — один раз перед планом, линтер и тесты — после каждой реализации. Пустое поле — шаг
            пропускается.
          </p>
        </div>
        <Button tone={aiDone ? 'ghost' : 'primary'} icon={<Sparkles size={15} />} busy={aiBusy} onClick={() => void detectAI()}>
          {aiBusy ? 'Нейросеть изучает проект…' : aiDone ? 'Найти заново' : 'Найти нейросетью'}
        </Button>
      </header>
      <div className="cmd-list">
        <CmdRow
          icon={<PackageOpen size={17} />}
          title="Подготовка"
          hint="Установка зависимостей"
          placeholder="не нужна"
          value={cmds.setup}
          note={notes.setup}
          onChange={(v) => edit('setup', v)}
          loading={aiBusy}
          issues={issues.setup}
        />
        <CmdRow
          icon={<ScanSearch size={17} />}
          title="Линтер"
          hint="Линтер и проверка типов"
          placeholder="не задан"
          value={cmds.lint}
          note={notes.lint}
          onChange={(v) => edit('lint', v)}
          loading={aiBusy}
          issues={issues.lint}
        />
        <CmdRow
          icon={<TestTubeDiagonal size={17} />}
          title="Тесты"
          hint="Все тесты, без watch-режима"
          placeholder="не заданы"
          value={cmds.test}
          note={notes.test}
          onChange={(v) => edit('test', v)}
          loading={aiBusy}
          issues={issues.test}
        />
        <CmdRow
          icon={<Zap size={17} />}
          title="Быстрые тесты"
          hint="Необязательно. На каждом круге — они, полный набор — один раз перед приёмкой"
          placeholder="например: npm run test:unit (пусто — всегда полный набор)"
          value={quickTest}
          note=""
          onChange={(v) => {
            setQuickTest(v);
            setSaved('dirty');
          }}
          loading={false}
        />
        <CmdRow
          icon={<DatabaseZap size={17} />}
          title="Подготовка к запуску"
          hint="Необязательно. Перед каждым запуском приложения: миграции, сиды"
          placeholder="например: cd apps/api && npx prisma migrate deploy"
          value={prepare}
          note=""
          onChange={(v) => {
            setPrepare(v);
            setSaved('dirty');
          }}
          loading={false}
        />
        <CmdRow
          icon={<MonitorPlay size={17} />}
          title="Запуск приложения"
          hint="Для визуальной проверки; {port} — свободный порт"
          placeholder="например: npm run dev -- --port {port}"
          value={cmds.run}
          note={notes.run}
          onChange={(v) => edit('run', v)}
          loading={aiBusy}
          issues={issues.run}
        />
        <CmdRow
          icon={<Globe size={17} />}
          title="Адрес"
          hint="Главная страница приложения"
          placeholder="http://localhost:{port}"
          value={cmds.url}
          note={notes.url}
          onChange={(v) => edit('url', v)}
          loading={aiBusy}
        />
        <div className="cmd-row">
          <span className="cmd-icon">
            <GitBranch size={17} />
          </span>
          <div className="cmd-label">
            <strong>Где работать</strong>
            <span>По умолчанию для новых задач, можно сменить в задаче</span>
          </div>
          <div className="cmd-field">
            <div className="segmented small" role="radiogroup">
              {WORKSPACES.map((w) => (
                <button
                  key={w.id}
                  role="radio"
                  aria-checked={workspace === w.id}
                  className={workspace === w.id ? 'is-on' : ''}
                  disabled={Boolean(root && members.length && w.id === 'branch')}
                  title={
                    root && members.length && w.id === 'branch'
                      ? 'В проекте из нескольких репозиториев — только отдельные копии'
                      : undefined
                  }
                  onClick={() => {
                    setWorkspace(w.id);
                    touch();
                  }}
                >
                  {w.title}
                </button>
              ))}
            </div>
            <span className="cmd-note">{WORKSPACES.find((w) => w.id === workspace)!.hint}</span>
          </div>
        </div>
        <div className="cmd-row">
          <span className="cmd-icon">
            <FileLock2 size={17} />
          </span>
          <div className="cmd-label">
            <strong>Файлы окружения</strong>
            <span>Копируются в отдельную копию прогона, не коммитятся</span>
          </div>
          <div className="cmd-field">
            <Input
              mono
              placeholder="например: apps/api/.env, apps/web/.env.local"
              value={envFiles}
              onChange={(e) => {
                setEnvFiles(e.target.value);
                touch();
              }}
            />
            <span className="cmd-note">
              {p.info.envFiles.length
                ? `Найдены в проекте: ${p.info.envFiles.join(', ')}`
                : 'В git их нет, поэтому в worktree без копирования их не будет. В режиме «Ветка» не нужны.'}
            </span>
          </div>
        </div>
        {root && (
          <div className="cmd-row">
            <span className="cmd-icon">
              <FolderGit2 size={17} />
            </span>
            <div className="cmd-label">
              <strong>Репозитории проекта</strong>
              <span>Агент работает во всех отмеченных: правки, проверки и ревью — по всем, коммит и слияние — в каждом</span>
            </div>
            <div className="cmd-field">
              <RepoChecklist
                repos={nested ?? [mainRel, ...members]}
                on={members}
                main={mainRel}
                onToggle={(rel) => {
                  setMembers(members.includes(rel) ? members.filter((r) => r !== rel) : [...members, rel]);
                  touch();
                }}
              />
              <span className="cmd-note">
                Папка проекта <code>{shortPath(root)}</code>. Команды выше запускаются из неё. Неотмеченные репозитории агент только читает.
                {members.length ? '' : ' Без отмеченных проект станет обычным, из одного репозитория.'}
              </span>
            </div>
          </div>
        )}
        <div className="cmd-row">
          <span className="cmd-icon">
            <FolderSearch size={17} />
          </span>
          <div className="cmd-label">
            <strong>Соседние репозитории</strong>
            <span>Необязательно. Агенты читают их для контекста — API, общие типы, — но не меняют</span>
          </div>
          <div className="cmd-field">
            {related.map((r, i) => (
              <div className="related-row" key={r.path}>
                <span className="related-path mono" title={r.path}>
                  {shortPath(r.path)}
                </span>
                <Input
                  placeholder="что это: бэкенд API, общие типы…"
                  value={r.note ?? ''}
                  onChange={(e) => {
                    setRelated(related.map((x, j) => (j === i ? { ...x, note: e.target.value } : x)));
                    touch();
                  }}
                />
                <Button
                  tone="quiet"
                  icon={<X size={14} />}
                  title="Убрать"
                  aria-label="Убрать"
                  onClick={() => {
                    setRelated(related.filter((_, j) => j !== i));
                    touch();
                  }}
                />
              </div>
            ))}
            <div>
              <Button
                tone="quiet"
                icon={<Plus size={14} />}
                onClick={async () => {
                  const dir = await bridge.pickFolder('Соседний репозиторий — агенты будут его читать');
                  if (!dir || dir === repo || related.some((r) => r.path === dir)) return;
                  setRelated([...related, { path: dir }]);
                  touch();
                }}
              >
                Добавить папку
              </Button>
            </div>
            <span className="cmd-note">
              Работа и PR — только в этом проекте. Если исполнитель всё же изменит соседа, прогон покажет предупреждение.
            </span>
          </div>
        </div>
        <ForgeRow
          repo={repo}
          forge={forge}
          onChange={(f) => {
            setForge(f);
            setForgeTouched(true);
            touch();
          }}
        />
        <div className={`cmd-row ${aiBusy ? 'is-loading' : ''}`}>
          <span className="cmd-icon">
            <KeyRound size={17} />
          </span>
          <div className="cmd-label">
            <strong>Инструкция для проверки</strong>
            <span>Тестовый вход, сид данных — для визуальной проверки</span>
          </div>
          <div className="cmd-field">
            <TextArea
              rows={3}
              placeholder={'например: вход test@example.com / test1234 (создаётся npm run seed в apps/api), доска — /board'}
              value={visualNotes}
              onChange={(e) => {
                setVisualNotes(e.target.value);
                touch();
              }}
            />
            <span className="cmd-note">Только тестовые учётки — текст хранится в данных приложения и передаётся агенту как есть.</span>
          </div>
        </div>
        <EnvCheckRow repo={repo} canRun={Boolean(cmds.run.trim() && cmds.url.trim())} dirty={saved !== 'saved'} />
      </div>
      <div className="cmd-actions">
        {error ? (
          <p className="inline-error">{error}</p>
        ) : (
          <p className="cmd-foot">Нейросеть только читает файлы проекта — package.json, конфиги, CI — и ничего не меняет.</p>
        )}
        <span className="grow" />
        {saved === 'saved' ? (
          <span className="cmd-saved">
            <Check size={14} /> Сохранено для проекта
          </span>
        ) : (
          <Button tone="primary" busy={saving} onClick={() => void save()}>
            Сохранить для проекта
          </Button>
        )}
      </div>
    </section>
  );
}
/** Провайдер Pull / Merge Request: «Авто» — по origin для github.com и gitlab.com, self-hosted GitLab подтверждается явно. */
function ForgeRow({ repo, forge, onChange }: { repo: string; forge: ForgeRef | null; onChange: (f: ForgeRef | null) => void }) {
  const [det, setDet] = useState<ForgeDetectionInfo | null>(null);
  useEffect(() => {
    let off = false;
    void bridge.core
      .detectForge(repo)
      .then((d) => !off && setDet(d))
      .catch(() => !off && setDet(null));
    return () => {
      off = true;
    };
  }, [repo]);
  const mode = forge?.kind ?? 'auto';
  const sugg = det?.suggested ?? null;
  const pending = !forge && sugg && !det?.confirmed;
  const modes: { id: 'auto' | 'github' | 'gitlab'; title: string }[] = [
    { id: 'auto', title: 'Авто' },
    { id: 'github', title: 'GitHub' },
    { id: 'gitlab', title: 'GitLab' },
  ];
  const pick = (id: 'auto' | 'github' | 'gitlab') => {
    if (id === 'auto') onChange(null);
    else if (id === 'github') onChange({ kind: 'github', host: 'github.com' });
    else onChange({ kind: 'gitlab', host: forge?.kind === 'gitlab' ? forge.host : sugg?.kind === 'gitlab' ? sugg.host : 'gitlab.com' });
  };
  return (
    <div className="cmd-row">
      <span className="cmd-icon">
        <GitPullRequest size={17} />
      </span>
      <div className="cmd-label">
        <strong>Pull / Merge Request</strong>
        <span>Где создавать PR или MR. Для каждого проекта свой хост — можно работать с несколькими GitLab сразу</span>
      </div>
      <div className="cmd-field">
        <div className="segmented small" role="radiogroup">
          {modes.map((m) => (
            <button
              key={m.id}
              role="radio"
              aria-checked={mode === m.id}
              className={mode === m.id ? 'is-on' : ''}
              onClick={() => pick(m.id)}
            >
              {m.title}
            </button>
          ))}
        </div>
        {forge?.kind === 'gitlab' && (
          <Input
            mono
            placeholder="gitlab.company.ru"
            value={forge.host}
            onChange={(e) => onChange({ kind: 'gitlab', host: e.target.value })}
          />
        )}
        {pending && sugg && (
          <span className="cmd-note">
            Адрес origin — {det?.host}. Похоже на {sugg.kind === 'gitlab' ? 'GitLab' : 'GitHub'}, но для своего сервера хост нужно
            подтвердить.{' '}
            <button className="link" onClick={() => onChange(sugg)}>
              Подтвердить {sugg.host}
            </button>
          </span>
        )}
        {!forge && !sugg && det?.host && (
          <span className="cmd-note">Хост {det.host} не распознан — выберите GitHub или GitLab. Влить локально можно и без этого.</span>
        )}
        {!forge && det?.confirmed && sugg && (
          <span className="cmd-note">
            Определено по origin: {sugg.kind === 'gitlab' ? 'GitLab' : 'GitHub'}, {sugg.host}.
          </span>
        )}
        {forge?.kind === 'gitlab' && (
          <span className="cmd-note">
            Войдите в GitLab CLI один раз: <code>glab auth login --hostname {forge.host.trim() || 'хост'}</code>. Сертификаты — из
            системного хранилища (или <code>NODE_EXTRA_CA_CERTS</code>).
          </span>
        )}
        {forge?.kind === 'github' && (
          <span className="cmd-note">
            Войдите в GitHub CLI: <code>gh auth login</code>.
          </span>
        )}
      </div>
    </div>
  );
}
/** Проверка окружения: приложение поднимается, вход и разделы из инструкции работают — до того, как запускать задачи. */
function EnvCheckRow({ repo, canRun, dirty }: { repo: string; canRun: boolean; dirty: boolean }) {
  const [busy, setBusy] = useState(false);
  const [res, setRes] = useState<EnvCheck | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [showOut, setShowOut] = useState(false);
  const run = async () => {
    setBusy(true);
    setErr(null);
    setRes(null);
    try {
      setRes(await bridge.core.checkEnvironment(repo));
    } catch (e) {
      setErr(cleanErr(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="cmd-row env-check">
      <span className="cmd-icon">
        <Stethoscope size={17} />
      </span>
      <div className="cmd-label">
        <strong>Проверка окружения</strong>
        <span>Поднимает приложение командой запуска и пробует вход и разделы из инструкции — 2–5 минут</span>
      </div>
      <div className="cmd-field">
        <div className="env-check-actions">
          <Button tone="ghost" busy={busy} disabled={!canRun || dirty} onClick={() => void run()}>
            {busy ? 'Проверяю…' : 'Проверить окружение'}
          </Button>
          <span className="cmd-note">
            {!canRun
              ? 'Нужны команда запуска и адрес.'
              : dirty
                ? 'Сначала сохраните команды.'
                : 'Код и данные не меняются, генерации не запускаются.'}
          </span>
        </div>
        {err && <p className="inline-error">{err}</p>}
        {res && (
          <div className={`env-result ${res.ready ? 'is-ok' : 'is-bad'}`}>
            <strong>{res.ready ? 'Окружение готово к визуальной проверке' : 'Окружение не готово'}</strong>
            <ul>
              {res.steps.map((s, i) => (
                <li key={i} className={s.ok ? 'is-ok' : 'is-bad'}>
                  {s.ok ? <Check size={13} /> : <X size={13} />}
                  <span>
                    <b>{s.title}</b>
                    {s.detail ? ` — ${s.detail}` : ''}
                  </span>
                </li>
              ))}
            </ul>
            {res.fix && <p className="env-fix">{res.fix}</p>}
            {res.serverOutput && (
              <>
                <button className="link" onClick={() => setShowOut(!showOut)}>
                  {showOut ? 'Скрыть вывод сервера' : 'Вывод сервера'}
                </button>
                {showOut && <pre className="output env-out">{res.serverOutput.replace(/\x1b\[[0-9;]*m/g, '').slice(-6000)}</pre>}
              </>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
function CmdRow({
  icon,
  title,
  hint,
  placeholder,
  value,
  note,
  onChange,
  loading,
  issues,
}: {
  icon: ReactNode;
  title: string;
  hint: string;
  placeholder: string;
  value: string;
  note: string;
  onChange: (v: string) => void;
  loading: boolean;
  issues?: CommandIssue[];
}) {
  return (
    <div className={`cmd-row ${loading ? 'is-loading' : ''}`}>
      <span className="cmd-icon">{icon}</span>
      <div className="cmd-label">
        <strong>{title}</strong>
        <span>{hint}</span>
      </div>
      <div className="cmd-field">
        <Input mono placeholder={placeholder} value={value} onChange={(e) => onChange(e.target.value)} />
        {issues?.length
          ? issues.map((x, i) => (
              <span key={i} className="cmd-issue">
                <TriangleAlert size={13} /> {x.message}
                {x.fix && (
                  <button className="link" onClick={() => onChange(x.fix!)}>
                    Исправить
                  </button>
                )}
              </span>
            ))
          : note && (
              <span className="cmd-note" title={note}>
                {note}
              </span>
            )}
      </div>
    </div>
  );
}
