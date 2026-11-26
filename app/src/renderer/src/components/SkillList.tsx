// Скиллы и команды, которые видят агенты: экран проекта и вкладка «Сессия» чата.
import { useEffect, useState, type ReactNode } from 'react';
import { TriangleAlert } from 'lucide-react';
import type { AgentKind, ChatSkill } from '@purpleflow/core';
import { bridge } from '../lib/api';
import { useStore } from '../lib/store';

/** Скиллы папки проекта (или только пользовательские — без проекта); null — ещё загружаются. */
export function useSkills(projectPath?: string): ChatSkill[] | null {
  const [skills, setSkills] = useState<ChatSkill[] | null>(null);
  const { state } = useStore();
  const userConfig = state.settings?.userConfig;
  useEffect(() => {
    let live = true;
    setSkills(null);
    void bridge.core
      .listChatSkills(projectPath)
      .then((s) => live && setSkills(s))
      .catch(() => live && setSkills([]));
    return () => {
      live = false;
    };
  }, [projectPath, userConfig]);
  return skills;
}

const SOURCE: Record<ChatSkill['source'], string> = { project: 'проект', user: 'ваш' };

/**
 * Список скиллов: имя, описание, откуда и какие из включённых агентов найдут его сами.
 * agent — агент чата: скиллы, которые он сам не найдёт, приглушены (через «/» их всё равно можно вызвать).
 */
export function SkillList({
  skills,
  agent,
  compact,
  limit,
  actions,
}: {
  skills: ChatSkill[];
  agent?: AgentKind;
  compact?: boolean;
  limit?: number;
  /** Кнопки справа в строке скилла (вкладка «Сессия»: открыть, удалить). */
  actions?: (s: ChatSkill) => ReactNode;
}) {
  const { state } = useStore();
  const enabled = state.settings?.enabledAgents ?? ['claude', 'codex'];
  return (
    <ul className={`skill-list ${compact ? 'is-compact' : ''}`}>
      {/* Проектные — первыми: их видно реже, а ваших из ~/.claude может быть много. */}
      {[...skills]
        .sort((a, b) => Number(a.source !== 'project') - Number(b.source !== 'project'))
        .slice(0, limit)
        .map((s) => {
          const who = (s.agents ?? []).filter((a) => enabled.includes(a));
          const native = !agent || who.includes(agent);
          return (
            <li key={`${s.source}:${s.name}`} className={native ? '' : 'is-dim'} title={s.path}>
              <div className="skill-head">
                <code className="skill-name">
                  {s.kind === 'command' ? '/' : ''}
                  {s.name}
                </code>
                <span className="tag">{s.plugin ? `плагин ${s.plugin}` : SOURCE[s.source]}</span>
                {s.kind === 'command' && <span className="tag">команда</span>}
                {s.untracked && (
                  <span className="tag is-wait" title="Скилл не в git: прогон в отдельной рабочей копии его не увидит. Закоммитьте его.">
                    <TriangleAlert size={11} /> не в git
                  </span>
                )}
                <span className="grow" />
                {!compact &&
                  who.map((a) => (
                    <span key={a} className={`qs-agent qs-agent-${a}`}>
                      {a}
                    </span>
                  ))}
                {actions?.(s)}
              </div>
              {s.description && <p className="skill-desc">{s.description}</p>}
              {compact && !native && <p className="skill-desc">{agent} сам не найдёт — вызовите через «/»</p>}
            </li>
          );
        })}
    </ul>
  );
}
