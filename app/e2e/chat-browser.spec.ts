import { execFile } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { promisify } from 'node:util';
import { chromium, expect, test } from '@playwright/test';
import { launch, makeSandbox, quit } from './harness';

// Браузер чата — настоящие webview окна, общие с агентом через мост CDP (app/src/main/chatweb.ts).

function findPw(dir: string): string | null {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      const r = findPw(p);
      if (r) return r;
    } else if (e.name === 'pw' && dir.endsWith('browser')) return p;
  }
  return null;
}

test('браузер чата: вкладки — настоящие webview, живут при закрытой панели, индикатор загрузки у своей вкладки', async () => {
  const hits: string[] = [];
  const server = http.createServer((req, res) => {
    hits.push(req.url ?? '');
    const slow = req.url?.startsWith('/slow');
    setTimeout(
      () => res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(`<title>T${req.url}</title><h1>${req.url}</h1>`),
      slow ? 2500 : 0,
    );
  });
  await new Promise<void>((ok) => server.listen(0, '127.0.0.1', ok));
  const port = (server.address() as AddressInfo).port;
  const l = await launch(makeSandbox(), { PURPLEFLOW_CHAT_BROWSER: 'on' });
  try {
    const page = l.page;
    await page.getByRole('button', { name: 'Создать', exact: true }).click();
    await page.getByRole('menuitem', { name: /Чат/ }).click();
    await page.locator('.chat-compose textarea').fill('Привет');
    await page.keyboard.press('Enter');
    await page.locator('.chat-msg.is-assistant').waitFor();
    await page.getByRole('button', { name: 'Браузер', exact: true }).first().click();
    const side = page.locator('.chat-side');
    // Браузер без вкладок — обычная строка браузера и пустая «Новая вкладка», без webview.
    const tabs = side.getByRole('tab');
    await expect(tabs).toHaveCount(1);
    await expect(tabs.first()).toContainText('Новая вкладка');
    await expect(page.locator('.chatweb-layer')).toHaveCount(0);
    await side.locator('.browser-address input').fill(`127.0.0.1:${port}/a`);
    await side.locator('.browser-address input').press('Enter');
    await expect(tabs.first()).toContainText('T/a');
    // Страница — в webview слоя окна, ровно над местом в панели.
    const view = page.locator('.chatweb-layer.is-shown webview:not(.is-hidden)');
    await expect.poll(() => view.evaluate((w: Electron.WebviewTag) => w.getURL())).toContain('/a');
    // Панель может ещё выезжать — ждём, пока слой встанет ровно на место.
    const slotWidth = async () => Math.round((await side.locator('.chatweb-slot').boundingBox())!.width);
    await expect
      .poll(async () => {
        const slot = (await side.locator('.chatweb-slot').boundingBox())!;
        const layer = (await page.locator('.chatweb-layer.is-shown').boundingBox())!;
        return Math.abs(slot.x - layer.x) + Math.abs(slot.y - layer.y) + Math.abs(slot.width - layer.width);
      })
      .toBeLessThan(2);

    // Размер страницы на выбор: «Телефон» — настоящие 390 пикселей и мобильный user agent, «По панели» — обратно.
    const sizeBtn = side.getByRole('button', { name: 'Размер страницы' });
    await sizeBtn.click();
    await page.getByRole('menuitemradio', { name: /Телефон/ }).click();
    await expect(sizeBtn).toContainText('390×844');
    await expect
      .poll(() =>
        view.evaluate((w: Electron.WebviewTag) => w.executeJavaScript('innerWidth + "|" + navigator.userAgent.includes("iPhone")')),
      )
      .toBe('390|true');
    await sizeBtn.click();
    await page.getByRole('menuitemradio', { name: /По панели/ }).click();
    await expect(sizeBtn).not.toContainText('×');
    await expect
      .poll(() =>
        view.evaluate((w: Electron.WebviewTag) => w.executeJavaScript('innerWidth + "|" + navigator.userAgent.includes("iPhone")')),
      )
      .toBe(`${await slotWidth()}|false`);

    // Медленная страница во второй вкладке: индикатор — только у неё.
    await side.getByRole('button', { name: 'Новая вкладка' }).click();
    await side.locator('.browser-address input').fill(`127.0.0.1:${port}/slow`);
    await side.locator('.browser-address input').press('Enter');
    await expect(tabs).toHaveCount(2);
    await expect(side.getByRole('progressbar')).toHaveCount(1);
    await expect(tabs.nth(1).locator('.spinner')).toHaveCount(1);
    await tabs.first().click();
    await expect(side.getByRole('progressbar')).toHaveCount(0);
    await expect(tabs.nth(1).locator('.spinner')).toHaveCount(1);
    await expect(tabs.nth(1)).toContainText('T/slow', { timeout: 10_000 });
    await expect(tabs.nth(1).locator('.spinner')).toHaveCount(0);

    // Панель закрыли и открыли — страницы не перезагружались.
    const before = hits.length;
    await page.getByRole('button', { name: 'Браузер', exact: true }).first().click();
    await expect(page.locator('.chatweb-layer.is-shown')).toHaveCount(0);
    await page.getByRole('button', { name: 'Браузер', exact: true }).first().click();
    await expect(page.locator('.chatweb-layer.is-shown')).toHaveCount(1);
    await expect(side.locator('.browser-address input')).toHaveValue(new RegExp(`${port}/a`));
    expect(hits.length).toBe(before);
  } finally {
    await quit(l);
    server.close();
  }
});

// С настоящим Playwright CLI (npx скачивает его при первом запуске — долго): PURPLEFLOW_E2E_PW=1.
test('браузер чата: агент через pw видит и ведёт те же вкладки, что человек', async () => {
  test.skip(!process.env.PURPLEFLOW_E2E_PW, 'нужен Playwright CLI из npx: PURPLEFLOW_E2E_PW=1');
  test.setTimeout(240_000);
  const server = http.createServer((req, res) => {
    res
      .writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      .end(
        `<title>T${req.url}</title><h1 style="font-size:60px">${req.url}</h1><button onclick="this.textContent='нажато'">Кнопка</button><input placeholder="поле">`,
      );
  });
  await new Promise<void>((ok) => server.listen(0, '127.0.0.1', ok));
  const port = (server.address() as AddressInfo).port;
  const box = makeSandbox();
  const l = await launch(box, { PURPLEFLOW_CHAT_BROWSER: 'on' });
  const pw = async (...a: string[]) => {
    const t = Date.now();
    try {
      const r = await promisify(execFile)(findPw(box.root)!, a, { timeout: 30_000 });
      return `[${Date.now() - t}ms] ${r.stdout}`;
    } catch (e) {
      return `[ERR ${Date.now() - t}ms] ${(e as { stdout?: string }).stdout} ${(e as Error).message}`;
    }
  };
  try {
    const page = l.page;
    await page.getByRole('button', { name: 'Создать', exact: true }).click();
    await page.getByRole('menuitem', { name: /Чат/ }).click();
    await page.locator('.chat-compose textarea').fill('открой сайт');
    await page.keyboard.press('Enter');
    await page.locator('.chat-msg.is-assistant').waitFor({ timeout: 180_000 });
    await expect.poll(() => Boolean(findPw(box.root)), { timeout: 30_000 }).toBe(true);
    const side = page.locator('.chat-side');
    await expect(side.getByRole('tab')).toHaveCount(1, { timeout: 30_000 });
    expect(await pw('goto', `http://127.0.0.1:${port}/a`)).not.toContain('[ERR');
    await expect(side.locator('.browser-address input')).toHaveValue(new RegExp(`${port}/a`));
    expect(await pw('tab-new', `http://127.0.0.1:${port}/b`)).not.toContain('[ERR');
    await expect(side.getByRole('tab')).toHaveCount(2);
    await expect(side.locator('.browser-address input')).toHaveValue(new RegExp(`${port}/b`));
    expect(await pw('click', 'e3')).not.toContain('[ERR');
    expect(await pw('fill', 'e4', 'привет')).not.toContain('[ERR');
    expect(await pw('eval', 'document.querySelector("button").textContent + "|" + document.querySelector("input").value')).toContain(
      'нажато|привет',
    );
    // Человек открывает свою вкладку и кликает мышью — агент это видит.
    await side.getByRole('button', { name: 'Новая вкладка' }).click();
    await side.locator('.browser-address input').fill(`127.0.0.1:${port}/c`);
    await side.locator('.browser-address input').press('Enter');
    await expect(side.getByRole('tab')).toHaveCount(3);
    await expect(side.getByRole('tab').nth(2)).toContainText('T/c');
    expect(await pw('tab-list')).toContain(`${port}/c`);
    expect(await pw('tab-select', '2')).not.toContain('[ERR');
    // Центр кнопки в странице — от агента; клик — мышью человека по webview в панели.
    const [bx, by] = JSON.parse(
      /"(\[[\d.,]+\])"/.exec(
        await pw(
          'eval',
          'JSON.stringify((({x, y, width, height}) => [x + width / 2, y + height / 2])(document.querySelector("button").getBoundingClientRect()))',
        ),
      )![1],
    ) as number[];
    const slot = (await side.locator('.chatweb-slot').boundingBox())!;
    await page.mouse.click(slot.x + bx, slot.y + by);
    expect(await pw('eval', 'document.querySelector("button").textContent')).toContain('нажато');
    // Агент закрывает свою вкладку.
    expect(await pw('tab-close', '1')).not.toContain('[ERR');
    await expect(side.getByRole('tab')).toHaveCount(2);
    // Панель закрыта — страницы живы, агент работает и делает снимок.
    await page.getByRole('button', { name: 'Браузер', exact: true }).first().click();
    await expect(page.locator('.chatweb-layer.is-shown')).toHaveCount(0);
    expect(await pw('goto', `http://127.0.0.1:${port}/d`)).not.toContain('[ERR');
    expect(await pw('screenshot', '--filename', 'hidden.png')).not.toContain('[ERR');
    // Вернулись — страница та же, без перезагрузки.
    await page.getByRole('button', { name: 'Браузер', exact: true }).first().click();
    await expect(side.locator('.browser-address input')).toHaveValue(new RegExp(`${port}/d`));
    // pw resize: страница получает настоящий размер, в панели — уменьшенная целиком; клик человека попадает куда надо.
    await pw('goto', `http://127.0.0.1:${port}/r`);
    expect(await pw('resize', '390', '844')).not.toContain('[ERR');
    await expect(side.getByRole('button', { name: 'Размер страницы' })).toContainText('390×844');
    expect(await pw('eval', 'innerWidth + "x" + innerHeight')).toContain('390x844');
    const view = page.locator('.chatweb-layer.is-shown webview:not(.is-hidden)');
    const [rx, ry] = JSON.parse(
      /"(\[[\d.,]+\])"/.exec(
        await pw(
          'eval',
          'JSON.stringify((({x, y, width, height}) => [x + width / 2, y + height / 2])(document.querySelector("button").getBoundingClientRect()))',
        ),
      )![1],
    ) as number[];
    const vb = (await view.boundingBox())!;
    const scale = vb.width / 390;
    expect(scale).toBeLessThan(1);
    await page.mouse.click(vb.x + rx * scale, vb.y + ry * scale);
    expect(await pw('eval', 'document.querySelector("button").textContent')).toContain('нажато');
    // «По панели» в меню размера возвращает размер панели.
    await side.getByRole('button', { name: 'Размер страницы' }).click();
    await page.getByRole('menuitemradio', { name: /По панели/ }).click();
    await expect(side.getByRole('button', { name: 'Размер страницы' })).not.toContainText('×');
    const slotBox = (await side.locator('.chatweb-slot').boundingBox())!;
    expect(await pw('eval', 'innerWidth')).toContain(String(Math.round(slotBox.width)));
    // Новое подключение к мосту (pw переподключился) вытесняет прежнее и видит те же вкладки.
    const daemons = (await promisify(execFile)('ps', ['-axo', 'command'])).stdout;
    const ep = /--cdp=(ws:\/\/127\.0\.0\.1:\d+\/cdp\/\S+)/.exec(daemons)![1];
    const again = await chromium.connectOverCDP(ep);
    await expect.poll(() => again.contexts()[0].pages().length).toBe(2);
    const last = again.contexts()[0].pages()[1];
    await last.goto(`http://127.0.0.1:${port}/e`);
    await expect(side.locator('.browser-address input')).toHaveValue(new RegExp(`${port}/e`));
    await again.close();
  } finally {
    await quit(l);
    server.close();
  }
});

// Визуальная проверка задачи с настоящим pw: агент работает во вкладке окна (своя сессия прогона), человек видит её
// на экране задачи, размер агента — в кнопке размера; после стадии вкладки закрываются. PURPLEFLOW_E2E_PW=1.
test('визуальная проверка: браузер агента — живая вкладка на экране задачи', async () => {
  test.skip(!process.env.PURPLEFLOW_E2E_PW, 'нужен Playwright CLI из npx: PURPLEFLOW_E2E_PW=1');
  test.setTimeout(300_000);
  const box = makeSandbox();
  const pwLog = path.join(box.root, 'pw.log');
  const l = await launch(box, { PURPLEFLOW_CHAT_BROWSER: 'on' });
  try {
    const page = l.page;
    const task = 'Добавь функцию mul в src/math.js ДЕРЖИ_БРАУЗЕР';
    await page.evaluate(
      ({ repo, task }) =>
        (window as unknown as { purpleflow: { core: { dispatch: (c: unknown) => Promise<unknown> } } }).purpleflow.core.dispatch({
          type: 'run.start',
          input: {
            projectPath: repo,
            task,
            testCommand: '',
            mode: 'quick',
            visual: true,
            runCommand: `node -e "require('http').createServer((q,s)=>s.writeHead(200,{'content-type':'text/html; charset=utf-8'}).end('<title>Калькулятор</title><h1>Калькулятор</h1>')).listen({port})"`,
            appUrl: 'http://127.0.0.1:{port}',
          },
        }),
      { repo: box.repo, task },
    );
    await page.getByText(task).first().click();
    await page.getByRole('tab', { name: /Браузер/ }).click();
    // Страница приложения — в webview слоя окна, а не трансляцией.
    const view = page.locator('.chatweb-layer.is-shown webview:not(.is-hidden)');
    await expect
      .poll(() => view.evaluate((w: Electron.WebviewTag) => w.getTitle()).catch(() => ''), { timeout: 180_000 })
      .toBe('Калькулятор');
    expect(await view.getAttribute('partition')).toMatch(/^purpleflow-run-/);
    // Агент задал телефонную ширину — она в кнопке размера и у самой страницы.
    await expect(page.getByRole('button', { name: 'Размер страницы' })).toContainText('390×844', { timeout: 30_000 });
    await expect.poll(() => view.evaluate((w: Electron.WebviewTag) => w.executeJavaScript('innerWidth'))).toBe(390);
    // Стадия кончилась — вкладки прогона закрыты, скриншот агента сохранён.
    await expect(page.locator('.chatweb-layer')).toHaveCount(0, { timeout: 60_000 });
    const log = fs.readFileSync(pwLog, 'utf8');
    expect(log).not.toContain('ERR');
    expect(log).toContain('mobile.png');
  } finally {
    await quit(l);
  }
});
