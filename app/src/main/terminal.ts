// Терминал в панели чата: оболочка пользователя в настоящем псевдотерминале (node-pty) — с цветами, полноэкранными
// программами, Ctrl+C и размером окна. Живёт в main-процессе; вывод уходит в окно, ввод и размер — оттуда.
import fs from 'node:fs';
import os from 'node:os';
import type { WebContents } from 'electron';
import type { IPty } from 'node-pty';

interface Session {
  pty: IPty;
  owner: WebContents;
}

const sessions = new Map<number, Session>();
let seq = 0;

/** Оболочка пользователя: $SHELL (macOS, Linux), на Windows — PowerShell. */
function shell(): { file: string; args: string[] } {
  if (process.platform === 'win32')
    return { file: process.env.COMSPEC?.toLowerCase().includes('powershell') ? process.env.COMSPEC : 'powershell.exe', args: [] };
  const file =
    process.env.SHELL && fs.existsSync(process.env.SHELL) ? process.env.SHELL : fs.existsSync('/bin/zsh') ? '/bin/zsh' : '/bin/bash';
  // Входная оболочка: окно, запущенное из Dock, не знает PATH из профиля — -l его подхватит.
  return { file, args: ['-l'] };
}

/** Открыть терминал в папке cwd для окна owner. Возвращает его id. */
export async function openTerminal(owner: WebContents, o: { cwd: string; cols: number; rows: number }): Promise<number> {
  const cwd = typeof o.cwd === 'string' && fs.existsSync(o.cwd) && fs.statSync(o.cwd).isDirectory() ? o.cwd : os.homedir();
  // Нативный модуль — только когда терминал действительно нужен.
  const pty = await import('node-pty');
  const { file, args } = shell();
  const env = { ...process.env, TERM: 'xterm-256color', COLORTERM: 'truecolor', TERM_PROGRAM: 'PurpleFlow' } as Record<string, string>;
  // Переменные самого Electron оболочке не нужны и сбивают node-инструменты пользователя.
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.ELECTRON_NO_ATTACH_CONSOLE;
  const p = pty.spawn(file, args, {
    name: 'xterm-256color',
    cols: clamp(o.cols, 2, 500, 80),
    rows: clamp(o.rows, 2, 300, 24),
    cwd,
    env,
  });
  const id = ++seq;
  sessions.set(id, { pty: p, owner });
  p.onData((data) => {
    if (!owner.isDestroyed()) owner.send('term:data', id, data);
  });
  p.onExit(({ exitCode }) => {
    sessions.delete(id);
    if (!owner.isDestroyed()) owner.send('term:exit', id, exitCode);
  });
  // Окно закрылось или перезагрузилось — его оболочки гаснут вместе с ним.
  owner.once('destroyed', () => killTerminal(owner, id));
  owner.once('did-navigate', () => killTerminal(owner, id));
  return id;
}

const clamp = (n: unknown, min: number, max: number, def: number) =>
  typeof n === 'number' && Number.isFinite(n) ? Math.min(max, Math.max(min, Math.floor(n))) : def;

/** Терминал этого окна; чужой (или закрытый) — null. */
const own = (owner: WebContents, id: number) => {
  const s = sessions.get(id);
  return s && s.owner === owner ? s : null;
};

export function writeTerminal(owner: WebContents, id: number, data: string) {
  if (typeof data === 'string') own(owner, id)?.pty.write(data);
}

export function resizeTerminal(owner: WebContents, id: number, cols: number, rows: number) {
  try {
    own(owner, id)?.pty.resize(clamp(cols, 2, 500, 80), clamp(rows, 2, 300, 24));
  } catch {
    /* оболочка уже вышла */
  }
}

export function killTerminal(owner: WebContents, id: number) {
  const s = own(owner, id);
  if (!s) return;
  sessions.delete(id);
  try {
    s.pty.kill();
  } catch {
    /* уже вышла */
  }
}

/** Выход из приложения: гасим все оболочки. */
export function killAllTerminals() {
  for (const s of sessions.values())
    try {
      s.pty.kill();
    } catch {
      /* уже вышла */
    }
  sessions.clear();
}
