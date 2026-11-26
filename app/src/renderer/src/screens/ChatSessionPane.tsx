// Вкладка «Сессия» правой панели чата и индикатор контекста на свёрнутой панели.
import { useEffect, useState, type ReactNode } from 'react';
import { Check, Copy, FoldVertical, Pencil } from 'lucide-react';
import type { ChatFile, ChatSkill, McpEntry } from '@purpleflow/core';
import { Button } from '../components/ui';
import { bridge, cleanErr } from '../lib/api';
import { chatSession, mcpStatus, type ChatSessionSummary } from '../lib/chatSession';
import { shortPath, tokens, when } from '../lib/format';
import { SkillList, useSkills } from '../components/SkillList';
import { removeSkill } from '../components/SkillManager';
import { McpEditDialog, removeAsk, removeServer } from '../components/McpManager';
import { ConfirmDelete, OpenSkill } from '../components/RowActions';
import { EFFORT_LEVELS, effortOf } from '../lib/effort';
import { accessOf } from '../lib/chatAccess';

/** Кольцо заполнения контекста: свёрнутая панель и заголовок карточки. */
export function ContextRing({ pct, size = 22 }: { pct?: number; size?: number }) {
  const r = (size - 4) / 2;
  const len = 2 * Math.PI * r;
  const tone = pct == null ? '' : pct >= 85 ? 'is-high' : pct >= 60 ? 'is-mid' : '';
  return (
    <svg className={`ctx-ring ${tone}`} width={size} height={size} viewBox={`0 0 ${size} ${size}`} aria-hidden="true">
      <circle className="ctx-ring-track" cx={size / 2} cy={size / 2} r={r} />
      {pct != null && (
        <circle
          className="ctx-ring-fill"
          cx={size / 2}
          cy={size / 2}
          r={r}
          strokeDasharray={`${(len * Math.max(pct, 2)) / 100} ${len}`}
          transform={`rotate(-90 ${size / 2} ${size / 2})`}
        />
      )}
    </svg>
  );
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="ses-row">
      <span className="ses-label">{label}</span>
      <span className="ses-value">{children}</span>
    </div>
  );
}

function CopyValue({ value }: { value: string }) {
  const [done, setDone] = useState(false);
  return (
    <button
      type="button"
      className="ses-copy"
      title={done ? 'Скопировано' : 'Копировать'}
      aria-label="Копировать"
      onClick={() =>
        void navigator.clipboard.writeText(value).then(() => {
          setDone(true);
          setTimeout(() => setDone(false), 1500);
        })
      }
    >
      <code>{value}</code>
      {done ? <Check size={13} /> : <Copy size={13} />}
    </button>
  );
}

/** «Сжать контекст»: /compact в сессии claude — переписка остаётся, агент помнит её в пересказе. */
function CompactButton({ chat, busy }: { chat: ChatFile; busy: boolean }) {
  const [compacting, setCompacting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Ход сжатия закончился — кнопка снова доступна.
  useEffect(() => {
    if (!busy) setCompacting(false);
  }, [busy]);
  if (chat.agent !== 'claude' || chat.session?.agent !== 'claude') return null;
  return (
    <>
      <Button
        tone="quiet"
        className="ses-compact"
        icon={<FoldVertical size={14} />}
        busy={compacting}
        disabled={busy && !compacting}
        title={busy && !compacting ? 'Агент отвечает — сожмите после ответа' : 'Пересказать переписку и освободить окно модели'}
        onClick={() => {
          setError(null);
          setCompacting(true);
          bridge.core.compactChat(chat.id).catch((e) => {
            setCompacting(false);
            setError(cleanErr(e));
          });
        }}
      >
        {compacting ? 'Сжимаю…' : 'Сжать контекст'}
      </Button>
      {error && <p className="ses-note">{error}</p>}
    </>
  );
}

function ContextCard({ s, chat, busy }: { s: ChatSessionSummary; chat: ChatFile; busy: boolean }) {
  const c = s.context;
  const agent = chat.agent;
  return (
    <section className="ses-card">
      <div className="ses-card-head">
        <h3>Контекст</h3>
        <CompactButton chat={chat} busy={busy} />
      </div>
      {c ? (
        <>
          <div className="ses-ctx">
            <ContextRing pct={c.pct} size={44} />
            <div>
              <div className="ses-ctx-num">
                {tokens(c.used)}
                {c.window ? <span> из {tokens(c.window)}</span> : null}
              </div>
              <div className="ses-hint">
                {c.pct != null ? `занято ${c.pct}% окна модели` : 'размер окна модели станет известен после ответа'}
              </div>
            </div>
          </div>
          {c.pct != null && c.pct >= 85 && (
            <p className="ses-note">
              Окно почти заполнено — скоро агент сожмёт переписку сам. Можно сжать сейчас кнопкой «Сжать контекст».
            </p>
          )}
          {s.compacted && <p className="ses-note">В этой сессии контекст уже сжимался.</p>}
        </>
      ) : (
        <p className="ses-hint">
          {agent !== 'claude'
            ? `${agent} не сообщает, сколько контекста занято.`
            : s.answers
              ? 'Последний ответ не сообщил о контексте.'
              : 'Появится после первого ответа агента.'}
        </p>
      )}
    </section>
  );
}

/** Скиллы, которые видит агент чата, — рядом с MCP-серверами. */
function ChatSkills({ chat }: { chat: ChatFile }) {
  const loaded = useSkills(chat.projectPath);
  const [changed, setChanged] = useState<ChatSkill[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const skills = changed ?? loaded;
  const [all, setAll] = useState(false);
  if (!skills) return null;
  if (!skills.length)
    return (
      <Row label="Скиллы">
        <span className="ses-hint">нет</span>
      </Row>
    );
  // Сначала те, что агент найдёт сам.
  // Сначала проектные, затем те, что агент найдёт сам.
  const rank = (x: (typeof skills)[number]) => (x.source === 'project' ? 0 : 2) + (x.agents?.includes(chat.agent) ? 0 : 1);
  const sorted = [...skills].sort((a, b) => rank(a) - rank(b));
  const shown = all ? sorted : sorted.slice(0, 8);
  return (
    <div className="ses-skills">
      <span className="ses-label">Скиллы · {skills.length}</span>
      <SkillList
        skills={shown}
        agent={chat.agent}
        compact
        actions={(x) => (
          <>
            <OpenSkill s={x} />
            {!x.plugin && (
              <ConfirmDelete
                name={x.name}
                ask={x.source === 'user' ? 'Во всех проектах?' : 'Из проекта?'}
                onConfirm={async () => {
                  setError(null);
                  try {
                    setChanged(await removeSkill(chat.projectPath, x));
                  } catch (e) {
                    setError(cleanErr(e));
                  }
                }}
              />
            )}
          </>
        )}
      />
      {error && <p className="ses-note">{error}</p>}
      {sorted.length > shown.length && (
        <button className="link ses-more" onClick={() => setAll(true)}>
          Показать все ({sorted.length})
        </button>
      )}
    </div>
  );
}

/**
 * MCP-серверы сессии — как их видит агент. Серверы из настроек агента (не подключения claude.ai)
 * можно изменить и удалить; агент подхватит изменения при следующем запуске.
 */
function ChatMcp({ chat, mcp }: { chat: ChatFile; mcp: { name: string; status: string }[] }) {
  const [entries, setEntries] = useState<McpEntry[]>([]);
  const [removed, setRemoved] = useState<string[]>([]);
  const [editing, setEditing] = useState<McpEntry | null>(null);
  const [touched, setTouched] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    bridge.core
      .listMcp(chat.projectPath)
      .then((l) => live && setEntries(l.filter((e) => e.agent === chat.agent)))
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [chat.projectPath, chat.agent]);
  // Имя может быть и в проекте, и в ваших — агент берёт проектный.
  const entryOf = (name: string) => entries.find((e) => e.name === name && e.scope === 'project') ?? entries.find((e) => e.name === name);
  const saved = (l: McpEntry[]) => {
    setEntries(l.filter((e) => e.agent === chat.agent));
    setTouched(true);
  };
  return (
    <div className="ses-mcp">
      <span className="ses-label">MCP-серверы</span>
      <div className="ses-mcp-body">
        <ul>
          {mcp
            .filter((m) => !removed.includes(m.name))
            .map((m) => {
              const st = mcpStatus(m.status);
              const e = entryOf(m.name);
              return (
                <li key={m.name}>
                  <span className={`ses-dot is-${st.tone}`} />
                  <span className="ses-mcp-name">{m.name}</span>
                  <span className="ses-hint">{st.label}</span>
                  {e && (
                    <span className="ses-mcp-actions">
                      <button
                        type="button"
                        className="skill-del"
                        aria-label={`Изменить ${m.name}`}
                        title="Изменить"
                        onClick={() => setEditing(e)}
                      >
                        <Pencil size={14} />
                      </button>
                      <ConfirmDelete
                        name={m.name}
                        ask={removeAsk(e)}
                        onConfirm={async () => {
                          setError(null);
                          try {
                            saved(await removeServer(chat.projectPath, e));
                            setRemoved((r) => [...r, m.name]);
                          } catch (err) {
                            setError(cleanErr(err));
                          }
                        }}
                      />
                    </span>
                  )}
                </li>
              );
            })}
        </ul>
        {error && <p className="ses-note">{error}</p>}
        {touched && <p className="ses-hint">Агент подхватит изменения при следующем запуске.</p>}
      </div>
      {editing && <McpEditDialog entry={editing} projectPath={chat.projectPath} onClose={() => setEditing(null)} onSaved={saved} />}
    </div>
  );
}

/** Вкладка «Сессия»: контекст, агент и окружение. */
export function ChatSessionPane({ chat, model, busy }: { chat: ChatFile; model: string; busy: boolean }) {
  const s = chatSession(chat);
  const folder = chat.projectPath ?? s.cwd;
  return (
    <div className="ses">
      <ContextCard s={s} chat={chat} busy={busy} />

      <section className="ses-card">
        <h3>Агент</h3>
        <Row label="Агент">{chat.agent}</Row>
        <Row label="Модель">
          {s.model && s.model !== model ? (
            <>
              {s.model} <span className="ses-hint">· выбрана {model || 'по умолчанию'}</span>
            </>
          ) : (
            model || s.model || 'по умолчанию CLI'
          )}
        </Row>
        {EFFORT_LEVELS[chat.agent].length > 0 && <Row label="Рассуждения">{effortOf(chat.agent, chat.effort) || 'как в CLI'}</Row>}
        <Row label="Режим">
          {
            { read: 'Вопросы — только чтение', edits: 'Правки — файлы проекта, в песочнице', full: 'Полный доступ — без песочницы' }[
              accessOf(chat)
            ]
          }
        </Row>
        {s.version && <Row label="Версия CLI">{s.version}</Row>}
        <Row label="Сессия CLI">
          {chat.session ? <CopyValue value={chat.session.id} /> : <span className="ses-hint">начнётся с первым сообщением</span>}
        </Row>
      </section>

      <section className="ses-card">
        <h3>Окружение</h3>
        <Row label={chat.projectPath ? 'Проект' : 'Папка'}>
          {folder ? <span title={folder}>{shortPath(folder)}</span> : <span className="ses-hint">временная папка чата</span>}
        </Row>
        {s.mcp?.length ? (
          <ChatMcp chat={chat} mcp={s.mcp} />
        ) : (
          <Row label="MCP-серверы">
            <span className="ses-hint">{s.answers ? 'нет' : 'станут известны после ответа'}</span>
          </Row>
        )}
        <ChatSkills chat={chat} />
        <Row label="Создан">{when(chat.createdAt)}</Row>
        <Row label="Обновлён">{when(chat.updatedAt)}</Row>
      </section>
    </div>
  );
}
