// Общий список «агент · модель» в поле чата: разделы по включённым агентам, поиск и своя модель.
import type { AgentKind } from '@purpleflow/core';
import type { DropOption } from '../components/Dropdown';

export interface PickItem {
  agent: AgentKind;
  /** '' — модель по умолчанию из настроек ролей. */
  model: string;
  option?: DropOption<string>;
  /** Своё имя модели из поиска, которого нет в списке. */
  custom?: boolean;
}

export interface PickSection {
  agent: AgentKind;
  items: PickItem[];
}

/**
 * Разделы по агентам в порядке включения. Пустой поиск — всё, с «по умолчанию» первым в каждом разделе; иначе — подходящие
 * модели, а пустые разделы скрыты. Имени из поиска нет ни в одном списке — сверху пункт «своя модель» у текущего агента.
 */
export function pickerSections(
  agents: AgentKind[],
  options: Record<AgentKind, DropOption<string>[]>,
  current: AgentKind,
  query: string,
): PickSection[] {
  const q = query.trim().toLowerCase();
  const sections: PickSection[] = agents.map((agent) => ({
    agent,
    items: [
      ...(q ? [] : [{ agent, model: '' }]),
      ...(options[agent] ?? [])
        .filter((o) => !q || o.value.toLowerCase().includes(q))
        .map((option) => ({ agent, model: option.value, option })),
    ],
  }));
  const exact = q && agents.some((a) => (options[a] ?? []).some((o) => o.value.toLowerCase() === q));
  if (q && !exact) {
    const own = sections.find((s) => s.agent === current) ?? sections[0];
    if (own) own.items.unshift({ agent: own.agent, model: query.trim(), custom: true });
  }
  return sections.filter((s) => s.items.length > 0);
}
