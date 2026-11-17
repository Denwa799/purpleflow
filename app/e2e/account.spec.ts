// Аккаунт PurpleSchool против фейкового API: регистрация, подтверждение почты кодом, стартовый баланс и пробный режим.
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { expect, test } from '@playwright/test';
import { launch, makeSandbox, quit, type Launched, type Sandbox } from './harness';

let box: Sandbox;
let l: Launched;
let api: http.Server;
let calls: string[];

const EMAIL = 'new@ya.ru';
const OFFER = {
  initialUnits: '500000',
  validityDays: 7,
  models: [
    { provider: 'ANTHROPIC', modelName: 'claude-haiku-5-5', displayName: 'Claude Haiku 5.5' },
    { provider: 'OPENAI', modelName: 'gpt-6-luna', displayName: 'GPT-6 Luna' },
  ],
};
const GRANT = {
  grantId: 1,
  initialUnits: '500000',
  remainingUnits: '500000',
  startsAt: '2026-11-17T12:00:00.000Z',
  expiresAt: '2026-11-24T12:00:00.000Z',
};

const KEY = { id: 1, name: 'PurpleFlow', proxyKey: 'sk-test-abcd', effectiveStatus: 'ACTIVE', createdAt: GRANT.startsAt, lastUsedAt: null };

function fakeApi() {
  const state = { verified: false, granted: false, key: false };
  const token = `h.${Buffer.from(JSON.stringify({ email: EMAIL })).toString('base64url')}.s`;
  return http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const route = `${req.method} ${(req.url ?? '').split('?')[0]}`;
      calls.push(route);
      const json = (data: unknown, status = 200) => res.writeHead(status, { 'Content-Type': 'application/json' }).end(JSON.stringify(data));
      switch (route) {
        case 'POST /auth/register':
          return json({ accessToken: token });
        case 'GET /user/profile':
          return json({ profile: { name: 'Тест' } });
        // Ключей у нового аккаунта нет — появится, когда окно создаст его после начисления.
        case 'GET /public/ai-proxy/api-keys':
          return json({ items: state.key ? [KEY] : [], activeKeysLimit: 10 });
        case 'POST /public/ai-proxy/api-keys':
          state.key = true;
          return json(KEY);
        case 'GET /public/ai-proxy/info-v2':
          return json({
            initialBalance: {
              status: state.granted ? 'ACTIVE' : 'AVAILABLE',
              canShowPopup: !state.granted,
              email: EMAIL,
              isEmailVerified: state.verified,
              offer: OFFER,
              grant: state.granted ? GRANT : null,
            },
          });
        case 'POST /email-verification/request':
          return json({
            email: EMAIL,
            isVerified: state.verified,
            expiredAt: new Date(Date.now() + 15 * 60_000).toISOString(),
            resendAvailableAt: new Date(Date.now() + 60_000).toISOString(),
            attemptsRemaining: 5,
          });
        case 'POST /email-verification/confirm':
          if ((JSON.parse(body || '{}') as { code?: string }).code !== '123456')
            return json({ statusCode: 400, message: 'Неверный код подтверждения' }, 400);
          state.verified = true;
          return json({ email: EMAIL, isVerified: true, expiredAt: null, resendAvailableAt: null, attemptsRemaining: 0 });
        case 'POST /public/ai-proxy/initial-balance/claim':
          if (!state.verified) return json({ statusCode: 403, message: 'Почта не подтверждена' }, 403);
          state.granted = true;
          return json(GRANT);
        case 'GET /public/ai-proxy/overview':
          return json({
            balance: {
              totalInitialUnits: '500000',
              usedUnits: '0',
              usedPercentage: 0,
              remainingUnits: state.granted ? '500000' : '0',
              nonRolloverRemainingUnits: '0',
              averageDailyUnitsSpend: '0',
              estimatedRemainingDays: null,
              initialBalanceGrant: state.granted ? GRANT : null,
            },
            currentPlan: null,
          });
        default:
          return json({ statusCode: 404, message: 'Not Found' }, 404);
      }
    });
  });
}

test.beforeEach(async () => {
  calls = [];
  api = fakeApi();
  await new Promise<void>((r) => api.listen(0, '127.0.0.1', r));
  box = makeSandbox({ settings: { enabledAgents: ['claude', 'codex'] } });
  l = await launch(box, { PURPLEFLOW_API_URL: `http://127.0.0.1:${(api.address() as AddressInfo).port}` });
});

test.afterEach(async () => {
  const errors = l.errors;
  await quit(l);
  api.close();
  box.cleanup();
  expect(errors, 'необработанные ошибки страницы').toEqual([]);
});

const saved = () => JSON.parse(fs.readFileSync(path.join(box.profile, 'settings.json'), 'utf8')) as { models?: Record<string, string> };

test('регистрация → подтверждение почты кодом → стартовый баланс и пробный режим моделей', async () => {
  const p = l.page;
  await p.getByRole('button', { name: 'Настройки' }).click();
  await p.getByRole('region', { name: 'Стартовый баланс' }).getByRole('button', { name: 'Зарегистрироваться' }).click();
  await p.getByLabel('Имя').fill('Тест');
  await p.getByLabel('Email').fill(EMAIL);
  await p.getByLabel('Пароль').fill('password123');
  const submit = p.locator('form.auth').getByRole('button', { name: 'Зарегистрироваться' });
  // Без согласия с соглашением регистрация не уходит на сервер.
  await submit.click();
  await expect(p.getByRole('alert')).toContainText('пользовательским соглашением');
  expect(calls).not.toContain('POST /auth/register');
  await p.getByRole('checkbox', { name: /Пользовательским соглашением/ }).check();
  await submit.click();

  // Сразу после регистрации — новый ключ (своих у аккаунта нет) и включённая работа через PurpleSchool.
  await expect(p.getByRole('button', { name: 'Подтвердить почту' })).toBeVisible();
  expect(calls).toContain('POST /public/ai-proxy/api-keys');
  await expect(p.getByRole('switch', { name: 'Работать через PurpleSchool' })).toHaveAttribute('aria-checked', 'true');

  // Вошли: блок стартового баланса, код с ошибкой, затем верный — токены начислены, роли переведены на пробные модели.
  await p.getByRole('button', { name: 'Подтвердить почту' }).click();
  await expect(p.getByText(`Код отправили на ${EMAIL}`)).toBeVisible();
  await expect(p.getByRole('button', { name: /Отправить ещё раз через \d+ с/ })).toBeDisabled();
  if (process.env.PF_SHOT) await p.locator('.acc-card').screenshot({ path: `${process.env.PF_SHOT}-code.png` });
  const code = p.getByLabel('Код из письма');
  await code.fill('111111');
  await expect(p.getByRole('alert')).toContainText('Неверный код подтверждения');
  await code.fill('123456');
  await expect(p.getByText('Стартовый баланс начислен: 500 000 токенов')).toBeVisible();
  expect(calls).toContain('POST /public/ai-proxy/initial-balance/claim');
  if (process.env.PF_SHOT) await p.locator('.acc-card').screenshot({ path: `${process.env.PF_SHOT}-done.png` });
  await expect.poll(() => saved().models?.executor).toBe('claude-haiku-5-5');
  expect(saved().models?.reviewer).toBe('gpt-6-luna');

  // Пробный режим: пресеты и модели закрыты.
  await p.getByRole('tab', { name: 'Модели' }).click();
  await expect(p.getByText('Все роли — на Claude Haiku 5.5 и GPT-6 Luna')).toBeVisible();
  await expect(p.getByRole('button', { name: 'Быстрая настройка' })).toBeDisabled();
  await expect(p.getByLabel('Модель: Исполнитель')).toBeDisabled();
  if (process.env.PF_SHOT)
    await p
      .locator('.panel')
      .first()
      .screenshot({ path: `${process.env.PF_SHOT}-models.png` });
});
