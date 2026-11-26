// node-pty 1.1 приходит из npm с spawn-helper без права на запуск: терминал на macOS падает с «posix_spawnp failed».
// Запускается после npm install; electron-builder берёт файл уже с правильными правами.
import fs from 'node:fs';
import path from 'node:path';

const root = path.join(import.meta.dirname, '..', 'node_modules', 'node-pty');
const candidates = [path.join(root, 'build', 'Release', 'spawn-helper')];
const prebuilds = path.join(root, 'prebuilds');
if (fs.existsSync(prebuilds)) for (const d of fs.readdirSync(prebuilds)) candidates.push(path.join(prebuilds, d, 'spawn-helper'));
for (const f of candidates) if (fs.existsSync(f)) fs.chmodSync(f, 0o755);
