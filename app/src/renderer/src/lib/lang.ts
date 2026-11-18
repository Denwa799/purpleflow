// Язык Monaco для файла: по имени и расширению, а для незнакомого — по началу содержимого.
const LANG: Record<string, string> = {
  ts: 'typescript',
  tsx: 'typescript',
  js: 'javascript',
  jsx: 'javascript',
  mjs: 'javascript',
  cjs: 'javascript',
  json: 'json',
  md: 'markdown',
  css: 'css',
  scss: 'scss',
  html: 'html',
  py: 'python',
  go: 'go',
  rs: 'rust',
  yml: 'yaml',
  yaml: 'yaml',
  sh: 'shell',
  java: 'java',
  kt: 'kotlin',
  rb: 'ruby',
  php: 'php',
  sql: 'sql',
  vue: 'html',
  jsonc: 'json',
  json5: 'json',
  less: 'less',
  xml: 'xml',
  svg: 'xml',
  c: 'c',
  h: 'c',
  cpp: 'cpp',
  hpp: 'cpp',
  cs: 'csharp',
  swift: 'swift',
  dart: 'dart',
  lua: 'lua',
  graphql: 'graphql',
  gql: 'graphql',
  toml: 'ini',
  ini: 'ini',
  env: 'ini',
  bash: 'shell',
  zsh: 'shell',
  ps1: 'powershell',
  dockerfile: 'dockerfile',
  prisma: 'graphql',
};
const NAMES: Record<string, string> = { dockerfile: 'dockerfile', makefile: 'shell', '.env': 'ini', '.gitignore': 'shell' };
export const langOf = (p: string) => {
  const name = p.split(/[\\/]/).pop()?.toLowerCase() ?? '';
  return NAMES[name] ?? LANG[name.includes('.') ? (name.split('.').pop() ?? '') : ''] ?? 'plaintext';
};

/** Язык для просмотра файла: по имени, а для незнакомого расширения (.pen, .lock, без расширения) — по началу содержимого. */
export function langOfContent(p: string, text: string): string {
  const byName = langOf(p);
  if (byName !== 'plaintext') return byName;
  const head = text.trimStart().slice(0, 200);
  if (/^[{[]/.test(head)) return 'json';
  if (/^<\?xml|^<svg/i.test(head)) return 'xml';
  if (/^<(!doctype|html)/i.test(head)) return 'html';
  if (/^#!.*\b(ba|z)?sh\b/.test(head)) return 'shell';
  if (/^#!.*\bnode\b/.test(head)) return 'javascript';
  if (/^#!.*\bpython/.test(head)) return 'python';
  if (/^---\s*$/m.test(head.split('\n')[0] ?? '')) return 'yaml';
  return 'plaintext';
}
