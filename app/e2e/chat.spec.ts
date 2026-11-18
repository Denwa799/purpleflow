// Чат: режим, агент и модель под полем ввода; ответ с таблицей и блоком кода с подсветкой и копированием.
import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { launch, makeSandbox, quit } from './harness';

test('чат: панель под полем ввода, таблица и блок кода в ответе', async () => {
  const box = makeSandbox();
  const l = await launch(box);
  const { page } = l;
  try {
    await page.getByRole('button', { name: /Создать/ }).click();
    await page.getByRole('menuitem', { name: /Чат/ }).click();

    const bar = page.locator('.chat-compose-bar');
    await expect(bar.getByRole('radio', { name: 'Правки' })).toHaveAttribute('aria-checked', 'true');
    await bar.getByRole('radio', { name: 'Вопросы' }).click();
    await expect(bar.getByRole('radio', { name: 'Вопросы' })).toHaveAttribute('aria-checked', 'true');
    // Агент и модель — одна кнопка; своей модели у чата нет — на ней модель по умолчанию из настроек, а не пустота.
    const picker = bar.getByRole('button', { name: 'Агент и модель' });
    await expect(picker).toHaveText(/claude\s*·\s*sonnet/);
    await expect(picker.locator('.amp-model')).toHaveClass(/is-default/);
    // Список разбит на разделы по включённым агентам; выбор модели выбирает и агента.
    await picker.click();
    const pop = page.locator('.amp-pop');
    await expect(pop.getByRole('group', { name: 'claude' })).toBeVisible();
    await expect(pop.getByRole('group', { name: 'codex' })).toBeVisible();
    if (process.env.PURPLEFLOW_SHOTS) {
      await page.waitForTimeout(300);
      await page.screenshot({ path: path.join(box.root, '..', 'pf-chat-picker.png') });
    }
    await pop.getByRole('group', { name: 'codex' }).getByRole('option').nth(1).click();
    await expect(picker).toHaveText(/codex\s*·\s*gpt/);
    // Поиск: своё имя модели у текущего агента.
    await picker.click();
    await pop.getByLabel('Найти модель').fill('my-model');
    await pop.getByLabel('Найти модель').press('Enter');
    await expect(picker).toHaveText(/codex\s*·\s*my-model/);
    // Назад на claude по умолчанию.
    await picker.click();
    await pop.getByRole('group', { name: 'claude' }).getByRole('option', { name: 'по умолчанию' }).click();
    await expect(picker).toHaveText(/claude\s*·\s*sonnet/);

    await page.locator('.chat-compose textarea').fill('Как устроены контейнеры?');
    await page.keyboard.press('Enter');

    const answer = page.locator('.chat-msg.is-assistant');
    await expect(answer.locator('.md-table table td', { hasText: 'cgroups' })).toBeVisible({ timeout: 30_000 });
    const code = answer.locator('.md-code');
    await expect(code.locator('.md-code-lang')).toHaveText('ts');
    await expect(code.locator('.hljs-keyword', { hasText: 'const' })).toBeVisible();

    // «Копировать» — иконка; после клика — галочка и текст блока в буфере.
    const copy = code.getByRole('button', { name: 'Копировать' });
    await expect(copy.locator('svg.md-copy-icon')).toHaveCount(1);
    await code.hover();
    await copy.click();
    await expect(copy).toHaveClass(/is-done/);
    await expect(copy.locator('svg.md-copy-done')).toBeVisible();
    expect(await l.app.evaluate(({ clipboard }) => clipboard.readText())).toBe('const a: number = 1;');
    // Чат был в режиме «Вопросы»: агенту ушёл только набор инструментов для чтения.
    expect(box.calls().at(-1)?.args.join(' ')).toMatch(/--tools Read,Grep,Glob,WebSearch,WebFetch/);
    expect(box.calls().at(-1)?.args.join(' ')).toMatch(/--model sonnet/);

    // Свёрнутая панель показывает заполнение контекста; по клику — вкладка «Сессия».
    const rail = page.getByRole('button', { name: 'Сессия' });
    await expect(rail).toContainText('25%');
    await rail.click();
    const ses = page.locator('.ses');
    await expect(ses.locator('.ses-ctx-num')).toHaveText('50 тыс. из 200 тыс.');
    await expect(ses).toContainText('занято 25% окна модели');
    await expect(ses.locator('.ses-mcp li', { hasText: 'github' })).toContainText('подключён');
    await expect(ses.getByText('Вопросы — только чтение')).toBeVisible();
    await expect(ses.getByText('fake')).toBeVisible();

    // «Сжать контекст»: /compact в той же сессии, в ленте — уведомление, заполнение — после сжатия.
    await ses.getByRole('button', { name: 'Сжать контекст' }).click();
    await expect(page.locator('.chat-msg.is-assistant').last()).toContainText('Контекст переписки сжат (50 тыс. → 9 тыс. токенов)');
    await expect(ses.locator('.ses-ctx-num')).toHaveText('9 тыс. из 200 тыс.');
    await expect(ses.getByText('В этой сессии контекст уже сжимался.')).toBeVisible();
    expect(box.calls().at(-1)?.prompt).toBe('/compact');
    expect(box.calls().at(-1)?.args.join(' ')).toMatch(/--resume /);
  } finally {
    await quit(l);
    box.cleanup();
  }
});

test('чат: «@» подставляет файл проекта, «/» — скилл; агенту уходят их пути', async () => {
  const box = makeSandbox();
  const skill = path.join(box.repo, '.claude', 'skills', 'review', 'SKILL.md');
  fs.mkdirSync(path.dirname(skill), { recursive: true });
  fs.writeFileSync(skill, '---\ndescription: Ревью по чек-листу\n---\n');
  const l = await launch(box);
  const { page } = l;
  try {
    await page.getByRole('button', { name: /Создать/ }).click();
    await page.getByRole('menuitem', { name: /Чат/ }).click();
    // Проект — через «Выбрать папку…»: системный диалог в обвязке отвечает папкой песочницы.
    await page.getByRole('button', { name: 'Проект', exact: true }).click();
    await page.getByRole('option', { name: /Выбрать папку/ }).click();
    await expect(page.getByRole('heading', { name: /Спросите о demo/ })).toBeVisible();

    const input = page.locator('.chat-compose textarea');
    await input.click();
    await page.keyboard.type('/re');
    const skills = page.getByRole('listbox', { name: 'Скиллы' });
    await expect(skills.getByRole('option', { name: /\/review.*Ревью по чек-листу.*проект/ })).toBeVisible();
    await page.keyboard.press('Enter');
    await expect(input).toHaveValue('/review ');

    await page.keyboard.type('@mat');
    const files = page.getByRole('listbox', { name: 'Файлы проекта' });
    await expect(files.getByRole('option', { name: /math\.js/ })).toBeVisible();
    // Escape закрывает список, а следующая буква снова его открывает.
    await page.keyboard.press('Escape');
    await expect(files).toHaveCount(0);
    await page.keyboard.type('h');
    await expect(files.getByRole('option', { name: /math\.js/ })).toBeVisible();
    await page.keyboard.press('Tab');
    await expect(input).toHaveValue('/review @src/math.js ');

    await page.keyboard.type('что тут?');
    await page.keyboard.press('Enter');
    await expect(page.locator('.chat-msg.is-user')).toContainText('/review @src/math.js что тут?');
    await expect.poll(() => box.calls().at(-1)?.prompt ?? '').toContain(`- /review: ${skill}`);
    expect(box.calls().at(-1)!.prompt).toContain(`- ${path.join(box.repo, 'src', 'math.js')}`);

    // «Сессия»: скиллы рядом с MCP; незакоммиченный помечен — прогон в отдельной копии его не увидит.
    await page.getByRole('button', { name: 'Сессия' }).click();
    const ses = page.locator('.ses-skills');
    await expect(ses.locator('li').filter({ has: page.locator('.skill-name', { hasText: /^review$/ }) })).toContainText('не в git');

    // Экран проекта: те же скиллы и какие агенты найдут их сами.
    await page.getByRole('button', { name: 'Проекты' }).click();
    await page.getByRole('button', { name: 'Открыть папку…' }).click();
    await page.getByRole('tab', { name: 'Обзор' }).click();
    const panel = page.locator('.overview-skills');
    await expect(panel.locator('li').filter({ has: page.locator('.skill-name', { hasText: /^review$/ }) })).toContainText(
      'Ревью по чек-листу',
    );
    await expect(panel.locator('li').filter({ has: page.locator('.skill-name', { hasText: /^review$/ }) })).toContainText('claude');
    if (process.env.PF_SHOT) {
      await panel.scrollIntoViewIfNeeded();
      await page.screenshot({ path: process.env.PF_SHOT });
    }
    expect(l.errors).toEqual([]);
  } finally {
    await quit(l);
    box.cleanup();
  }
});

test('чат: уровень рассуждений рядом с моделью уходит claude флагом --effort', async () => {
  const box = makeSandbox();
  const l = await launch(box);
  const { page } = l;
  try {
    await page.getByRole('button', { name: /Создать/ }).click();
    await page.getByRole('menuitem', { name: /Чат/ }).click();
    const effort = page.getByRole('button', { name: 'Уровень рассуждений' });
    // По умолчанию — как в CLI: флаг не передаётся.
    await expect(effort).toContainText('как в CLI');
    await effort.click();
    await page.getByRole('option', { name: /^high/ }).click();
    await expect(effort).toContainText('high');
    if (process.env.PURPLEFLOW_SHOTS) await page.screenshot({ path: path.join(box.root, '..', 'pf-chat-effort.png') });

    const input = page.locator('.chat-compose textarea');
    await input.fill('подумай');
    await input.press('Enter');
    await expect(page.locator('.chat-msg.is-user')).toContainText('подумай');
    await expect.poll(() => box.calls().at(-1)?.args.join(' ') ?? '').toContain('--effort high');

    // В настройках — тот же выбор у каждой роли на claude.
    await page.getByRole('button', { name: 'Настройки' }).click();
    await page.getByRole('tab', { name: 'Модели' }).click();
    await expect(page.getByRole('button', { name: 'Уровень рассуждений: Исполнитель' })).toContainText('как в CLI');
    expect(l.errors).toEqual([]);
  } finally {
    await quit(l);
    box.cleanup();
  }
});

test('проект: кнопка «Чат» открывает новый чат с этим проектом, а на «Обзоре» — чаты проекта', async () => {
  const box = makeSandbox();
  const l = await launch(box);
  const { page } = l;
  try {
    await page.getByRole('button', { name: 'Проекты' }).click();
    await page.getByRole('button', { name: 'Открыть папку…' }).click();
    await page.getByRole('button', { name: 'Чат', exact: true }).click();
    // Проект уже выбран — не нужно искать его в списке.
    await expect(page.getByRole('button', { name: 'Проект', exact: true })).toContainText('demo');
    await expect(page.getByRole('heading', { name: /Спросите о demo/ })).toBeVisible();

    const input = page.locator('.chat-compose textarea');
    await input.fill('что тут?');
    await input.press('Enter');
    await expect(page.locator('.chat-msg.is-user')).toContainText('что тут?');

    await page.getByRole('button', { name: 'Проекты' }).click();
    await page.getByRole('button', { name: 'Открыть папку…' }).click();
    await page.getByRole('tab', { name: 'Обзор' }).click();
    const chats = page.locator('.overview-chats');
    await expect(chats.getByRole('button')).toHaveCount(1);
    await chats.getByRole('button').click();
    await expect(page.locator('.chat-msg.is-user')).toContainText('что тут?');
    expect(l.errors).toEqual([]);
  } finally {
    await quit(l);
    box.cleanup();
  }
});

test('чат: «Указать элемент» в браузере вставляет описание элемента в поле ввода', async () => {
  const page0 = `<!doctype html><html><body style="margin:0;font:16px sans-serif">
    <main><section class="hero"><a class="btn btn-primary" href="/signup" style="display:inline-block;margin:120px;padding:20px 40px;background:#fcc">Создать</a></section></main>
    <script>document.querySelector('a').addEventListener('click', () => { document.title = 'clicked'; });</script>
  </body></html>`;
  const server = http.createServer((_q, r) => r.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(page0));
  await new Promise<void>((ok) => server.listen(0, '127.0.0.1', ok));
  const port = (server.address() as AddressInfo).port;
  const box = makeSandbox();
  const l = await launch(box);
  const { page } = l;
  try {
    await page.getByRole('button', { name: /Создать/ }).click();
    await page.getByRole('menuitem', { name: /Чат/ }).click();
    const input = page.locator('.chat-compose textarea');
    await input.fill('Привет');
    await page.keyboard.press('Enter');
    await expect(page.locator('.chat-msg.is-assistant')).toBeVisible({ timeout: 30_000 });

    await page.getByRole('button', { name: 'Браузер' }).first().click();
    const side = page.locator('.chat-side');
    if (await side.getByRole('tab', { name: /Браузер/ }).count()) await side.getByRole('tab', { name: /Браузер/ }).click();
    await side.getByLabel('Адрес').fill(`127.0.0.1:${port}`);
    await side.getByRole('button', { name: 'Открыть адрес' }).click();
    const view = side.locator('webview');
    await expect(view).toBeVisible();
    // Ждём, пока страница внутри webview загрузится.
    await expect
      .poll(() => view.evaluate((w: Electron.WebviewTag) => !w.isLoading() && w.getURL()), { timeout: 15_000 })
      .toContain(String(port));

    await input.fill('Сделай кнопку синей');
    await side.getByRole('button', { name: 'Указать элемент' }).click();
    await expect(side.getByText(/Наведите на элемент/)).toBeVisible();
    // Кнопка на странице — с отступом 120 px от угла webview; клик выбирает её, а не нажимает.
    const vb = (await view.boundingBox())!;
    await page.mouse.move(vb.x + 150, vb.y + 140);
    await page.mouse.move(vb.x + 160, vb.y + 145);
    await page.mouse.click(vb.x + 160, vb.y + 145);

    await expect(input).toHaveValue(/^Сделай кнопку синей\n\nЭлемент на странице 127\.0\.0\.1:\d+: <a\.btn\.btn-primary> «Создать»\n/);
    const value = await input.inputValue();
    expect(value).toContain('- селектор: main > section.hero > a.btn.btn-primary');
    expect(value).toContain('- ссылка: /signup');
    expect(value.endsWith('\n\n')).toBe(true);
    await expect(side.getByText(/Наведите на элемент/)).toBeHidden();
    // Клик ушёл в выбор, а не в обработчик страницы.
    expect(await view.evaluate((w: Electron.WebviewTag) => w.getTitle())).not.toBe('clicked');
  } finally {
    await quit(l);
    box.cleanup();
    server.close();
  }
});

test('чат: вкладка «Запуск» — старт, вывод сервера, браузер и стоп без просьб агенту', async () => {
  const box = makeSandbox();
  fs.writeFileSync(
    path.join(box.repo, 'server.cjs'),
    "const http = require('http');\nconsole.log('сервер стартует');\nhttp.createServer((q, s) => { console.log('запрос ' + q.url); s.end('<h1>demo app</h1>'); }).listen(process.env.PORT, '127.0.0.1');\n",
  );
  const l = await launch(box);
  const { page } = l;
  try {
    await page.evaluate(
      (repo) =>
        (
          window as unknown as { purpleflow: { core: { saveProjectConfig(dir: string, cfg: object): Promise<unknown> } } }
        ).purpleflow.core.saveProjectConfig(repo, {
          setupCommand: '',
          lintCommand: '',
          testCommand: '',
          runCommand: 'node server.cjs',
          appUrl: 'http://127.0.0.1:{port}/',
          notes: { setup: '', lint: '', test: '' },
        }),
      box.repo,
    );
    await page.getByRole('button', { name: /Создать/ }).click();
    await page.getByRole('menuitem', { name: /Чат/ }).click();
    await page.getByRole('button', { name: 'Проект', exact: true }).click();
    await page.getByRole('option', { name: /Выбрать папку/ }).click();
    await page.locator('.chat-compose textarea').fill('Привет');
    await page.keyboard.press('Enter');
    await expect(page.locator('.chat-msg.is-assistant')).toBeVisible({ timeout: 30_000 });

    const side = page.locator('.chat-side');
    if (!(await side.getByRole('tab', { name: /Запуск/ }).count())) await page.locator('.manager-rail').click();
    await side.getByRole('tab', { name: /Запуск/ }).click();
    await expect(side.getByRole('status')).toHaveText('Не запущено');
    await expect(side.getByText('node server.cjs')).toBeVisible();

    await side.getByRole('button', { name: 'Запустить' }).click();
    await expect(side.getByRole('status')).toHaveText('Работает', { timeout: 30_000 });
    await expect(side.getByLabel('Вывод сервера')).toContainText('сервер стартует');
    const url = (await side.locator('.chat-run-code').nth(1).textContent())!;
    expect(url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/$/);
    expect(await (await fetch(url)).text()).toContain('demo app');
    // Вывод обновляется, пока сервер работает.
    await expect(side.getByLabel('Вывод сервера')).toContainText('запрос /');

    await side.getByRole('button', { name: 'В браузере' }).click();
    await expect(side.locator('webview')).toBeVisible();
    await side.getByRole('tab', { name: /Запуск/ }).click();
    await side.getByRole('button', { name: 'Остановить' }).click();
    await expect(side.getByRole('status')).toHaveText('Не запущено');
    await expect
      .poll(() =>
        fetch(url).then(
          () => 'up',
          () => 'down',
        ),
      )
      .toBe('down');
  } finally {
    await quit(l);
    box.cleanup();
  }
});
