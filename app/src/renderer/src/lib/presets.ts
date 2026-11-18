// Пресеты быстрой настройки: модели по уровням и роли по пресетам. Чистая логика — без React, её проверяют тесты.
import type { AgentKind, Models } from '@purpleflow/core';
import { presetFromTiers, TIERS, type Agents, type PresetId, type Slot, type Tier, type Tiers } from '../../../shared/presets';

export { PRESET_TIERS, presetFromTiers, presetOf, TIERS } from '../../../shared/presets';
export type { Agents, PresetId, Slot, Tier, Tiers } from '../../../shared/presets';

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
  const t = main === 'opencode' ? fillTiers(custom ?? opencodeTiers(proxy)) : TIERS[main];
  return presetFromTiers(main, preset, t);
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

/** Модель программы пробного баланса: provider — ANTHROPIC или OPENAI, как в info-v2. */
export interface TrialModel {
  provider: string;
  modelName: string;
}

/**
 * Пробный режим: на пробном балансе прокси пускает только модели программы — по одной на Anthropic и OpenAI.
 * claude получает модель Anthropic, codex и opencode — модель OpenAI. Роль на агенте без своей пробной модели
 * переходит на включённый агент, у которого она есть. Ревьюер по возможности — на другом семействе, чем исполнитель:
 * так он находит больше. null — ни одному включённому агенту пробная модель не подходит.
 */
export function trialSetup(enabled: AgentKind[], agents: Agents, offer: TrialModel[]): { agents: Agents; models: Models } | null {
  const anthropic = offer.find((m) => m.provider === 'ANTHROPIC')?.modelName;
  const openai = offer.find((m) => m.provider === 'OPENAI')?.modelName;
  const modelOf = (a: AgentKind) => (a === 'claude' ? anthropic : openai);
  const usable = enabled.filter((a) => modelOf(a));
  if (!usable.length) return null;
  const pick = (a: AgentKind | undefined) => (a && usable.includes(a) ? a : usable[0]);
  const nextAgents: Agents = { ...agents };
  const nextModels = {} as Models;
  for (const slot of Object.keys(ROLE_TITLE) as Slot[]) {
    const a = pick(agents[slot] ?? (slot === 'visual' ? 'claude' : undefined));
    nextAgents[slot] = a;
    nextModels[slot] = modelOf(a) ?? '';
  }
  if (nextModels.reviewer === nextModels.executor) {
    const other = usable.find((a) => modelOf(a) !== nextModels.executor);
    if (other) {
      nextAgents.reviewer = other;
      nextModels.reviewer = modelOf(other) ?? '';
    }
  }
  return { agents: nextAgents, models: nextModels };
}

/** Роли уже стоят на пробных моделях — предлагать перевод незачем. */
export function isTrialSetup(models: Models, offer: TrialModel[]): boolean {
  const names = new Set(offer.map((m) => m.modelName));
  return (Object.keys(ROLE_TITLE) as Slot[]).every((slot) => {
    const m = models[slot] ?? '';
    return names.has(m.replace(/^purpleflow\//, ''));
  });
}
