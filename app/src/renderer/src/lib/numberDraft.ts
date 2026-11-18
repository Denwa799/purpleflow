// Числовое поле: что делать с набранным текстом — пока человек печатает и когда он ушёл из поля.

export interface NumberRange {
  min?: number;
  max?: number;
  /** Что подставить в пустое или нечисловое поле, когда человек из него ушёл. */
  fallback: number;
}

const clamp = (n: number, r: NumberRange) => Math.min(r.max ?? Infinity, Math.max(r.min ?? -Infinity, n));

/** Пока печатает: целое число в пределах — сразу в настройки; пусто, «-» или вне пределов — null, ждём дальше. */
export function liveNumber(text: string, r: NumberRange): number | null {
  const t = text.trim();
  if (!/^-?\d+$/.test(t)) return null;
  const n = Number(t);
  return clamp(n, r) === n ? n : null;
}

/** Ушёл из поля: пусто или мусор — значение по умолчанию, вне пределов — ближайшая граница. */
export function settleNumber(text: string, r: NumberRange): number {
  const n = Number.parseInt(text.trim(), 10);
  return Number.isFinite(n) ? clamp(n, r) : r.fallback;
}
