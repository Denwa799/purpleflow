// Кнопки в строках списков скиллов и MCP: открыть скилл для правки, удаление в два шага.
import { LoaderCircle, Pencil, Trash2 } from 'lucide-react';
import type { ChatSkill } from '@purpleflow/core';
import { bridge } from '../lib/api';
import { useEffect, useRef, useState } from 'react';

/** Первое нажатие спрашивает («Удалить из проекта?»), второе удаляет; через 4 секунды вопрос снимается. */
export function ConfirmDelete({
  name,
  ask,
  title,
  onConfirm,
}: {
  name: string;
  ask: string;
  title?: string;
  onConfirm: () => Promise<void>;
}) {
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);
  const timer = useRef(0);
  useEffect(() => () => window.clearTimeout(timer.current), []);
  if (!confirm)
    return (
      <button
        type="button"
        className="skill-del"
        aria-label={`Удалить ${name}`}
        title="Удалить"
        onClick={() => {
          setConfirm(true);
          window.clearTimeout(timer.current);
          timer.current = window.setTimeout(() => setConfirm(false), 4000);
        }}
      >
        <Trash2 size={14} />
      </button>
    );
  return (
    <button
      type="button"
      className="skill-del is-confirm"
      disabled={busy}
      title={title}
      onClick={() => {
        setBusy(true);
        void onConfirm().finally(() => {
          setBusy(false);
          setConfirm(false);
        });
      }}
    >
      {busy ? <LoaderCircle size={13} className="spin" /> : <Trash2 size={13} />}
      {ask}
    </button>
  );
}

/** Открыть файл скилла (SKILL.md или команду) в редакторе системы — править текст. */
export function OpenSkill({ s }: { s: ChatSkill }) {
  return (
    <button
      type="button"
      className="skill-del"
      aria-label={`Открыть ${s.name}`}
      title={`Открыть для правки: ${s.path}`}
      onClick={() => void bridge.openPath(s.path)}
    >
      <Pencil size={14} />
    </button>
  );
}
