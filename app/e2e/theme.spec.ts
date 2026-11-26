// Цвет фона окна: темы в «Настройки → Приложение» перекрашивают окно сразу и сохраняются.
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { launch, makeSandbox, quit } from './harness';

test('тема фона: выбор перекрашивает окно и переживает перезапуск', async () => {
  const box = makeSandbox({ settings: { windowGlass: false } });
  let l = await launch(box);
  try {
    let page = l.page;
    const bodyBg = () => page.evaluate(() => getComputedStyle(document.body).backgroundColor);
    // По умолчанию — «Графит».
    await expect.poll(bodyBg).toBe('rgb(37, 37, 39)');
    await page.getByRole('button', { name: 'Настройки', exact: true }).click();
    await page.getByRole('tab', { name: 'Приложение' }).click();
    const pick = page.getByRole('radiogroup', { name: 'Цвет фона' });
    await expect(pick.getByRole('radio')).toHaveCount(6);
    // Здесь всё применяется сразу — кнопки «Сохранить» нет.
    await expect(page.getByRole('button', { name: 'Сохранить', exact: true })).toHaveCount(0);
    await expect(pick.getByRole('radio', { name: 'Графит' })).toHaveAttribute('aria-checked', 'true');
    await pick.getByRole('radio', { name: 'Полночь' }).click();
    await expect(pick.getByRole('radio', { name: 'Полночь' })).toHaveAttribute('aria-checked', 'true');
    await expect.poll(bodyBg).toBe('rgb(28, 33, 48)');
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'midnight');
    if (process.env.PURPLEFLOW_SHOTS) {
      await page.waitForTimeout(600);
      await page.screenshot({ path: path.join(box.root, '..', 'pf-theme.png') });
    }
    expect(l.errors).toEqual([]);

    // Перезапуск: тема уже с первой отрисовки.
    await quit(l);
    l = await launch(box);
    page = l.page;
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'midnight');
    await expect.poll(bodyBg).toBe('rgb(28, 33, 48)');
  } finally {
    await quit(l);
    box.cleanup();
  }
});
