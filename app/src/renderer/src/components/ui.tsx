import type { ButtonHTMLAttributes, InputHTMLAttributes, ReactNode, TextareaHTMLAttributes } from 'react';
import { forwardRef, useEffect, useState } from 'react';
import { liveNumber, settleNumber, type NumberRange } from '../lib/numberDraft';
import type { RunStatus } from '@purpleflow/core';
import { STATUS_LABEL } from '../lib/format';

type Tone = 'primary' | 'ghost' | 'quiet' | 'danger' | 'approve';

export function Button({
  tone = 'ghost',
  icon,
  children,
  busy,
  className = '',
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & { tone?: Tone; icon?: ReactNode; busy?: boolean }) {
  return (
    <button {...rest} className={`btn btn-${tone} ${busy ? 'is-busy' : ''} ${className}`} disabled={rest.disabled || busy}>
      {busy ? <span className="spinner" aria-hidden /> : icon}
      {children && <span>{children}</span>}
    </button>
  );
}

export function Field({ label, hint, children, aside }: { label: string; hint?: ReactNode; children: ReactNode; aside?: ReactNode }) {
  return (
    <label className="field">
      <span className="field-head">
        <span className="field-label">{label}</span>
        {aside}
      </span>
      {children}
      {hint && <span className="field-hint">{hint}</span>}
    </label>
  );
}

export const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement> & { mono?: boolean }>(function Input(
  { mono, className = '', ...rest },
  ref,
) {
  return <input ref={ref} spellCheck={false} {...rest} className={`input ${mono ? 'mono' : ''} ${className}`} />;
});

/**
 * Целое число в настройках: поле можно стереть и набрать заново — значение по умолчанию и пределы
 * применяются, когда человек ушёл из поля, а не на каждое нажатие.
 */
export function NumberInput({
  value,
  onValue,
  min,
  max,
  fallback,
  ...rest
}: NumberRange & { value: number; onValue: (n: number) => void } & Omit<
    InputHTMLAttributes<HTMLInputElement>,
    'value' | 'onChange' | 'min' | 'max' | 'type'
  >) {
  const [text, setText] = useState(String(value));
  const [editing, setEditing] = useState(false);
  // Значение поменялось снаружи (сброс настроек, загрузка) — показываем его, если человек сейчас не печатает.
  useEffect(() => {
    if (!editing) setText(String(value));
  }, [value, editing]);
  const range = { min, max, fallback };
  return (
    <Input
      {...rest}
      type="number"
      inputMode="numeric"
      min={min}
      max={max}
      value={text}
      onFocus={(e) => {
        setEditing(true);
        rest.onFocus?.(e);
      }}
      onChange={(e) => {
        setText(e.target.value);
        const n = liveNumber(e.target.value, range);
        if (n !== null && n !== value) onValue(n);
      }}
      onBlur={(e) => {
        setEditing(false);
        const n = settleNumber(text, range);
        setText(String(n));
        if (n !== value) onValue(n);
        rest.onBlur?.(e);
      }}
    />
  );
}

export const TextArea = forwardRef<HTMLTextAreaElement, TextareaHTMLAttributes<HTMLTextAreaElement>>(function TextArea(
  { className = '', ...rest },
  ref,
) {
  return <textarea ref={ref} {...rest} className={`input textarea ${className}`} />;
});

export function StatusPill({ status }: { status: RunStatus }) {
  return (
    <span className={`pill pill-${status}`}>
      <span className="pill-dot" />
      {STATUS_LABEL[status]}
    </span>
  );
}

export function Empty({ icon, title, children, action }: { icon: ReactNode; title: string; children?: ReactNode; action?: ReactNode }) {
  return (
    <div className="empty">
      <div className="empty-icon">{icon}</div>
      <h3>{title}</h3>
      {children && <p>{children}</p>}
      {action}
    </div>
  );
}

export function Topbar({ title, sub, children }: { title: ReactNode; sub?: ReactNode; children?: ReactNode }) {
  return (
    <header className="topbar">
      <div className="topbar-title">
        <h1>{title}</h1>
        {sub && <div className="topbar-sub">{sub}</div>}
      </div>
      <div className="topbar-actions">{children}</div>
    </header>
  );
}
