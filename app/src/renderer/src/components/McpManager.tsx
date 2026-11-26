// MCP-серверы проекта: по агентам, как скиллы, — удаление, копирование другому агенту и установка из реестра MCP.
import { Check, ChevronRight, Copy, LoaderCircle, Plus, Search, Trash2, X } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { AgentKind, McpEntry, McpHit, McpInstall, McpScope } from '@purpleflow/core';
import { bridge, cleanErr } from '../lib/api';
import { useStore } from '../lib/store';
import { useDialogClose } from '../lib/useDialogClose';
import { Select } from './Dropdown';
import { PillTabs } from './PillTabs';
import { Button } from './ui';

const SCOPE_TITLE: Record<McpScope, string> = { project: 'Проект', user: 'Ваши — для всех проектов' };
/** У codex и agy MCP-серверы только глобальные. */
const GLOBAL_ONLY: AgentKind[] = ['codex', 'agy'];

/** Панель «MCP-серверы» экрана проекта. */
export function McpPanel({ repo }: { repo: string }) {
  const [servers, setServers] = useState<McpEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  useEffect(() => {
    let live = true;
    setServers(null);
    bridge.core
      .listMcp(repo)
      .then((s) => live && setServers(s))
      .catch((e) => live && (setServers([]), setError(cleanErr(e))));
    return () => {
      live = false;
    };
  }, [repo]);
  return (
    <section className="panel overview-skills overview-mcp">
      <header className="overview-runs-head">
        <h3>MCP-серверы</h3>
        <span className="muted">{servers?.length || ''}</span>
        <span className="grow" />
        <Button tone="ghost" icon={<Plus size={14} />} onClick={() => setAdding(true)}>
          Добавить MCP
        </Button>
      </header>
      <p className="muted skill-intro">Инструменты, которые агенты подключают при запуске: Figma, базы данных, трекеры задач.</p>
      {error && <p className="inline-error">{error}</p>}
      {!servers ? (
        <p className="muted">…</p>
      ) : servers.length ? (
        <McpGroups servers={servers} projectPath={repo} onChange={setServers} />
      ) : (
        <p className="muted">MCP-серверов пока нет — добавьте из реестра.</p>
      )}
      {adding && <McpSearchDialog projectPath={repo} onClose={() => setAdding(false)} onInstalled={setServers} />}
    </section>
  );
}

function McpGroups({ servers, projectPath, onChange }: { servers: McpEntry[]; projectPath: string; onChange: (s: McpEntry[]) => void }) {
  const { state } = useStore();
  const enabled = state.settings?.enabledAgents ?? ['claude', 'codex'];
  const groups = enabled.map((agent) => ({ agent, items: servers.filter((s) => s.agent === agent) })).filter((g) => g.items.length);
  const [tab, setTab] = useState<AgentKind | null>(groups[0]?.agent ?? null);
  const current = groups.find((g) => g.agent === tab) ?? groups[0];
  const [open, setOpen] = useState<Record<McpScope, boolean>>({ project: true, user: !servers.some((s) => s.scope === 'project') });
  const [error, setError] = useState<string | null>(null);
  const act = async (fn: () => Promise<McpEntry[]>) => {
    setError(null);
    try {
      onChange(await fn());
    } catch (e) {
      setError(cleanErr(e));
    }
  };
  if (!current) return null;
  return (
    <div className="skill-groups">
      {groups.length > 1 && (
        <PillTabs<AgentKind>
          className="tabs skill-tabs"
          value={current.agent}
          onChange={setTab}
          items={groups.map((g) => ({ id: g.agent, label: g.agent, extra: <span className="tab-badge">{g.items.length}</span> }))}
        />
      )}
      {error && <p className="inline-error">{error}</p>}
      <div className="skill-sources tab-enter" key={current.agent}>
        {(['project', 'user'] as const).map((scope) => {
          const items = current.items.filter((s) => s.scope === scope);
          if (!items.length) return null;
          return (
            <section key={scope} className={`skill-source ${open[scope] ? 'is-open' : ''}`}>
              <h4 className="skill-source-head">
                <button type="button" aria-expanded={open[scope]} onClick={() => setOpen((o) => ({ ...o, [scope]: !o[scope] }))}>
                  <ChevronRight size={14} className="skill-source-chevron" />
                  {SCOPE_TITLE[scope]} <span className="muted">{items.length}</span>
                </button>
              </h4>
              {open[scope] && (
                <ul className="skill-list">
                  {items.map((s) => (
                    <McpRow
                      key={`${s.scope}:${s.name}:${s.local ? 'l' : ''}`}
                      s={s}
                      copyTo={enabled.filter((a) => a !== s.agent && !servers.some((x) => x.agent === a && x.name === s.name))}
                      onCopy={(to) => act(() => bridge.core.copyMcp({ projectPath, agent: s.agent, name: s.name, scope: s.scope, to }))}
                      onRemove={() =>
                        act(() => bridge.core.removeMcp({ projectPath, agent: s.agent, name: s.name, scope: s.scope, local: s.local }))
                      }
                    />
                  ))}
                </ul>
              )}
            </section>
          );
        })}
      </div>
    </div>
  );
}

function McpRow({
  s,
  copyTo,
  onCopy,
  onRemove,
}: {
  s: McpEntry;
  copyTo: AgentKind[];
  onCopy: (to: AgentKind) => Promise<void>;
  onRemove: () => Promise<void>;
}) {
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState<'copy' | 'remove' | null>(null);
  const [picking, setPicking] = useState(false);
  const timer = useRef(0);
  useEffect(() => () => window.clearTimeout(timer.current), []);
  const run = async (kind: 'copy' | 'remove', fn: () => Promise<void>) => {
    setBusy(kind);
    await fn();
    setBusy(null);
    setPicking(false);
    setConfirm(false);
  };
  const keys = [...s.env, ...s.headers];
  return (
    <li title={s.command ?? s.url}>
      <div className="skill-head">
        <code className="skill-name">{s.name}</code>
        <span className="tag">{s.transport === 'stdio' ? 'локальный' : s.transport}</span>
        {s.local && (
          <span className="tag" title="Записан в ~/.claude.json для этого проекта: другие участники его не увидят">
            только у вас
          </span>
        )}
        {s.disabled && <span className="tag">выключен</span>}
        <span className="grow" />
        {copyTo.length > 0 &&
          (picking ? (
            <span className="skill-copy-to" role="group" aria-label={`Скопировать ${s.name}`}>
              {copyTo.map((a) => (
                <button
                  key={a}
                  type="button"
                  className="skill-del is-copy"
                  disabled={busy !== null}
                  onClick={() => void run('copy', () => onCopy(a))}
                >
                  <Copy size={13} /> в {a}
                </button>
              ))}
              <button type="button" className="skill-del" aria-label="Отмена" onClick={() => setPicking(false)}>
                <X size={13} />
              </button>
            </span>
          ) : (
            <button
              type="button"
              className="skill-del"
              aria-label={`Скопировать ${s.name} другому агенту`}
              title="Скопировать другому агенту (вместе с ключами)"
              disabled={busy !== null}
              onClick={() => setPicking(true)}
            >
              {busy === 'copy' ? <LoaderCircle size={14} className="spin" /> : <Copy size={14} />}
            </button>
          ))}
        {confirm ? (
          <button type="button" className="skill-del is-confirm" disabled={busy !== null} onClick={() => void run('remove', onRemove)}>
            {busy === 'remove' ? <LoaderCircle size={13} className="spin" /> : <Trash2 size={13} />}
            {s.scope === 'user' ? `Удалить у ${s.agent} во всех проектах?` : 'Удалить из проекта?'}
          </button>
        ) : (
          <button
            type="button"
            className="skill-del"
            aria-label={`Удалить ${s.name}`}
            title="Удалить"
            onClick={() => {
              setConfirm(true);
              window.clearTimeout(timer.current);
              timer.current = window.setTimeout(() => setConfirm(false), 4000);
            }}
          >
            <Trash2 size={14} />
          </button>
        )}
      </div>
      <p className="skill-desc mcp-target">
        <code>{s.url ?? s.command}</code>
        {keys.length > 0 && <span className="muted"> · {keys.join(', ')}</span>}
      </p>
    </li>
  );
}

/** Окно «Добавить MCP»: поиск в реестре, выбор варианта, ключи и для каких агентов. */
function McpSearchDialog({
  projectPath,
  onClose: closeNow,
  onInstalled,
}: {
  projectPath: string;
  onClose: () => void;
  onInstalled: (s: McpEntry[]) => void;
}) {
  const { closing, close } = useDialogClose(closeNow);
  const { state } = useStore();
  const enabled = state.settings?.enabledAgents ?? ['claude', 'codex'];
  const [query, setQuery] = useState('');
  const [hits, setHits] = useState<McpHit[] | null>(null);
  const [searching, setSearching] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [agents, setAgents] = useState<AgentKind[]>(enabled);
  const [scope, setScope] = useState<McpScope>('project');
  const [openId, setOpenId] = useState<string | null>(null);
  const [done, setDone] = useState<string[]>([]);
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => {
    input.current?.focus();
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && close();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [close]);

  useEffect(() => {
    const q = query.trim();
    if (q.length < 2) return setHits(null);
    let live = true;
    setSearching(true);
    const t = window.setTimeout(() => {
      bridge.core
        .searchMcp(q)
        .then((r) => live && (setHits(r), setError(null)))
        .catch((e) => live && setError(cleanErr(e)))
        .finally(() => live && setSearching(false));
    }, 300);
    return () => {
      live = false;
      window.clearTimeout(t);
    };
  }, [query]);

  const toggle = (a: AgentKind) => setAgents((l) => (l.includes(a) ? l.filter((x) => x !== a) : [...l, a]));
  const globalOnly = agents.filter((a) => GLOBAL_ONLY.includes(a));

  return createPortal(
    <div className={`qs-scrim ${closing ? 'is-closing' : ''}`} onMouseDown={(e) => e.target === e.currentTarget && close()}>
      <div className="qs skill-search" role="dialog" aria-modal aria-labelledby="mcp-search-title">
        <header className="qs-head">
          <div>
            <h2 id="mcp-search-title">Добавить MCP</h2>
            <p>Официальный реестр MCP. Сервер записывается в настройки выбранных агентов их же командами.</p>
          </div>
          <button className="qs-close" aria-label="Закрыть" onClick={() => close()}>
            <X size={16} />
          </button>
        </header>
        <div className="skill-search-bar">
          <Search size={15} />
          <input
            ref={input}
            value={query}
            placeholder="Например: figma, postgres, linear"
            aria-label="Поиск MCP"
            onChange={(e) => setQuery(e.target.value)}
          />
          {searching && <LoaderCircle size={15} className="spin" />}
        </div>
        <div className="skill-search-opts">
          <span className="skill-search-agents" role="group" aria-label="Для агентов">
            <span className="muted">Для агентов</span>
            {enabled.map((a) => (
              <button
                key={a}
                type="button"
                className={`skill-agent-chip ${agents.includes(a) ? 'is-on' : ''}`}
                aria-pressed={agents.includes(a)}
                onClick={() => toggle(a)}
              >
                {agents.includes(a) && <Check size={12} />}
                {a}
              </button>
            ))}
          </span>
          <Select<McpScope>
            ariaLabel="Куда ставить"
            value={scope}
            minWidth={260}
            onChange={setScope}
            options={[
              { value: 'project', label: 'В этот проект', hint: 'claude — в .mcp.json, opencode — в opencode.json проекта' },
              { value: 'user', label: 'Для всех проектов', hint: 'В ваши настройки агентов' },
            ]}
          />
        </div>
        {scope === 'project' && globalOnly.length > 0 && (
          <p className="muted mcp-note">{globalOnly.join(' и ')}: MCP только для всех проектов — запишется туда.</p>
        )}
        {error && <p className="inline-error skill-search-error">{error}</p>}
        <ul className="skill-search-list" aria-label="Найденные MCP-серверы">
          {hits?.map((h) =>
            done.includes(h.id) ? (
              <li key={h.id}>
                <div className="skill-search-text">
                  <code className="skill-name">{h.name}</code>
                </div>
                <span className="skill-search-done">
                  <Check size={14} /> Добавлен
                </span>
              </li>
            ) : (
              <McpHitRow
                key={h.id}
                h={h}
                open={openId === h.id}
                onOpen={() => setOpenId(openId === h.id ? null : h.id)}
                disabled={!agents.length}
                onInstall={async (install, values, name) => {
                  const r = await bridge.core.installMcp({ projectPath, scope, agents, name, install, values });
                  onInstalled(r.servers);
                  if (r.failed.length < agents.length) setDone((d) => [...d, h.id]);
                  if (r.failed.length) throw new Error(r.failed.map((f) => `${f.agent}: ${f.error}`).join('\n'));
                }}
              />
            ),
          )}
          {hits && !hits.length && <li className="muted skill-search-empty">Ничего не нашлось — попробуйте другие слова.</li>}
          {!hits && <li className="muted skill-search-empty">Введите сервис или технологию: figma, github, postgres.</li>}
        </ul>
        <footer className="qs-foot">
          <span className="grow" />
          <Button tone="primary" onClick={() => close()}>
            Готово
          </Button>
        </footer>
      </div>
    </div>,
    document.body,
  );
}

/** Найденный сервер: по «Добавить» раскрывается выбор варианта и поля ключей. */
function McpHitRow({
  h,
  open,
  onOpen,
  disabled,
  onInstall,
}: {
  h: McpHit;
  open: boolean;
  onOpen: () => void;
  disabled: boolean;
  onInstall: (install: McpInstall, values: Record<string, string>, name: string) => Promise<void>;
}) {
  const [kind, setKind] = useState(h.installs[0].kind);
  const install = h.installs.find((i) => i.kind === kind) ?? h.installs[0];
  const [values, setValues] = useState<Record<string, string>>({});
  const [name, setName] = useState(h.name);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const missing = install.inputs.some((i) => i.required && !(values[i.key] ?? i.default ?? '').trim());
  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      const filled = Object.fromEntries(install.inputs.map((i) => [i.key, values[i.key] ?? i.default ?? '']));
      await onInstall(install, filled, name.trim());
    } catch (e) {
      setError(cleanErr(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <li className={`mcp-hit ${open ? 'is-open' : ''}`}>
      <div className="mcp-hit-row">
        <div className="skill-search-text">
          <code className="skill-name">{h.title ?? h.name}</code>
          <span className="muted">
            {h.id} · {h.installs.map((i) => i.label).join(', ')}
          </span>
          {h.description && <span className="mcp-hit-desc">{h.description}</span>}
        </div>
        <Button tone="ghost" icon={open ? <X size={14} /> : <Plus size={14} />} disabled={disabled} onClick={onOpen}>
          {open ? 'Скрыть' : 'Добавить'}
        </Button>
      </div>
      {open && (
        <div className="mcp-form">
          {h.installs.length > 1 && (
            <span className="skill-search-agents" role="group" aria-label="Вариант">
              {h.installs.map((i) => (
                <button
                  key={i.kind}
                  type="button"
                  className={`skill-agent-chip ${i.kind === kind ? 'is-on' : ''}`}
                  aria-pressed={i.kind === kind}
                  onClick={() => setKind(i.kind)}
                >
                  {i.label}
                </button>
              ))}
            </span>
          )}
          <code className="mcp-target">{install.url ?? [install.command, ...(install.args ?? [])].join(' ')}</code>
          <label className="mcp-field">
            <span>Имя в настройках</span>
            <input className="input mono" value={name} onChange={(e) => setName(e.target.value)} aria-label="Имя в настройках" />
          </label>
          {install.inputs.map((i) => (
            <label key={i.key} className="mcp-field">
              <span>
                {i.key}
                {i.required ? ' *' : ''}
                {i.description && <small>{i.description}</small>}
              </span>
              <input
                className="input mono"
                type={i.secret ? 'password' : 'text'}
                aria-label={i.key}
                placeholder={i.default}
                value={values[i.key] ?? ''}
                onChange={(e) => setValues((v) => ({ ...v, [i.key]: e.target.value }))}
              />
            </label>
          ))}
          {error && <p className="inline-error">{error}</p>}
          <div>
            <Button tone="primary" busy={busy} disabled={missing || !name.trim()} onClick={() => void submit()}>
              Установить
            </Button>
          </div>
        </div>
      )}
    </li>
  );
}
