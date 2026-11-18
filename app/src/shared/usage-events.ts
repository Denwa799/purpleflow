import type { CoreCommand, CoreEvent, RunFile } from '@purpleflow/core';
import { presetOf } from './presets';

/**
 * Статистика: какие шаги проходят настройка и задачи. Сервер принимает только события и значения из своего белого
 * списка и отклоняет пачку целиком, если что-то не так, поэтому новое событие или поле сначала добавляется
 * в automation (src/core/purpleflow-event), выкатывается, и только потом начинает отправляться отсюда.
 */
export interface UsageEvent {
  name: string;
  occurredAt: string;
  props?: Record<string, string | number | boolean>;
}

type UsageDraft = Omit<UsageEvent, 'occurredAt'>;

const GATE_DECISIONS: Partial<Record<CoreCommand['type'], string>> = {
  'gate.approve': 'approve',
  'gate.reject': 'reject',
  'gate.answer': 'answer',
  'gate.fix': 'fix',
  'gate.accept': 'accept',
  'gate.cancel': 'cancel',
};

const GATES: readonly string[] = ['gate0', 'gate1', 'gate2', 'limit'];

/** Как на сервере: имя модели без пробелов и путей; иное не отправляем — сервер отклонил бы всю пачку. */
const MODEL_NAME = /^[A-Za-z0-9][A-Za-z0-9._:/@-]{0,79}$/;

/** Шаги до первой задачи и причины сбоев — те же списки, что в белом списке сервера. */
export const SETUP_STEPS = [
  'welcome',
  'login',
  'register',
  'key',
  'settings',
  'check',
  'project',
  'project_added',
  'project_skipped',
] as const;
export const SETUP_FAIL_REASONS = ['auth', 'network', 'key', 'tools', 'check', 'project', 'unknown'] as const;
export type SetupStep = (typeof SETUP_STEPS)[number];
export type SetupFailReason = (typeof SETUP_FAIL_REASONS)[number];

/** Событие настройки из окна: только известные шаги и причины, остальное отбрасывается. */
export function usageFromSetup(step: unknown, reason?: unknown): UsageDraft | null {
  if (!(SETUP_STEPS as readonly unknown[]).includes(step)) return null;
  if (reason === undefined) return { name: 'setup_step', props: { step: step as string } };
  const r = (SETUP_FAIL_REASONS as readonly unknown[]).includes(reason) ? (reason as string) : 'unknown';
  return { name: 'setup_failed', props: { step: step as string, reason: r } };
}

/** Что ещё известно о команде: на каких воротах стоял прогон, когда человек принял решение. */
export interface CommandContext {
  gate?: string;
}

/** Команда, которую ядро успешно выполнило. run_started — отдельно, по самому прогону (usageFromRunStart). */
export function usageFromCommand(cmd: CoreCommand, ctx: CommandContext = {}): UsageDraft | null {
  const runId = 'runId' in cmd ? cmd.runId : undefined;
  if (cmd.type === 'run.pr') return { name: 'pr_created', props: runId ? { runId } : {} };
  const decision = GATE_DECISIONS[cmd.type];
  if (!decision) return null;
  return {
    name: 'gate_decided',
    props: { ...(runId ? { runId } : {}), ...(ctx.gate && GATES.includes(ctx.gate) ? { gate: ctx.gate } : {}), decision },
  };
}

/** Старт прогона: режим, пресет, агент и модель исполнителя, уровень рассуждений, идёт ли через AI-прокси PurpleSchool. */
export function usageFromRunStart(run: Pick<RunFile, 'id' | 'mode' | 'agents' | 'models' | 'efforts'>, proxy: boolean): UsageDraft {
  const agent = run.agents.executor;
  const model = run.models.executor?.trim() || 'default';
  const effort = run.efforts?.executor;
  return {
    name: 'run_started',
    props: {
      runId: run.id,
      mode: run.mode,
      preset: presetOf(run.agents, run.models),
      agent,
      ...(MODEL_NAME.test(model) ? { model } : {}),
      ...(effort ? { effort } : {}),
      proxy,
    },
  };
}

export function usageFromCoreEvent(e: CoreEvent): UsageDraft | null {
  switch (e.type) {
    case 'gate.waiting':
      return {
        name: 'gate_waiting',
        props: {
          runId: e.runId,
          gate: e.gate,
          ...(e.limit ? { cause: e.limit.cause, attempts: e.limit.attempts, limit: e.limit.max } : {}),
        },
      };
    case 'tests.result':
      return {
        name: 'tests_finished',
        props: { runId: e.runId, passed: e.result.passed, durationMs: Math.max(0, Math.round(e.result.durationMs)) },
      };
    case 'review.result':
      return { name: 'review_finished', props: { runId: e.runId, hasBlocking: e.result.blocking.length > 0 } };
    case 'stage.failed':
      return { name: 'stage_failed', props: { runId: e.runId, stage: e.stage } };
    case 'run.finished':
      return e.status === 'finished' || e.status === 'stopped' || e.status === 'cancelled'
        ? { name: 'run_finished', props: { runId: e.runId, status: e.status, ...(e.reason ? { reason: e.reason } : {}) } }
        : null;
    default:
      return null;
  }
}

/** sent — принято; rejected — сервер отказал, повтор не поможет; failed — стоит повторить позже. */
export type UsageSendResult = 'sent' | 'rejected' | 'failed';

const BATCH_SIZE = 50;
const MAX_QUEUED = 500;

export class UsageQueue {
  private items: UsageEvent[] = [];
  private flushing: Promise<void> | null = null;

  constructor(private readonly send: (batch: UsageEvent[]) => Promise<UsageSendResult>) {}

  get size() {
    return this.items.length;
  }

  push(event: UsageEvent) {
    this.items.push(event);
    if (this.items.length > MAX_QUEUED) this.items.shift();
  }

  clear() {
    this.items = [];
  }

  /** Параллельный вызов присоединяется к идущей отправке: одно событие не уйдёт дважды. */
  flush(): Promise<void> {
    this.flushing ??= this.drain().finally(() => (this.flushing = null));
    return this.flushing;
  }

  private async drain() {
    while (this.items.length > 0) {
      const batch = this.items.slice(0, BATCH_SIZE);
      if ((await this.send(batch)) === 'failed') return;
      // Пока шла отправка, очередь могла быть очищена выключателем.
      this.items = this.items.filter((item) => !batch.includes(item));
    }
  }
}
