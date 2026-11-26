// Установка и удаление скиллов: каталог skills.sh и CLI `npx skills` (vercel-labs/skills).
import os from 'node:os';
import path from 'node:path';
import type { Kernel } from '../kernel.js';
import { enabledAgents } from '../model/settings.js';
import { run } from '../proc.js';
import type { AgentKind, ChatSkill, SkillHit } from '../types.js';
import { listChatSkills } from './chat.js';

/** Каталог skills.sh; PURPLEFLOW_SKILLS_SEARCH_URL — свой адрес (e2e без сети). */
const SEARCH_URL = process.env.PURPLEFLOW_SKILLS_SEARCH_URL || 'https://skills.sh/api/search';
/** Имена агентов в `skills` CLI. */
const CLI_AGENT: Record<AgentKind, string> = { claude: 'claude-code', codex: 'codex', opencode: 'opencode', agy: 'antigravity-cli' };
const SOURCE = /^[\w.-]+\/[\w.-]+$/;
const NAME = /^[\w.:-]+$/;

/** Поиск в каталоге skills.sh — тот же, что у `npx skills find`. */
export async function searchSkills(query: string): Promise<SkillHit[]> {
  const q = query.trim();
  if (q.length < 2) return [];
  const res = await fetch(`${SEARCH_URL}?${new URLSearchParams({ q })}`, { signal: AbortSignal.timeout(10_000) });
  if (!res.ok) throw new Error(`Каталог скиллов не ответил (HTTP ${res.status})`);
  const data = (await res.json()) as { skills?: Record<string, unknown>[] };
  return (data.skills ?? [])
    .map((s) => ({
      id: String(s.id ?? ''),
      name: String(s.name ?? s.skillId ?? ''),
      source: String(s.source ?? ''),
      skill: String(s.skillId ?? s.name ?? ''),
      installs: Number(s.installs) || 0,
    }))
    .filter((s) => SOURCE.test(s.source) && NAME.test(s.skill))
    .slice(0, 30);
}

/** `npx skills …` без вопросов и без телеметрии; в папке проекта или домашней (глобально). */
async function skillsCli(k: Kernel, args: string[], cwd: string): Promise<string> {
  const r = await run('npx', ['-y', 'skills', ...args], {
    cwd,
    env: { ...k.opts.env, DISABLE_TELEMETRY: '1', DO_NOT_TRACK: '1', CI: '1' },
    timeoutMs: 5 * 60_000,
  });
  const out = `${r.stdout}\n${r.stderr}`.replace(/\x1b\[[0-9;]*m/g, '').trim();
  if (r.spawnError) throw new Error(`npx не запустился: ${r.spawnError}`);
  if (r.timedOut) throw new Error('Установка не уложилась в 5 минут');
  if (r.code !== 0) throw new Error(out.split('\n').slice(-6).join('\n') || `skills завершился с кодом ${r.code}`);
  return out;
}

/**
 * Поставить скилл из каталога для включённых агентов: в проект (без projectPath — глобально, для всех проектов).
 * Возвращает обновлённый список скиллов проекта.
 */
export async function installSkill(k: Kernel, o: { projectPath?: string; source: string; skill: string }): Promise<ChatSkill[]> {
  if (!SOURCE.test(o.source) || !NAME.test(o.skill)) throw new Error('Неверное имя скилла');
  const agents = enabledAgents(k.opts.getSettings()).map((a) => CLI_AGENT[a]);
  // Агенты — отдельными -a: через запятую CLI их не принимает.
  const args = ['add', o.source, '-s', o.skill, ...agents.flatMap((a) => ['-a', a]), '-y', ...(o.projectPath ? [] : ['-g'])];
  await skillsCli(k, args, o.projectPath ?? os.homedir());
  return listChatSkills(k, o.projectPath);
}

/**
 * Удалить скилл. Поставленный через `skills` убирает сам CLI (вместе с записью в skills-lock.json и ссылками для агентов).
 * Что осталось на диске (скилл положили руками, команды) — в ответе: эти пути окно отправит в корзину.
 */
export async function removeSkill(
  k: Kernel,
  o: { projectPath?: string; name: string; source: ChatSkill['source'] },
): Promise<{ skills: ChatSkill[]; leftovers: string[] }> {
  if (!NAME.test(o.name)) throw new Error('Неверное имя скилла');
  const find = (list: ChatSkill[]) => list.find((s) => s.name === o.name && s.source === o.source && !s.plugin);
  const before = find(await listChatSkills(k, o.projectPath));
  if (!before) throw new Error('Скилл уже удалён');
  if (o.source === 'project' && !o.projectPath) throw new Error('Не указан проект');
  if (before.kind === 'skill') {
    // Не через skills — CLI ответит, что не знает скилл; это не ошибка, его копии уйдут в корзину.
    await skillsCli(k, ['remove', '-s', o.name, '-y', ...(o.source === 'user' ? ['-g'] : [])], o.projectPath ?? os.homedir()).catch(
      () => '',
    );
  }
  const skills = await listChatSkills(k, o.projectPath);
  const after = find(skills);
  // Скилл — папка с SKILL.md, команда — сам файл.
  const left = after ? (after.paths ?? [after.path]) : [];
  return { skills, leftovers: after?.kind === 'skill' ? left.map((f) => path.dirname(f)) : left };
}
