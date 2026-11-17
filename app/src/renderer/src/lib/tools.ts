import type { AgentKind, Role, ToolName } from '@purpleflow/core';

export const AGENT_KINDS: AgentKind[] = ['claude', 'codex'];

/** Включённые CLI-агенты; не задано или пусто — оба. */
export function enabledList(enabled?: AgentKind[]): AgentKind[] {
  const list = AGENT_KINDS.filter((a) => enabled?.includes(a));
  return list.length ? list : [...AGENT_KINDS];
}

/**
 * Нужен ли инструмент: git и openspec — всегда, claude и codex — если включены
 * и на нём работает хотя бы одна роль.
 */
export function toolNeeded(t: ToolName, agents?: Partial<Record<Role, AgentKind>>, enabled?: AgentKind[]): boolean {
  if (t !== 'claude' && t !== 'codex') return true;
  if (!enabledList(enabled).includes(t)) return false;
  return !agents || Object.values(agents).includes(t);
}
