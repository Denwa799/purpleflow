// Шаги первой настройки для статистики: где люди бросают вход, проверку агентов и первый проект.
import type { SetupFailReason, SetupStep } from '../../../shared/usage-events';
import { bridge } from './api';

export function setupStep(step: SetupStep, reason?: SetupFailReason) {
  try {
    bridge.setupStep(step, reason);
  } catch {
    /* статистика не должна мешать настройке */
  }
}

/** Причина неудачного входа: сеть или сам вход (неверный пароль, занятый email, частые попытки). */
export const authReason = (code?: string): SetupFailReason => (code === 'network' ? 'network' : 'auth');
