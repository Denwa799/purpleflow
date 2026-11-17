// Автообновление: настоящий electron-updater читает ленту с локального сервера, дальше — состояния из main.
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { expect, test } from '@playwright/test';
import { launch, makeSandbox, quit, type Launched, type Sandbox } from './harness';

let box: Sandbox;
let l: Launched;
let feed: http.Server;
let requested: string[];
let feedBroken: boolean;
let latest: string;
/** Версия, чьё «Что нового» уже видели; пусто — первый запуск. */
let seen = '';

const RELEASES = [
  { version: '0.3.4', date: '2026-11-13T14:00:00Z', notes: '- OpenCode как третий агент', url: '' },
  { version: '0.3.3', date: '2026-11-13T08:00:00Z', notes: '### Добавлено\n\n- Модели Fable', url: '' },
  { version: '0.3.0', date: '2026-11-11T08:00:00Z', notes: '- Старое', url: '' },
];

const LATEST = `version: 99.0.0
files:
  - url: PurpleFlow-99.0.0.zip
    sha512: AAAA
    size: 1
path: PurpleFlow-99.0.0.zip
sha512: AAAA
releaseDate: '2026-11-03T00:00:00.000Z'
`;

test.beforeEach(async () => {
  requested = [];
  feedBroken = false;
  latest = LATEST;
  feed = http.createServer((req, res) => {
    requested.push(req.url ?? '');
    if (feedBroken) res.writeHead(500).end();
    else if (/latest.*\.yml/.test(req.url ?? '')) res.end(latest);
    else res.writeHead(404).end();
  });
  await new Promise<void>((r) => feed.listen(0, '127.0.0.1', r));
  box = makeSandbox({ settings: seen ? { seenVersion: seen } : {} });
  fs.writeFileSync(path.join(box.root, 'releases.json'), JSON.stringify(RELEASES));
  l = await launch(box, {
    PURPLEFLOW_UPDATE_URL: `http://127.0.0.1:${(feed.address() as AddressInfo).port}/`,
    PURPLEFLOW_RELEASES_FILE: path.join(box.root, 'releases.json'),
  });
});

test.afterEach(async () => {
  const errors = l.errors;
  await quit(l);
  feed.close();
  box.cleanup();
  expect(errors, 'необработанные ошибки страницы').toEqual([]);
});

const dialog = () => l.page.getByRole('dialog', { name: /Что нового|Обновились/ });
const offer = () => dialog().getByRole('status', { name: 'Обновление' });
const sideUpdate = () => l.page.locator('.side-whatsnew').getByRole('button', { name: 'Обновить' });

/** Последние шаги зависят от подписи и ОС, поэтому их состояние передаём так же, как это делает main. */
const pushState = (state: object) =>
  l.app.evaluate(({ BrowserWindow }, s) => BrowserWindow.getAllWindows()[0].webContents.send('update:state', s), state);

/** Настоящий пункт меню приложения. */
const clickCheckInMenu = () =>
  l.app.evaluate(({ Menu }) => {
    const find = (items: Electron.MenuItem[]): Electron.MenuItem | undefined =>
      items.flatMap((i) => (i.submenu ? [i, ...i.submenu.items] : [i])).find((i) => i.label === 'Проверить обновления…');
    find(Menu.getApplicationMenu()!.items)!.click();
  });

test('новая версия в ленте: кнопка «Обновить» в боковой панели, без плашки и без окна', async () => {
  await expect(sideUpdate()).toBeVisible();
  expect(requested.some((u) => /latest.*\.yml/.test(u))).toBe(true);
  await expect(dialog()).toHaveCount(0);
  if (process.env.PF_SHOT) await l.page.screenshot({ path: process.env.PF_SHOT.replace('.png', '-side.png') });
  await l.page.getByRole('button', { name: 'Что нового' }).click();
  await expect(offer()).toContainText('Доступна версия 99.0.0');
  await expect(dialog().getByRole('article', { name: 'Версия 0.3.3' })).toContainText('Модели Fable');
  await dialog().getByRole('button', { name: 'Закрыть' }).click();
  await expect(dialog()).toHaveCount(0);
});

test('пункт меню проверяет заново и открывает окно с ответом', async () => {
  await expect(sideUpdate()).toBeVisible();
  await clickCheckInMenu();
  await expect(offer()).toContainText('Доступна версия 99.0.0');
});

test('ручная проверка сообщает, что версия последняя, и показывает сбой', async () => {
  await expect(sideUpdate()).toBeVisible();
  latest = LATEST.replaceAll('99.0.0', '0.0.1');
  await clickCheckInMenu();
  await expect(offer()).toContainText('У вас последняя версия');
  await expect(sideUpdate()).toHaveCount(0);
  feedBroken = true;
  await clickCheckInMenu();
  await expect(offer()).toContainText('Не удалось проверить обновления');
});

test('кнопка в настройках запускает ту же проверку: на Windows и Linux меню не видно', async () => {
  await expect(sideUpdate()).toBeVisible();
  await l.page.getByRole('button', { name: 'Настройки' }).click();
  await l.page.getByRole('tab', { name: 'Приложение' }).click();
  await l.page.getByRole('button', { name: 'Проверить обновления' }).click();
  await expect(offer()).toContainText('Доступна версия 99.0.0');
});

test('готовое обновление предлагает перезапуск, сбой — ручную загрузку', async () => {
  await expect(sideUpdate()).toBeVisible();
  await pushState({ kind: 'ready', version: '99.0.0' });
  await expect(l.page.locator('.side-whatsnew').getByRole('button', { name: 'Перезапустить' })).toBeVisible();
  await l.page.getByRole('button', { name: 'Что нового' }).click();
  await expect(offer().getByRole('button', { name: 'Перезапустить' })).toBeVisible();
  await pushState({ kind: 'failed', version: '99.0.0', message: 'Code signature did not pass validation' });
  await expect(offer()).toContainText('Code signature');
  await expect(offer().getByRole('link', { name: 'Скачать вручную' })).toHaveAttribute('href', /releases\/latest/);
});

test.describe('после обновления', () => {
  test.beforeAll(() => {
    seen = '0.3.0';
  });
  test.afterAll(() => {
    seen = '';
  });

  test('окно открывается само, новые выпуски отмечены; закрыли — больше само не откроется', async () => {
    await expect(dialog()).toBeVisible();
    await expect(dialog().getByRole('heading', { level: 2 })).toContainText('Обновились до 0.3.4');
    await expect(dialog().getByRole('article', { name: 'Версия 0.3.3' })).toContainText('новое');
    await expect(dialog().getByRole('article', { name: 'Версия 0.3.0' })).not.toContainText('новое');
    if (process.env.PF_SHOT) await l.page.screenshot({ path: process.env.PF_SHOT });
    await dialog().getByRole('button', { name: 'Закрыть' }).click();
    await expect.poll(() => JSON.parse(fs.readFileSync(path.join(box.profile, 'settings.json'), 'utf8')).seenVersion).not.toBe('0.3.0');
  });
});
