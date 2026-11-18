// Замечания ревью рядом с диффом: список, пометки повторного ревью, выбор пунктов.
import type { PlanCoverage, ReviewItem } from '@purpleflow/core';
import { Check, CircleCheck, CircleDashed, CircleX } from 'lucide-react';

export const reviewKey = (r: ReviewItem) => `${r.file ?? ''}:${r.line ?? ''}:${r.message}`;
/** Галочка «исправить» у замечания ревьюера. */
export function PickBox({ item, picked, onPicked }: { item: ReviewItem; picked: ReviewItem[]; onPicked: (items: ReviewItem[]) => void }) {
  const on = picked.some((x) => reviewKey(x) === reviewKey(item));
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      className={`switch pick-switch ${on ? 'is-on' : ''}`}
      title={on ? 'Убрать из исправлений' : 'Отдать исполнителю на исправление'}
      onClick={() => onPicked(on ? picked.filter((x) => reviewKey(x) !== reviewKey(item)) : [...picked, item])}
    >
      <i />
      <span>Исправить</span>
    </button>
  );
}
const ORIGIN: Record<NonNullable<ReviewItem['origin']>, { label: string; title: string }> = {
  unfixed: { label: 'не исправлено', title: 'Это замечание было и на прошлом ревью — исполнитель его не исправил или обошёл' },
  from_fix: { label: 'из‑за исправления', title: 'Появилось в коде, который исполнитель поменял, исправляя прошлые замечания' },
  new: { label: 'новое', title: 'В коде, который был и на прошлом ревью, — ревьюер заметил только сейчас' },
};
/** Пометка повторного ревью: ходит ли прогон по кругу. */
export function OriginTag({ origin }: { origin?: ReviewItem['origin'] }) {
  if (!origin) return null;
  return (
    <span className={`origin-tag o-${origin}`} title={ORIGIN[origin].title}>
      {ORIGIN[origin].label}
    </span>
  );
}
export function NoteList({
  title,
  kind,
  items,
  onJump,
  picked,
  onPicked,
}: {
  title: string;
  kind: 'blocking' | 'note';
  items: ReviewItem[];
  onJump: (r: ReviewItem) => void;
  picked?: ReviewItem[];
  onPicked?: (items: ReviewItem[]) => void;
}) {
  if (!items.length) return null;
  return (
    <section className="notes">
      <h4>
        {title} <span className="muted">{items.length}</span>
      </h4>
      {items.map((r, i) => (
        <div key={i} className={`note n-${kind}`}>
          {r.file && (
            <button className="note-loc" onClick={() => onJump(r)}>
              {r.file.split('/').pop()}
              {r.line ? `:${r.line}` : ''}
            </button>
          )}
          <OriginTag origin={r.origin} />
          <p>{r.message}</p>
          {picked && onPicked && <PickBox item={r} picked={picked} onPicked={onPicked} />}
        </div>
      ))}
    </section>
  );
}

/** Что визуальная проверка подтвердила: не замечания — без «Исправить» и без счёта в «Заметках». */
export function PassedList({ items, title = 'Проверено в браузере' }: { items: string[]; title?: string }) {
  if (!items.length) return null;
  return (
    <section className="notes passed-list">
      <h4>
        {title} <span className="muted">{items.length}</span>
      </h4>
      <ul>
        {items.map((x, i) => (
          <li key={i}>
            <Check size={14} className="passed-mark" />
            <span>{x}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}

const PLAN_STATUS: Record<PlanCoverage['status'], { label: string; icon: typeof Check }> = {
  done: { label: 'сделано', icon: CircleCheck },
  partial: { label: 'частично', icon: CircleDashed },
  missing: { label: 'не сделано', icon: CircleX },
};
/** Пункт плана как замечание исполнителю — для «Исправить выбранные». */
export function planItemAsReview(p: PlanCoverage): ReviewItem {
  return {
    file: null,
    line: null,
    message: `Пункт плана «${p.task}» — ${PLAN_STATUS[p.status].label}${p.note ? `: ${p.note}` : ''}. Доделай его.`,
  };
}
/** Сколько пунктов плана сделано — для подписи вкладки и вердикта. */
export function planScore(plan?: PlanCoverage[]): { done: number; total: number; open: number } | null {
  if (!plan?.length) return null;
  const done = plan.filter((p) => p.status === 'done').length;
  return { done, total: plan.length, open: plan.length - done };
}
/** План → факт: пункты tasks.md и сделаны ли они в диффе, по оценке ревьюера. Несделанное можно отдать исполнителю. */
export function PlanCoverageList({
  plan,
  picked,
  onPicked,
}: {
  plan?: PlanCoverage[];
  picked?: ReviewItem[];
  onPicked?: (items: ReviewItem[]) => void;
}) {
  const score = planScore(plan);
  if (!plan || !score) return null;
  return (
    <section className="notes plan-cover">
      <h4>
        План → факт{' '}
        <span className="muted" title="По оценке ревьюера: флажки в tasks.md не в счёт, он смотрел в код">
          сделано {score.done} из {score.total}
        </span>
      </h4>
      {plan.map((p, i) => {
        const st = PLAN_STATUS[p.status];
        const Icon = st.icon;
        return (
          <div key={i} className={`plan-row is-${p.status}`}>
            <Icon size={15} className="plan-mark" aria-label={st.label} />
            <div>
              <div className="plan-task">{p.task}</div>
              {p.note && <p className="plan-note">{p.note}</p>}
            </div>
            {p.status !== 'done' && picked && onPicked ? (
              <PickBox item={planItemAsReview(p)} picked={picked} onPicked={onPicked} />
            ) : (
              <span />
            )}
          </div>
        );
      })}
    </section>
  );
}
