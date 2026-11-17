// Одна кнопка «агент · модель» под полем чата: список разбит на разделы по агентам, выбор модели выбирает и агента.
import { useCallback, useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { createPortal } from 'react-dom';
import { Check, ChevronDown, Search } from 'lucide-react';
import type { AgentKind } from '@purpleflow/core';
import { pickerSections, type PickItem } from '../lib/agentPicker';
import { proxyOnly } from '../lib/models';
import { useStore } from '../lib/store';
import { usePopover, useOutside, type DropOption } from './Dropdown';
import { SubscriptionGate } from './ModelInput';

export function AgentModelPicker({
  agents,
  agent,
  model,
  fallback,
  options,
  missing,
  disabled,
  noCustom,
  onPick,
}: {
  /** Включённые агенты — разделы списка. */
  agents: AgentKind[];
  agent: AgentKind;
  /** Своя модель чата; '' — по умолчанию. */
  model: string;
  /** Модель по умолчанию у текущего агента — видна на кнопке, пока своей нет. */
  fallback: string;
  options: Record<AgentKind, DropOption<string>[]>;
  missing: (a: AgentKind) => boolean;
  disabled?: boolean;
  /** Только модели из списка — своё имя ввести нельзя (пробный режим PurpleSchool). */
  noCustom?: boolean;
  onPick: (agent: AgentKind, model: string) => void;
}) {
  const { state } = useStore();
  const proxy = state.settings?.proxy;
  const viaProxy = Boolean(proxy?.enabled && proxy.hasKey);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const [gate, setGate] = useState<{ agent: AgentKind; model: string } | null>(null);
  const btn = useRef<HTMLButtonElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const close = useCallback(() => setOpen(false), []);
  const pop = usePopover(open, btn, 320, 480);
  useOutside(open, [btn, list], close);

  const sections = pickerSections(agents, options, agent, query)
    .map((s) => (noCustom ? { ...s, items: s.items.filter((i) => !i.custom) } : s))
    .filter((s) => s.items.length);
  const flat = sections.flatMap((s) => s.items);
  const isOn = (i: PickItem) => i.agent === agent && i.model === model && !i.custom;

  useEffect(() => {
    if (open) input.current?.focus();
  }, [open]);
  useEffect(() => {
    list.current?.querySelector<HTMLElement>(`[data-i="${active}"]`)?.scrollIntoView({ block: 'nearest' });
  }, [active]);

  const show = () => {
    setQuery('');
    const all = pickerSections(agents, options, agent, '').flatMap((s) => s.items);
    setActive(
      Math.max(
        0,
        all.findIndex((i) => i.agent === agent && i.model === model),
      ),
    );
    setOpen(true);
  };
  const pick = (i: PickItem) => {
    setOpen(false);
    btn.current?.focus();
    if (!viaProxy && proxyOnly(options[i.agent] ?? [], i.model)) return setGate({ agent: i.agent, model: i.model });
    if (i.agent !== agent || i.model !== model) onPick(i.agent, i.model);
  };
  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActive((a) => Math.min(flat.length - 1, a + 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActive((a) => Math.max(0, a - 1));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (flat[active]) pick(flat[active]);
    } else if (e.key === 'Escape' || e.key === 'Tab') {
      setOpen(false);
      btn.current?.focus();
    }
  };

  let n = -1;
  return (
    <>
      <button
        ref={btn}
        type="button"
        className={`dd amp ${open ? 'is-open' : ''}`}
        disabled={disabled}
        aria-label="Агент и модель"
        aria-haspopup="listbox"
        aria-expanded={open}
        title={missing(agent) ? `${agent} не найден` : undefined}
        onClick={() => (open ? setOpen(false) : show())}
        onKeyDown={(e) => {
          if (!open && ['ArrowDown', 'ArrowUp'].includes(e.key)) {
            e.preventDefault();
            show();
          }
        }}
      >
        <span className="amp-agent">{agent}</span>
        <span className="amp-sep">·</span>
        <span className={`amp-model ${model ? '' : 'is-default'}`}>{model || fallback || 'по умолчанию'}</span>
        <ChevronDown size={14} className="dd-chev" />
      </button>
      {open &&
        pop.container &&
        createPortal(
          <div className="dd-pop amp-pop is-mono" style={pop.style} ref={list}>
            <label className="amp-search">
              <Search size={13} />
              <input
                ref={input}
                value={query}
                spellCheck={false}
                placeholder="Найти или ввести модель"
                aria-label="Найти модель"
                onChange={(e) => {
                  setQuery(e.target.value);
                  setActive(0);
                }}
                onKeyDown={onKey}
              />
            </label>
            <div role="listbox" aria-label="Агент и модель">
              {sections.length === 0 && <div className="dd-empty">Ничего не найдено</div>}
              {sections.map((s) => (
                <div key={s.agent} role="group" aria-label={s.agent} className="amp-group">
                  <div className="amp-head">
                    {s.agent}
                    {missing(s.agent) && <em> · не найден</em>}
                  </div>
                  {s.items.map((i) => {
                    const idx = ++n;
                    const on = isOn(i);
                    return (
                      <button
                        key={`${i.custom ? '+' : ''}${i.model}`}
                        type="button"
                        role="option"
                        data-i={idx}
                        aria-selected={on}
                        className={`dd-opt ${idx === active ? 'is-active' : ''} ${on ? 'is-on' : ''}`}
                        onMouseEnter={() => setActive(idx)}
                        onMouseDown={(e) => e.preventDefault()}
                        onClick={() => pick(i)}
                      >
                        <span className="dd-opt-text">
                          <span className={`dd-opt-label ${i.model ? '' : 'is-ui'}`}>
                            {i.custom ? `Своя: ${i.model}` : i.model || 'по умолчанию'}
                          </span>
                          {i.option?.hint ? (
                            <span className="dd-opt-hint">{i.option.hint}</span>
                          ) : (
                            !i.model && i.agent === agent && fallback && <span className="dd-opt-hint">{fallback}</span>
                          )}
                        </span>
                        {i.option?.badge && (
                          <span className="dd-badge" title={i.option.badgeTitle}>
                            {i.option.badge}
                          </span>
                        )}
                        {on && <Check size={14} className="dd-opt-check" />}
                      </button>
                    );
                  })}
                </div>
              ))}
            </div>
          </div>,
          pop.container,
        )}
      {gate && <SubscriptionGate model={gate.model} onClose={() => setGate(null)} onEnabled={() => onPick(gate.agent, gate.model)} />}
    </>
  );
}
