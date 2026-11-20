// Режим «Ревью кода»: ревьюер только читает выбранный код и оставляет замечания; правок, проверок и коммита нет.
import { c } from '../agents/common.js';
import { isImageFile } from '../files.js';
import { Git } from '../git.js';
import { formatItem } from '../items.js';
import type { Kernel } from '../kernel.js';
import { parseReview } from '../parse.js';
import { GENERATED_GLOBS, lineStats, packReview, splitDiff } from '../reviewdiff.js';
import { INLINE_DIFF, RUN_JSON_GLOB } from '../runtime.js';
import { runRole } from '../services/agents.js';
import { filesBlock } from '../services/attachments.js';
import { envFilesOf } from '../services/workspace.js';
import type { ReviewItem, ReviewResult, RunFile } from '../types.js';
import { verifyBlocking } from './review.js';

/** Что проверяем — для промпта и сводки: дифф (с базой) или файлы целиком. */
export async function reviewScope(k: Kernel, run: RunFile): Promise<string> {
  const target = run.review!.target;
  const base8 = run.baseCommit.slice(0, 8);
  if (target.kind === 'files') {
    return `Файлы целиком, как они есть в последнем коммите. Прочитай **каждый** полностью:\n\n${target.files.map((f) => `- \`${f}\``).join('\n')}`;
  }
  const git = new Git((await k.tools(['git'])).git, k.opts.env);
  const diff = await git.diffText(run.worktreePath, run.baseCommit, [RUN_JSON_GLOB, ...GENERATED_GLOBS, ...envFilesOf(k, run)]);
  if (!diff.trim()) return `Изменений против ${base8} нет.`;
  const packed = packReview(diff, Number.MAX_SAFE_INTEGER, 1);
  const part = packed.parts[0] ?? '';
  const what =
    target.kind === 'uncommitted'
      ? 'Незакоммиченные изменения проекта'
      : target.kind === 'commit'
        ? `Коммит ${target.hash.slice(0, 8)}`
        : `Ветка \`${target.branch}\` против \`${target.against}\``;
  if (part.length <= INLINE_DIFF) return `${what} — дифф против базы ${base8}:\n\n\`\`\`diff\n${part}\n\`\`\``;
  const stats = new Map(splitDiff(diff).map((f) => [f.path, lineStats(f.text)]));
  const list = packed.files[0]
    .map((f) => {
      const st = stats.get(f);
      return `- \`${f}\`${st ? ` (+${st.add} −${st.del})` : ''}`;
    })
    .join('\n');
  return `${what}. Изменённые файлы — по важности. Прочитай дифф **каждого** (\`git diff ${base8} -- <файл>\`, можно сразу несколько), а где нужно — и файл целиком. Замечания по непрочитанному коду ничего не стоят.\n\n${list}`;
}

export async function stageCodeReview(k: Kernel, run: RunFile) {
  const attempt = k.begin(run, 'review', run.models.reviewer);
  const label = run.review?.label ?? 'код';
  const focus = run.task.trim() ? `\nЧеловек просит обратить особое внимание:\n\n<focus>\n${run.task.trim()}\n</focus>\n` : '';
  const prompt = k.prompts.render('review-code.md', {
    target: label,
    focus,
    scope: await reviewScope(k, run),
    attachments: [
      run.attachments?.some(isImageFile) ? 'К запросу приложены изображения — они прикреплены к этому сообщению.' : '',
      filesBlock(k, run),
    ]
      .filter(Boolean)
      .join('\n'),
  });
  const res = await runRole(k, run, 'reviewer', {
    prompt,
    readOnly: true,
    images: (run.attachments ?? []).filter(isImageFile),
    outputSchema: k.prompts.json<object>('review.schema.json'),
  });
  k.afterAgent(run, attempt, { ...res, text: '' });
  const reply = parseReview(res.text);
  if (!reply) throw new Error(`Ревьюер вернул ответ не в формате JSON { blocking, notes }:\n${res.text.slice(0, 500)}`);
  const seen = new Set<string>();
  const uniq = (items: ReviewItem[]) =>
    items.filter((i) => {
      const key = `${i.file ?? ''}:${i.line ?? ''}:${i.message}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  let blocking = uniq(reply.blocking).map(({ origin: _, ...i }) => i);
  let notes = uniq(reply.notes).map(({ origin: _, ...i }) => i);
  // Важные замечания перепроверяет второй ревьюер по коду: ложные убираются, мелкие уходят в заметки.
  if (blocking.length) {
    const verified = await verifyBlocking(k, run, attempt, blocking, `Ревью кода: ${label}`, (t) => k.log(run, t));
    blocking = verified.blocking;
    notes = [...notes, ...verified.demoted];
  }
  const review: ReviewResult = { at: new Date().toISOString(), blocking, notes };
  run.reviews.push(review);
  k.emit({ type: 'review.result', runId: run.id, result: review });
  if (blocking.length)
    k.log(run, c.coral(`✗ важные (${blocking.length}):\n`) + blocking.map((i) => `  • ${formatItem(i)}`).join('\n') + '\n');
  if (notes.length) k.log(run, c.amber(`• заметки (${notes.length}):\n`) + notes.map((i) => `  • ${formatItem(i)}`).join('\n') + '\n');
  if (!blocking.length && !notes.length) k.log(run, c.mint('✓ замечаний нет') + '\n');
  k.end(run, attempt, 'done', blocking.length || notes.length ? `Важных: ${blocking.length}, заметок: ${notes.length}` : 'Замечаний нет');
  // Ревью кода не возвращает задачу исполнителю: все замечания — на разбор человеку.
  run.feedback = undefined;
  run.next = 'gate2';
  k.save(run);
}
