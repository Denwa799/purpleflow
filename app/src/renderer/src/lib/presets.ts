// Пресеты быстрой настройки: модели по уровням и роли по пресетам. Чистая логика — без React, её проверяют тесты.
import type { AgentKind, Models, Role } from '@purpleflow/core';

export type Agents = Record<Role, AgentKind> & { visual?: AgentKind; manager?: AgentKind; scan?: AgentKind };
export type PresetId = 'economy' | 'optimal' | 'max';
export type Tier = 'low' | 'mid' | 'high' | 'max';
export type Tiers = Record<Tier, string>;

/**
 * Модели по уровням. Имена — те, что принимает и CLI, и AI-прокси PurpleSchool:
 * у claude алиасы CLI, у codex — линейка gpt-6 ступень в ступень: haiku → luna, sonnet → terra, opus → sol, Fable → astra.
 */
const TIERS: Record<AgentKind, Record<Tier, string>> = {
  claude: { low: 'haiku', mid: 'sonnet', high: 'opus', max: 'claude-fable-5-2' },
  codex: { low: 'gpt-6-luna', mid: 'gpt-6.1-terra', high: 'gpt-6-sol', max: 'gpt-6-astra' },
  // У opencode ступени выбирает человек из моделей своих провайдеров (opencodeTiers); с AI-прокси по умолчанию — линейка прокси.
  opencode: { low: '', mid: '', high: '', max: '' },
};

export const TIER_ORDER: Tier[] = ['low', 'mid', 'high', 'max'];

export const TIER_TITLE: Record<Tier, string> = { low: 'Быстрая', mid: 'Рабочая', high: 'Сильная', max: 'Самая сильная' };

/**
 * Пустую ступень занимает ближайшая заполненная, при равенстве — более дешёвая (нижняя):
 * хватит и одной модели — тогда все роли на ней.
 */
export function fillTiers(t: Tiers): Tiers {
  const out = { ...t };
  for (const [i, tier] of TIER_ORDER.entries()) {
    if (t[tier].trim()) continue;
    for (let d = 1; d < TIER_ORDER.length; d++) {
      const near = [TIER_ORDER[i - d], TIER_ORDER[i + d]].find((x) => x && t[x].trim());
      if (near) {
        out[tier] = t[near].trim();
        break;
      }
    }
  }
  return out;
}

const OPENCODE_TIERS_KEY = 'pf.opencodeTiers';

/** Ступени opencode, выбранные в прошлый раз, — удобство одного окна, без них всё работает. */
export function loadOpencodeTiers(): Tiers | null {
  try {
    const raw = JSON.parse(localStorage.getItem(OPENCODE_TIERS_KEY) ?? 'null') as Partial<Tiers> | null;
    if (!raw) return null;
    return { low: raw.low ?? '', mid: raw.mid ?? '', high: raw.high ?? '', max: raw.max ?? '' };
  } catch {
    return null;
  }
}

export function saveOpencodeTiers(t: Tiers) {
  try {
    localStorage.setItem(OPENCODE_TIERS_KEY, JSON.stringify(t));
  } catch {
    /* не запомнили — в следующий раз выберут заново */
  }
}

/** Ступени opencode: выбранные человеком, иначе с AI-прокси — линейка прокси, без него — пусто (модель из настроек opencode). */
export function opencodeTiers(proxy: boolean, saved: Tiers | null = loadOpencodeTiers()): Tiers {
  if (saved && Object.values(saved).some((m) => m.trim())) return saved;
  return proxy ? { ...TIERS.codex } : { ...TIERS.opencode };
}

export type Slot = Role | 'visual' | 'manager' | 'scan';
/**
 * Уровень модели по ролям. Все роли — на основном агенте, и от пресета к пресету все растут на ступень:
 * сильнее всех — планировщик и ревьюер (от плана и проверки зависит качество), за ними — исполнитель и менеджер,
 * ниже — визуальная проверка и сканирование.
 */
export const PRESET_TIERS: Record<PresetId, Record<Slot, Tier>> = {
  economy: { planner: 'mid', executor: 'low', reviewer: 'mid', visual: 'low', manager: 'low', scan: 'low' },
  optimal: { planner: 'high', executor: 'mid', reviewer: 'high', visual: 'low', manager: 'mid', scan: 'low' },
  max: { planner: 'max', executor: 'high', reviewer: 'max', visual: 'mid', manager: 'high', scan: 'mid' },
};

export const ROLE_TITLE: Record<Slot, string> = {
  planner: 'Планировщик',
  executor: 'Исполнитель',
  reviewer: 'Ревьюер',
  visual: 'Визуальная проверка',
  manager: 'Менеджер прогона',
  scan: 'Сканирование проекта',
};

/**
 * Все роли — на основном агенте: claude — только модели Anthropic, codex — только OpenAI,
 * opencode — ступени, выбранные человеком (custom), иначе линейка прокси или модель из его настроек.
 */
export function buildPreset(main: AgentKind, preset: PresetId, proxy = false, custom?: Tiers): { agents: Agents; models: Models } {
  const p = { tiers: PRESET_TIERS[preset] };
  const t = main === 'opencode' ? fillTiers(custom ?? opencodeTiers(proxy)) : TIERS[main];
  // Ревью той же моделью находит меньше. Если уровни дали исполнителю модель ревьюера (две ступени на одной модели),
  // на ступень ниже уходит исполнитель, а не ревьюер: проверять должна модель не слабее автора кода.
  const order: Tier[] = ['max', 'high', 'mid', 'low'];
  const reviewer = t[p.tiers.reviewer];
  let executor = t[p.tiers.executor];
  if (executor === reviewer)
    executor =
      order
        .slice(order.indexOf(p.tiers.executor))
        .map((x) => t[x])
        .find((m) => m !== reviewer) ?? executor;
  // Менеджер на одной ступени с исполнителем — и на той же модели.
  const manager = p.tiers.manager === p.tiers.executor ? executor : t[p.tiers.manager];
  return {
    agents: { planner: main, executor: main, reviewer: main, visual: main, manager: main, scan: main },
    models: {
      planner: t[p.tiers.planner],
      executor,
      reviewer,
      visual: t[p.tiers.visual],
      manager,
      scan: t[p.tiers.scan],
    },
  };
}

/**
 * Роли на выключенных CLI переводим на включённый: модель — ступени «Оптимального» пресета,
 * потому что имя модели одного CLI другому не подходит. Роли на включённых агентах не трогаем.
 */
export function restrictAgents(enabled: AgentKind[], agents: Agents, models: Models, proxy = false): { agents: Agents; models: Models } {
  const main = enabled[0];
  const preset = buildPreset(main, 'optimal', proxy).models;
  const nextAgents: Agents = { ...agents };
  const nextModels: Models = { ...models };
  for (const slot of Object.keys(ROLE_TITLE) as Slot[]) {
    // Без явного выбора визуальная проверка — на claude, менеджер и сканирование ядро выберет само.
    const current = agents[slot] ?? (slot === 'visual' ? 'claude' : undefined);
    if (!current || enabled.includes(current)) continue;
    nextAgents[slot] = main;
    nextModels[slot] = preset[slot] ?? '';
  }
  return { agents: nextAgents, models: nextModels };
}
