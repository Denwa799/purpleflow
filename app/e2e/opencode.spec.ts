// OpenCode в настройках: включение, модели из `opencode models` и уровни моделей в быстрой настройке.
import fs from 'node:fs';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { launch, makeSandbox, quit, type Launched, type Sandbox } from './harness';

let box: Sandbox;
let l: Launched;

test.afterEach(async () => {
  const errors = l.errors;
  await quit(l);
  box.cleanup();
  expect(errors, 'необработанные ошибки страницы').toEqual([]);
});

/** Фейковый opencode: версия и список моделей провайдеров. */
function fakeOpencode(dir: string): string {
  const bin = path.join(dir, 'opencode');
  fs.writeFileSync(
    bin,
    '#!/bin/sh\nif [ "$1" = "models" ]; then printf "opencode/flash-free\\nopenrouter/strong\\n"; else echo "1.19.6"; fi\n',
    { mode: 0o755 },
  );
  return bin;
}

test('быстрая настройка на opencode: свои модели по уровням расставляются по ролям и запоминаются', async () => {
  box = makeSandbox();
  const settings = path.join(box.profile, 'settings.json');
  const cur = JSON.parse(fs.readFileSync(settings, 'utf8'));
  cur.toolPaths.opencode = fakeOpencode(box.root);
  cur.enabledAgents = ['claude', 'opencode'];
  fs.writeFileSync(settings, JSON.stringify(cur));
  l = await launch(box);

  await l.page.getByRole('button', { name: 'Настройки' }).click();
  await l.page.locator('.settings-tabs').getByText('Модели', { exact: true }).click();
  await l.page.getByRole('button', { name: 'Быстрая настройка' }).click();
  const d = l.page.getByRole('dialog', { name: 'Быстрая настройка' });
  await d.getByRole('radio', { name: 'opencode' }).click();
  await d.getByLabel('Модель opencode: Рабочая').fill('opencode/flash-free');
  await d.getByLabel('Модель opencode: Сильная').fill('openrouter/strong');
  await d.getByRole('heading', { name: 'Быстрая настройка' }).click();
  await expect(d.locator('.qs-row').filter({ hasText: 'Планировщик' })).toContainText('openrouter/strong');
  await expect(d.locator('.qs-row').filter({ hasText: 'Исполнитель' })).toContainText('opencode/flash-free');
  await d.getByRole('button', { name: 'Применить' }).click();
  await expect(d).toBeHidden();

  const saved = JSON.parse(fs.readFileSync(settings, 'utf8'));
  expect(saved.agents.planner).toBe('opencode');
  expect(saved.models.planner).toBe('openrouter/strong');
  expect(saved.models.executor).toBe('opencode/flash-free');

  // Уровни запомнились, а в поле модели роли — модели из `opencode models`.
  await l.page.getByRole('button', { name: 'Быстрая настройка' }).click();
  await l.page.getByRole('dialog', { name: 'Быстрая настройка' }).getByRole('radio', { name: 'opencode' }).click();
  await expect(l.page.getByLabel('Модель opencode: Сильная')).toHaveValue('openrouter/strong');
  await l.page.getByRole('button', { name: 'Отмена' }).click();
  await l.page.getByLabel('Модель: Исполнитель').click();
  await expect(l.page.getByText('openrouter/strong', { exact: true }).first()).toBeVisible();
});
