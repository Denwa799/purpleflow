// Сам PurpleFlow: найти уже установленный, иначе скачать последний выпуск, сверить sha512 и поставить без вопросов.
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { app, net, shell } from 'electron';
import { run } from '@core/proc';
import { assetUrl, manifestName, manifestUrl, parseManifest, pickAsset, type Asset } from '../shared/manifest';
import type { LaunchResult, StepState } from '../shared/types';

type Emit = (s: StepState) => void;

const MANIFEST_TIMEOUT_MS = 20_000;
const DOWNLOAD_TIMEOUT_MS = 30 * 60_000;
const APP_NAME = 'PurpleFlow';

const home = os.homedir();
/** Только для разработки: ставить в черновую папку, а не в настоящие /Applications. */
const devDir = () => (!app.isPackaged ? process.env.PURPLEFLOW_INSTALLER_APPS_DIR : undefined);
const macDirs = () => {
  const dev = devDir();
  return dev ? [dev] : ['/Applications', path.join(home, 'Applications')];
};
const winExes = () => [
  path.join(process.env.LOCALAPPDATA ?? path.join(home, 'AppData', 'Local'), 'Programs', APP_NAME, `${APP_NAME}.exe`),
  path.join(process.env.ProgramFiles ?? 'C:\\Program Files', APP_NAME, `${APP_NAME}.exe`),
];
const linuxAppImage = () => path.join(devDir() ?? path.join(home, 'Applications'), `${APP_NAME}.AppImage`);

/** Где лежит установленный PurpleFlow (на macOS — путь к .app). */
export function installedPath(): string | null {
  const candidates =
    process.platform === 'darwin'
      ? macDirs().map((d) => path.join(d, `${APP_NAME}.app`))
      : process.platform === 'win32'
        ? winExes()
        : [linuxAppImage()];
  return candidates.find((p) => fs.existsSync(p)) ?? null;
}

async function installedVersion(p: string): Promise<string | undefined> {
  if (process.platform !== 'darwin') return undefined;
  const plist = path.join(p, 'Contents', 'Info.plist');
  const r = await run('plutil', ['-extract', 'CFBundleShortVersionString', 'raw', plist], {
    cwd: home,
    env: process.env,
    timeoutMs: 10_000,
  });
  return r.code === 0 ? r.stdout.trim() : undefined;
}

export async function checkPurpleFlow(): Promise<StepState> {
  const p = installedPath();
  if (!p) return { id: 'purpleflow', status: 'missing' };
  return { id: 'purpleflow', status: 'ok', detail: await installedVersion(p) };
}

async function latestAsset(): Promise<Asset> {
  const name = manifestName(process.platform);
  if (!name) throw new Error(`Для ${process.platform} сборки PurpleFlow нет`);
  const res = await net.fetch(manifestUrl(name), { signal: AbortSignal.timeout(MANIFEST_TIMEOUT_MS) });
  if (!res.ok) throw new Error(`GitHub ответил ${res.status}`);
  const asset = pickAsset(parseManifest(await res.text()), process.platform, process.arch);
  if (!asset) throw new Error(`Для ${process.platform}-${process.arch} сборки PurpleFlow нет`);
  return asset;
}

/** Скачивание потоком: файл в сотню мегабайт не держим в памяти, а сумму считаем на лету. */
async function download(asset: Asset, dest: string, onProgress: (p: number) => void): Promise<void> {
  const res = await net.fetch(assetUrl(asset), { signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS) });
  if (!res.ok || !res.body) throw new Error(`Не удалось скачать PurpleFlow: HTTP ${res.status}`);
  const total = Number(res.headers.get('content-length')) || asset.size;
  const hash = createHash('sha512');
  const out = fs.createWriteStream(dest);
  const reader = res.body.getReader();
  let got = 0;
  let last = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      hash.update(value);
      if (!out.write(value)) await new Promise<void>((r) => out.once('drain', () => r()));
      got += value.length;
      if (total && got - last > total / 200) {
        last = got;
        onProgress(Math.min(1, got / total));
      }
    }
  } finally {
    await new Promise<void>((r) => out.end(r));
  }
  if (hash.digest('base64') !== asset.sha512)
    throw new Error('Контрольная сумма не совпала: файл повреждён или подменён. Попробуйте ещё раз.');
}

async function installMac(zip: string): Promise<string> {
  const dir = macDirs().find((d) => {
    try {
      fs.mkdirSync(d, { recursive: true });
      fs.accessSync(d, fs.constants.W_OK);
      return true;
    } catch {
      return false;
    }
  });
  if (!dir) throw new Error('Нет прав на запись ни в /Applications, ни в ~/Applications');
  // Распаковка рядом с итоговой папкой: перенос на том же диске атомарен, оборванная установка не оставит половину приложения.
  const staging = fs.mkdtempSync(path.join(dir, '.purpleflow-install-'));
  try {
    const r = await run('ditto', ['-x', '-k', zip, staging], { cwd: home, env: process.env, timeoutMs: 10 * 60_000 });
    if (r.code !== 0) throw new Error(`Не удалось распаковать: ${(r.spawnError || r.stderr).trim().slice(-300)}`);
    const target = path.join(dir, `${APP_NAME}.app`);
    fs.rmSync(target, { recursive: true, force: true });
    fs.renameSync(path.join(staging, `${APP_NAME}.app`), target);
    return target;
  } finally {
    fs.rmSync(staging, { recursive: true, force: true });
  }
}

async function installWin(exe: string): Promise<string> {
  // Тихая установка для текущего пользователя: без прав администратора и без страниц мастера.
  const r = await run(exe, ['/S', '/currentuser'], { cwd: path.dirname(exe), env: process.env, timeoutMs: 15 * 60_000 });
  if (r.spawnError || r.code !== 0) throw new Error(`Установщик PurpleFlow завершился с ошибкой: ${r.spawnError || `код ${r.code}`}`);
  const p = installedPath();
  if (!p) throw new Error('Установка прошла, но PurpleFlow.exe не найден');
  return p;
}

function installLinux(file: string): string {
  const target = linuxAppImage();
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.copyFileSync(file, `${target}.part`);
  fs.chmodSync(`${target}.part`, 0o755);
  fs.renameSync(`${target}.part`, target);
  // Ярлык в меню приложений: AppImage сам по себе там не появляется.
  try {
    const icons = path.join(home, '.local', 'share', 'icons');
    const apps = path.join(home, '.local', 'share', 'applications');
    fs.mkdirSync(icons, { recursive: true });
    fs.mkdirSync(apps, { recursive: true });
    const icon = path.join(icons, 'purpleflow.png');
    fs.copyFileSync(path.join(process.resourcesPath, 'icon.png'), icon);
    fs.writeFileSync(
      path.join(apps, 'purpleflow.desktop'),
      `[Desktop Entry]\nType=Application\nName=PurpleFlow\nExec="${target}" %U\nIcon=${icon}\nCategories=Development;\nTerminal=false\n`,
    );
  } catch {
    /* без ярлыка PurpleFlow всё равно запускается из ~/Applications */
  }
  return target;
}

export async function ensurePurpleFlow(emit: Emit): Promise<boolean> {
  const cur = await checkPurpleFlow();
  // Установленный PurpleFlow обновляется сам — заменять его здесь незачем.
  if (cur.status === 'ok') {
    emit(cur);
    return true;
  }
  emit({ id: 'purpleflow', status: 'running', detail: 'Ищем последний выпуск', progress: 0 });
  const tmp = fs.mkdtempSync(path.join(app.getPath('temp'), 'purpleflow-'));
  try {
    const asset = await latestAsset();
    const file = path.join(tmp, path.basename(asset.url));
    const mb = Math.round(asset.size / 1e6);
    emit({ id: 'purpleflow', status: 'running', detail: `Скачиваем версию ${asset.version}, ${mb} МБ`, progress: 0 });
    await download(asset, file, (progress) =>
      emit({ id: 'purpleflow', status: 'running', detail: `Скачиваем версию ${asset.version}, ${mb} МБ`, progress }),
    );
    emit({ id: 'purpleflow', status: 'running', detail: 'Устанавливаем', progress: 1 });
    if (asset.kind === 'mac-zip') await installMac(file);
    else if (asset.kind === 'win-nsis') await installWin(file);
    else installLinux(file);
    emit({ id: 'purpleflow', status: 'done', detail: asset.version });
    return true;
  } catch (e) {
    emit({ id: 'purpleflow', status: 'failed', detail: (e as Error).message });
    return false;
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

export async function launchPurpleFlow(): Promise<LaunchResult> {
  const p = installedPath();
  if (!p) return { ok: false, error: 'PurpleFlow не найден' };
  if (process.platform === 'darwin') {
    const err = await shell.openPath(p);
    return err ? { ok: false, error: err } : { ok: true };
  }
  try {
    const child = spawn(p, [], { detached: true, stdio: 'ignore', cwd: home });
    child.unref();
    return { ok: true };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}
