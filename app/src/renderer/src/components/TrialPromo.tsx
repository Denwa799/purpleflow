// Реклама стартового баланса PurpleSchool: токены в подарок за регистрацию и подтверждение почты.
import { ArrowRight } from 'lucide-react';

/** Условия программы — как на сервере (ai-proxy-initial-balance). Поменяются там — поправить здесь. */
export const TRIAL = { units: '500 000', days: 7 };

/** Плашка слева от формы входа; onRegister — переключить форму на регистрацию (нет — кнопку не показываем). */
export function TrialBanner({ onRegister }: { onRegister?: () => void }) {
  return (
    <section className="trial-banner" aria-label="Стартовый баланс">
      <span className="trial-banner-kicker">Стартовый баланс</span>
      <strong className="trial-banner-amount">
        {TRIAL.units} <span>токенов</span>
      </strong>
      <span className="trial-banner-text">Бесплатно на {TRIAL.days} дней после подтверждения почты</span>
      {onRegister && (
        <button type="button" className="trial-banner-cta" onClick={onRegister}>
          Зарегистрироваться <ArrowRight size={14} />
        </button>
      )}
    </section>
  );
}
