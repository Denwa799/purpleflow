import { useEffect, useState } from 'react';
import { ArrowLeft, ArrowRight, Check, LogIn, UserPlus } from 'lucide-react';
import { ACCOUNT_BENEFITS, AccountKeys, AuthForms } from '../components/Account';
import { EmailBonus } from '../components/EmailBonus';
import { Button } from '../components/ui';
import { Mark } from '../components/Sidebar';
import { useStore } from '../lib/store';
import { setupStep } from '../lib/setupUsage';

type Step = 'start' | 'login' | 'register' | 'key';

/**
 * Первый запуск: заставка с выбором «Войти / Зарегистрироваться / Пропустить»,
 * затем страница формы и ключ AI-прокси.
 */
export function WelcomeScreen() {
  const { state, saveSettings, go } = useStore();
  const [step, setStep] = useState<Step>(state.settings?.account ? 'key' : 'start');
  const [leaving, setLeaving] = useState(false);
  // Какой экран входа открыт — для статистики настройки (welcome — заставка).
  useEffect(() => setupStep(step === 'start' ? 'welcome' : step), [step]);

  const next = async () => {
    setLeaving(true);
    try {
      await saveSettings({ authPrompted: true });
      go({ name: 'settings' });
    } finally {
      setLeaving(false);
    }
  };

  return (
    <div className="onboard">
      <div className="onboard-drag drag" aria-hidden />
      {step === 'start' ? (
        <div className="onboard-hero" key="start">
          <div className="onboard-logo">
            <Mark size={68} />
          </div>
          <h1>PurpleFlow</h1>
          <p>
            Задачи проходят план, реализацию, тесты и ревью — claude и codex работают за вас. Войдите через PurpleSchool, чтобы агенты
            работали без VPN.
          </p>
          <div className="onboard-actions">
            <Button tone="primary" icon={<LogIn size={18} />} onClick={() => setStep('login')}>
              Войти через PurpleSchool
            </Button>
            <Button tone="ghost" icon={<UserPlus size={18} />} onClick={() => setStep('register')}>
              Зарегистрироваться
            </Button>
            <Button tone="quiet" busy={leaving} onClick={() => void next()}>
              Пропустить
            </Button>
          </div>
          <p className="onboard-skip-hint">Без входа агенты работают по вашим подпискам. Войти можно позже в настройках.</p>
          <p className="onboard-skip-hint">
            Мы получаем статистику шагов (без кода, задач и путей к проектам) и отчёты об ошибках, чтобы находить, где PurpleFlow мешает;
            после входа через PurpleSchool — вместе с аккаунтом. Отключить можно в настройках, на вкладке «Приложение».
          </p>
          <ul className="onboard-benefits">
            {ACCOUNT_BENEFITS.map((b) => (
              <li key={b.title}>
                <span className="onboard-tick">
                  <Check size={13} />
                </span>
                <div>
                  <strong>{b.title}</strong>
                  <span>{b.text}</span>
                </div>
              </li>
            ))}
          </ul>
        </div>
      ) : (
        <div className="onboard-page" key={step}>
          {step !== 'key' && (
            <button className="onboard-back" onClick={() => setStep('start')}>
              <ArrowLeft size={15} /> Назад
            </button>
          )}
          <div className="onboard-card">
            <div className="onboard-card-mark">
              <Mark size={36} />
            </div>
            {step === 'key' ? (
              <div className="onboard-key">
                <h2>Ключ AI-прокси</h2>
                <p className="auth-sub">
                  Вы вошли
                  {state.settings?.account?.email ? (
                    <>
                      {' '}
                      как <strong>{state.settings.account.email}</strong>
                    </>
                  ) : null}
                  . Агенты ходят в модели по ключу AI-прокси вашего аккаунта.
                </p>
                <EmailBonus />
                <AccountKeys onUnauthorized={() => setStep('login')} />
                <Button tone="primary" icon={<ArrowRight size={15} />} busy={leaving} onClick={() => void next()}>
                  {state.settings?.proxy.hasKey ? 'Продолжить' : 'Продолжить без ключа'}
                </Button>
              </div>
            ) : (
              <AuthForms initial={step} onDone={() => setStep('key')} />
            )}
          </div>
          {step !== 'key' && (
            <button className="link onboard-skip" disabled={leaving} onClick={() => void next()}>
              Пропустить
            </button>
          )}
        </div>
      )}
    </div>
  );
}
