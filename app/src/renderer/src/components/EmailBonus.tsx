// Стартовый баланс после входа: подтверждение почты кодом и начисление токенов.
import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { CheckCircle2, Mail } from 'lucide-react';
import type { EmailVerification, InitialBalance, InitialBalanceGrant } from '../../../shared/ipc';
import { bridge } from '../lib/api';
import { isTrialSetup, trialSetup } from '../lib/presets';
import { refreshTrial } from '../lib/trial';
import { useStore } from '../lib/store';
import { Button, Input } from './ui';

const units = (v: string) => (/^\d+$/.test(v) ? Number(v).toLocaleString('ru-RU') : v);
const day = (iso: string) => new Date(iso).toLocaleDateString('ru-RU', { day: 'numeric', month: 'long' });

/** Сколько секунд до повторной отправки кода; тикает раз в секунду. */
function useCountdown(until: string | null): number {
  const [now, setNow] = useState(() => Date.now());
  const end = until ? Date.parse(until) : 0;
  useEffect(() => {
    if (!end || end <= Date.now()) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [end]);
  return Math.max(0, Math.ceil((end - now) / 1000));
}

/**
 * Блок в карточке аккаунта. Ничего не рисует, пока сервер не сказал, что бонус доступен или уже начислен:
 * старый сервер, неподходящая почта и закончившийся период — без блока.
 */
export function EmailBonus() {
  const { state, saveSettings, reloadSettings } = useStore();
  const settings = state.settings;
  /** Галочка «перевести агентов»: на пробном балансе прокси пускает только модели программы. */
  const [switchAgents, setSwitchAgents] = useState(true);
  const [switched, setSwitched] = useState(false);
  const [connected, setConnected] = useState(false);
  const [info, setInfo] = useState<InitialBalance | null>(null);
  const [sent, setSent] = useState<EmailVerification | null>(null);
  const [granted, setGranted] = useState<InitialBalanceGrant | null>(null);
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState<'send' | 'confirm' | 'claim' | null>(null);
  const [error, setError] = useState('');
  const wait = useCountdown(sent?.resendAvailableAt ?? null);

  const load = useCallback(async () => {
    const r = await bridge.account.initialBalance();
    if (r.ok) setInfo(r.data);
  }, []);
  useEffect(() => {
    void load();
  }, [load]);

  const plan = settings && info ? trialSetup(settings.enabledAgents, settings.agents, info.offer.models) : null;
  const applyTrial = async () => {
    if (!plan) return;
    await saveSettings({ agents: plan.agents, models: plan.models });
    setSwitched(true);
  };

  /**
   * Чтобы токены сразу пошли в дело: ключа нет — подставляем активный из аккаунта или создаём новый; ключ есть, но
   * выключен — включаем «Работать через PurpleSchool». Сбой здесь начисление не отменяет — ключ можно выбрать ниже.
   */
  const connectProxy = async () => {
    const p = state.settings?.proxy;
    if (p?.hasKey) {
      if (p.enabled) return;
      await saveSettings({ proxy: { enabled: true } });
      return setConnected(true);
    }
    const auto = await bridge.account.autoKey();
    const made = auto.ok && auto.data === 'none' ? await bridge.account.createKey() : auto;
    const s = await reloadSettings();
    setConnected(made.ok && s.proxy.hasKey);
  };

  const claim = async () => {
    setBusy('claim');
    setError('');
    try {
      const r = await bridge.account.claimInitialBalance();
      if (!r.ok) return setError(r.error);
      setGranted(r.data);
      await connectProxy().catch(() => {});
      refreshTrial();
      if (switchAgents) await applyTrial();
      void load();
    } finally {
      setBusy(null);
    }
  };

  const send = async () => {
    setBusy('send');
    setError('');
    try {
      const r = await bridge.account.requestEmailCode();
      if (!r.ok) return setError(r.error);
      if (r.data.isVerified) return void (await claim());
      setSent(r.data);
      setCode('');
    } finally {
      setBusy((b) => (b === 'send' ? null : b));
    }
  };

  const confirm = async (value: string) => {
    if (busy) return;
    setBusy('confirm');
    setError('');
    try {
      const r = await bridge.account.confirmEmailCode(value);
      if (!r.ok) {
        setCode('');
        return setError(r.error);
      }
      if (r.data.isVerified) await claim();
    } finally {
      setBusy((b) => (b === 'confirm' ? null : b));
    }
  };

  const trialNames = info?.offer.models.map((m) => m.displayName).join(' и ') ?? '';
  const onTrial = Boolean(settings && info && isTrialSetup(settings.models, info.offer.models));
  const grant = granted ?? (info?.status === 'ACTIVE' ? info.grant : null);
  if (grant)
    return (
      <div className="acc-bonus is-done" role="status">
        <CheckCircle2 size={16} />
        <div className="acc-bonus-text">
          <strong>Стартовый баланс начислен: {units(grant.initialUnits)} токенов</strong>
          <span>
            Действует до {day(grant.expiresAt)}. Пока нет подписки, прокси пускает только {trialNames}
            {onTrial ? ' — агенты уже настроены на них.' : '.'}
          </span>
          {connected && <span>Ключ AI-прокси подставлен, работа через PurpleSchool включена.</span>}
          {switched && <span>Роли и модели агентов переведены на пробный режим.</span>}
          {!onTrial && plan && (
            <div className="acc-bonus-actions">
              <Button tone="ghost" onClick={() => void applyTrial()}>
                Перевести агентов на пробные модели
              </Button>
            </div>
          )}
        </div>
      </div>
    );
  if (info?.status !== 'AVAILABLE') return null;

  const amount = units(info.offer.initialUnits);
  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    if (code.length === 6) void confirm(code);
  };

  return (
    <div className="acc-bonus">
      <span className="trial-banner-kicker">Стартовый баланс</span>
      <strong className="acc-bonus-title">
        {amount} <span>токенов на {info.offer.validityDays} дней</span>
      </strong>
      {info.isEmailVerified ? (
        <>
          <span className="acc-bonus-sub">Почта подтверждена — осталось забрать токены.</span>
          <div className="acc-bonus-actions">
            <Button tone="primary" busy={busy === 'claim'} onClick={() => void claim()}>
              Получить токены
            </Button>
          </div>
        </>
      ) : sent ? (
        <form className="acc-bonus-code" onSubmit={onSubmit}>
          <span className="acc-bonus-sub">
            Код отправили на <strong>{sent.email}</strong>. Он действует 15 минут.
          </span>
          <div className="acc-bonus-actions">
            <Input
              mono
              className="acc-bonus-input"
              inputMode="numeric"
              autoComplete="one-time-code"
              aria-label="Код из письма"
              placeholder="000000"
              maxLength={6}
              autoFocus
              value={code}
              onChange={(e) => {
                const v = e.target.value.replace(/\D/g, '').slice(0, 6);
                setCode(v);
                if (v.length === 6) void confirm(v);
              }}
            />
            <Button tone="primary" type="submit" disabled={code.length !== 6} busy={busy === 'confirm' || busy === 'claim'}>
              Подтвердить
            </Button>
            <button type="button" className="link acc-bonus-resend" disabled={wait > 0 || busy !== null} onClick={() => void send()}>
              {wait > 0 ? `Отправить ещё раз через ${wait} с` : 'Отправить ещё раз'}
            </button>
          </div>
        </form>
      ) : (
        <>
          <span className="acc-bonus-sub">
            Подтвердите почту <strong>{info.email}</strong> — пришлём код, после подтверждения токены начислятся сразу.
          </span>
          <div className="acc-bonus-actions">
            <Button tone="primary" icon={<Mail size={15} />} busy={busy === 'send'} onClick={() => void send()}>
              Подтвердить почту
            </Button>
          </div>
        </>
      )}
      {plan && !onTrial && (
        <label className="auth-check acc-bonus-switch">
          <input type="checkbox" checked={switchAgents} onChange={(e) => setSwitchAgents(e.target.checked)} />
          <span>Сразу перевести агентов на пробные модели — {trialNames}: другие модели на пробном балансе не работают</span>
        </label>
      )}
      {error && (
        <p className="auth-error" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
