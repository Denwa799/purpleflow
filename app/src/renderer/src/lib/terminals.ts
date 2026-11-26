// Терминалы чатов: оболочка в PTY (main) и xterm в окне. Живут вне панели — переключили инструмент или ушли в
// другой чат, вернулись — тот же терминал с историей и запущенными командами; панель лишь ставит его элемент к себе.
import { useSyncExternalStore } from 'react';
import { Terminal as XTerm } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { bridge } from './api';
import { THEME } from '../components/Terminal';

export interface TermTab {
  key: string;
  title: string;
  /** Оболочка вышла (exit) — вкладку можно закрыть или открыть новую. */
  exited: boolean;
}

interface Live {
  tab: TermTab;
  pty: number | null;
  xterm: XTerm;
  fit: FitAddon;
  /** Элемент xterm: панель переставляет его к себе. */
  el: HTMLDivElement;
  opened: boolean;
  exited: boolean;
  cwd: string;
}

export interface ChatTerms {
  tabs: TermTab[];
  active: string | null;
}

const EMPTY: ChatTerms = { tabs: [], active: null };
const chats = new Map<string, ChatTerms>();
const lives = new Map<string, Live>();
const byPty = new Map<number, Live>();
const listeners = new Set<() => void>();
let seq = 0;

const emit = () => listeners.forEach((l) => l());
const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => listeners.delete(l);
};
const update = (chatId: string, fn: (c: ChatTerms) => ChatTerms) => {
  chats.set(chatId, fn(chats.get(chatId) ?? EMPTY));
  emit();
};

export const useChatTerms = (chatId: string): ChatTerms => useSyncExternalStore(subscribe, () => chats.get(chatId) ?? EMPTY);
export const liveOf = (key: string) => lives.get(key) ?? null;
export const getAllTermChatIds = () => [...chats.keys()];

const patch = (chatId: string, key: string, p: Partial<TermTab>) =>
  update(chatId, (c) => ({ ...c, tabs: c.tabs.map((t) => (t.key === key ? { ...t, ...p } : t)) }));

/** Новый терминал чата в папке cwd; оболочка запускается, когда панель впервые покажет его (нужен размер). */
export function newTerminal(chatId: string, cwd: string): string {
  const key = `term${++seq}`;
  const tab: TermTab = { key, title: 'Терминал', exited: false };
  const xterm = new XTerm({
    theme: THEME,
    // Значки в приглашениях (powerline, starship, oh-my-zsh) — из Nerd Font, если он установлен: шрифт берётся по символу.
    fontFamily:
      "'Geist Mono Variable', 'Geist Mono', 'Symbols Nerd Font Mono', 'MesloLGS NF', 'MesloLGS Nerd Font', 'JetBrainsMono Nerd Font', 'Hack Nerd Font', 'FiraCode Nerd Font', ui-monospace, Menlo, monospace",
    fontSize: 12.5,
    // Ровно высота ячейки: стрелки и плашки powerline (Nerd Font) рассчитаны на неё — иначе щели между сегментами.
    lineHeight: 1,
    cursorBlink: true,
    scrollback: 5000,
    allowTransparency: true,
    macOptionIsMeta: true,
  });
  const fit = new FitAddon();
  xterm.loadAddon(fit);
  const el = document.createElement('div');
  el.className = 'term-host';
  const live: Live = { tab, pty: null, xterm, fit, el, opened: false, exited: false, cwd };
  lives.set(key, live);
  xterm.onData((d) => live.pty != null && bridge.terminal.write(live.pty, d));
  xterm.onTitleChange((t) => t.trim() && patch(chatId, key, { title: t.trim().slice(0, 40) }));
  update(chatId, (c) => ({ tabs: [...c.tabs, tab], active: key }));
  return key;
}

/** Панель показала терминал: открыть xterm в элементе, подогнать размер, при первом показе — запустить оболочку. */
export function attachTerminal(chatId: string, key: string, host: HTMLElement) {
  const live = lives.get(key);
  if (!live) return;
  for (const c of [...host.children]) if (c !== live.el) c.remove();
  if (live.el.parentElement !== host) host.appendChild(live.el);
  if (!live.opened) {
    live.xterm.open(live.el);
    live.opened = true;
  }
  fitTerminal(key);
  if (live.pty == null && !live.exited) {
    live.pty = -1; // запуск идёт — второй раз не запускаем
    void bridge.terminal
      .open({ cwd: live.cwd, cols: live.xterm.cols, rows: live.xterm.rows })
      .then((id) => {
        live.pty = id;
        byPty.set(id, live);
      })
      .catch((e) => {
        live.pty = null;
        live.xterm.write(`\r\n\x1b[31mТерминал не запустился: ${(e as Error).message}\x1b[0m\r\n`);
        live.exited = true;
        patch(chatId, key, { exited: true });
      });
  }
  live.xterm.focus();
}

/** Размер панели изменился — xterm и оболочка подстраиваются. */
export function fitTerminal(key: string) {
  const live = lives.get(key);
  if (!live?.opened || !live.el.isConnected || !live.el.clientWidth) return;
  try {
    live.fit.fit();
  } catch {
    return;
  }
  if (live.pty != null && live.pty > 0) void bridge.terminal.resize(live.pty, live.xterm.cols, live.xterm.rows);
}

export const selectTerminal = (chatId: string, key: string) => update(chatId, (c) => ({ ...c, active: key }));

export function closeTerminal(chatId: string, key: string) {
  const live = lives.get(key);
  if (live) {
    if (live.pty != null && live.pty > 0) {
      void bridge.terminal.kill(live.pty);
      byPty.delete(live.pty);
    }
    live.xterm.dispose();
    live.el.remove();
    lives.delete(key);
  }
  update(chatId, (c) => {
    const i = c.tabs.findIndex((t) => t.key === key);
    const tabs = c.tabs.filter((t) => t.key !== key);
    const active = c.active === key ? (tabs[Math.min(Math.max(0, i), tabs.length - 1)]?.key ?? null) : c.active;
    return { tabs, active };
  });
}

/** Чат удалён — его оболочки гаснут. */
export function dropChatTerminals(chatId: string) {
  for (const t of chats.get(chatId)?.tabs ?? []) closeTerminal(chatId, t.key);
  chats.delete(chatId);
  emit();
}

// Вывод оболочек и их выход — из main.
bridge.terminal.onData((id, data) => byPty.get(id)?.xterm.write(data));
bridge.terminal.onExit((id, code) => {
  const live = byPty.get(id);
  if (!live) return;
  byPty.delete(id);
  live.pty = null;
  live.exited = true;
  live.xterm.write(`\r\n\x1b[2m[процесс завершён${code ? `, код ${code}` : ''}]\x1b[0m\r\n`);
  for (const [chatId, c] of chats) if (c.tabs.some((t) => t.key === live.tab.key)) patch(chatId, live.tab.key, { exited: true });
});
