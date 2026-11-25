// Какой файл выпуска PurpleFlow скачивать. Источник — latest*.yml, которые electron-builder кладёт в каждый релиз:
// в них имена файлов и sha512, так что проверка целостности не зависит от отдельного файла сумм.

export const REPO = 'PurpleSchool/purpleflow';
export const RELEASES_PAGE = `https://github.com/${REPO}/releases/latest`;

export interface ManifestFile {
  url: string;
  sha512: string;
  size: number;
}

export interface Manifest {
  version: string;
  files: ManifestFile[];
}

export type AssetKind = 'mac-zip' | 'win-nsis' | 'appimage';

export interface Asset extends ManifestFile {
  kind: AssetKind;
  version: string;
}

export function manifestName(platform: string): string | null {
  if (platform === 'darwin') return 'latest-mac.yml';
  if (platform === 'win32') return 'latest.yml';
  if (platform === 'linux') return 'latest-linux.yml';
  return null;
}

export const manifestUrl = (name: string) => `https://github.com/${REPO}/releases/latest/download/${name}`;
/** Ссылка на конкретную версию, а не на latest: файл не сменится, если выпуск опубликуют посреди скачивания. */
export const assetUrl = (a: Asset) => `https://github.com/${REPO}/releases/download/${a.version}/${encodeURIComponent(a.url)}`;

const unquote = (s: string) => s.trim().replace(/^['"]|['"]$/g, '');

/** Формат electron-builder узкий и стабильный: полноценный YAML-парсер ради него не нужен. */
export function parseManifest(text: string): Manifest {
  const version = /^version:\s*(.+)$/m.exec(text)?.[1];
  if (!version) throw new Error('В описании выпуска нет версии');
  const files: ManifestFile[] = [];
  let cur: ManifestFile | null = null;
  for (const line of text.split(/\r?\n/)) {
    const item = /^\s+-\s+url:\s*(.+)$/.exec(line);
    if (item) {
      cur = { url: unquote(item[1]), sha512: '', size: 0 };
      files.push(cur);
      continue;
    }
    if (!/^\s/.test(line)) cur = null;
    if (!cur) continue;
    const field = /^\s+(sha512|size):\s*(.+)$/.exec(line);
    if (field?.[1] === 'sha512') cur.sha512 = unquote(field[2]);
    if (field?.[1] === 'size') cur.size = Number(unquote(field[2])) || 0;
  }
  return { version: unquote(version), files: files.filter((f) => f.sha512) };
}

export function pickAsset(m: Manifest, platform: string, arch: string): Asset | null {
  const find = (kind: AssetKind, test: (url: string) => boolean): Asset | null => {
    const f = m.files.find((x) => test(x.url));
    return f ? { ...f, kind, version: m.version } : null;
  };
  if (platform === 'darwin') {
    return arch === 'arm64'
      ? find('mac-zip', (u) => u.endsWith('-arm64-mac.zip'))
      : find('mac-zip', (u) => u.endsWith('-mac.zip') && !u.includes('arm64'));
  }
  if (platform === 'win32') {
    if (arch !== 'x64' && arch !== 'arm64') return null;
    return find('win-nsis', (u) => u.endsWith(`-${arch}.exe`));
  }
  if (platform === 'linux') {
    const tag = arch === 'x64' ? 'x86_64' : arch === 'arm64' ? 'arm64' : null;
    return tag ? find('appimage', (u) => u.endsWith(`${tag}.AppImage`)) : null;
  }
  return null;
}
