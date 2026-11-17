// Состояние автообновления и окно «Что нового»: одна подписка на main, читают боковая панель и окно.
import { useSyncExternalStore } from 'react';
import type { UpdateState } from '../../../shared/update';
import { bridge } from './api';

let state: UpdateState = { kind: 'idle' };
let whatsNewOpen = false;
const subs = new Set<() => void>();
const notify = () => subs.forEach((f) => f());
let started = false;

function start() {
  if (started) return;
  started = true;
  void bridge.update.state().then((s) => {
    state = s;
    notify();
  });
  bridge.update.onState((s) => {
    state = s;
    notify();
  });
  // Пользователь сам проверил обновления (меню, настройки) — ответ показываем в окне.
  bridge.update.onReveal(() => openWhatsNew());
}

const subscribe = (f: () => void) => {
  start();
  subs.add(f);
  return () => subs.delete(f);
};

export const useUpdateState = () => useSyncExternalStore(subscribe, () => state);
export const useWhatsNewOpen = () => useSyncExternalStore(subscribe, () => whatsNewOpen);

export function openWhatsNew() {
  whatsNewOpen = true;
  notify();
}

export function closeWhatsNew() {
  whatsNewOpen = false;
  notify();
}

/** Перезапуск прервёт идущие прогоны: сначала спросить. true — перезапуск начат. */
export async function restartForUpdate(confirmed: boolean): Promise<{ running: number } | null> {
  if (!confirmed) {
    const runs = await bridge.core.listRuns();
    const running = runs.filter((r) => r.status === 'running').length;
    if (running > 0) return { running };
  }
  await bridge.update.install();
  return null;
}
