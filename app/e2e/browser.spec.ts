import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { expect, test } from '@playwright/test';
import { launch, makeSandbox, quit } from './harness';

test('browser: phone mode settles after one reload and returns to desktop', async () => {
  const hits: string[] = [];
  const server = http.createServer((req, res) => {
    hits.push(req.headers['user-agent'] ?? '');
    res.writeHead(200, { 'content-type': 'text/html' }).end('<h1>probe</h1>');
  });
  await new Promise<void>((ok) => server.listen(0, '127.0.0.1', ok));
  const port = (server.address() as AddressInfo).port;
  const box = makeSandbox();
  const l = await launch(box);
  try {
    const page = l.page;
    await page.getByRole('button', { name: 'Создать', exact: true }).click();
    await page.getByRole('menuitem', { name: /Чат/ }).click();
    await page.locator('.chat-compose textarea').fill('Привет');
    await page.keyboard.press('Enter');
    await page.locator('.chat-msg.is-assistant').waitFor();
    await page.getByRole('button', { name: 'Браузер', exact: true }).first().click();
    const side = page.locator('.chat-side');
    if (await side.getByRole('tab', { name: /Браузер/ }).count()) await side.getByRole('tab', { name: /Браузер/ }).click();
    await side.getByLabel('Адрес').fill(`127.0.0.1:${port}`);
    await side.getByRole('button', { name: 'Открыть адрес' }).click();
    const view = side.locator('webview');
    await expect
      .poll(() => view.evaluate((w: Electron.WebviewTag) => !w.isLoading() && w.getURL()), { timeout: 15_000 })
      .toContain(String(port));
    expect(hits).toHaveLength(1);

    await side.getByRole('radio', { name: 'Телефон' }).click();
    await expect.poll(() => hits.length).toBe(2);
    await page.waitForTimeout(400);
    expect(hits).toHaveLength(2);
    expect(hits[1]).toContain('iPhone');
    await side.getByRole('radio', { name: 'Телефон' }).click();
    await page.waitForTimeout(200);
    expect(hits).toHaveLength(2);

    await side.getByRole('radio', { name: 'Десктоп' }).click();
    await expect.poll(() => hits.length).toBe(3);
    await page.waitForTimeout(400);
    expect(hits).toHaveLength(3);
    expect(hits[2]).not.toContain('iPhone');

    // Вкладки: «+» — новая пустая вкладка, адрес загружается в ней; закрыть — остаётся первая.
    await side.getByRole('button', { name: 'Новая вкладка' }).click();
    await expect(side.locator('webview')).toHaveCount(2);
    await expect(side.getByLabel('Адрес')).toHaveValue('');
    await side.getByLabel('Адрес').fill(`127.0.0.1:${port}/second`);
    await side.getByLabel('Адрес').press('Enter');
    await expect.poll(() => hits.length).toBe(4);
    await expect(side.getByRole('tab')).toHaveCount(2);
    await side
      .getByRole('button', { name: /^Закрыть вкладку/ })
      .last()
      .click();
    await expect(side.locator('webview')).toHaveCount(1);

    // Closing the manual page removes its webview. Phone mode stays selected when a new one mounts.
    await side.getByRole('radio', { name: 'Телефон' }).click();
    await expect.poll(() => hits.length).toBe(5);
    // Закрыли последнюю вкладку — снова начальная карточка.
    await side.getByRole('button', { name: /^Закрыть вкладку/ }).click();
    await expect(view).toHaveCount(0);
    await side.getByRole('button', { name: 'Открыть адрес' }).click();
    await expect.poll(() => hits.length).toBe(7);
    await page.waitForTimeout(400);
    expect(hits).toHaveLength(7);
    expect(hits[6]).toContain('iPhone');
    expect(l.errors).toEqual([]);
  } finally {
    await quit(l);
    box.cleanup();
    server.close();
  }
});
