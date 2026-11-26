// Мост main-процесса к <webview> окна (app/src/main/chatweb.ts): агент подключает pw к вкладкам окна по CDP.
// Ядро знает только порт и ключ — адрес владельца вкладок (чата или прогона) подписывает само.
import crypto from 'node:crypto';
import type { Kernel } from './kernel.js';

let bridge: { port: number; key: string } | null = null;

export function setChatWebBridge(b: { port: number; key: string } | null): void {
  bridge = b;
}

/** Браузер в окне выключен: тесты и e2e (PURPLEFLOW_CHAT_BROWSER=off) — тогда Chrome без окна, как раньше. */
export const webBrowserDisabled = (k: Kernel) => (k.opts.env.PURPLEFLOW_CHAT_BROWSER ?? process.env.PURPLEFLOW_CHAT_BROWSER) === 'off';

/** Мост есть (ядро запущено в приложении) и не выключен. */
export const hasWebBridge = (k: Kernel) => Boolean(bridge) && !webBrowserDisabled(k);

/**
 * Адрес CDP для pw владельца вкладок: чат (`<id чата>`) или прогон (`run:<id>` — визуальная проверка и самопроверка).
 * Подпись та же, что в chatWebEndpoint main-процесса. null — моста нет.
 */
export function webEndpoint(owner: string): string | null {
  const b = bridge;
  if (!b) return null;
  const sig = crypto.createHmac('sha256', Buffer.from(b.key, 'hex')).update(owner).digest('hex').slice(0, 32);
  return `ws://127.0.0.1:${b.port}/cdp/${Buffer.from(owner).toString('base64url')}/${sig}`;
}
