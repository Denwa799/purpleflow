// Вкладка «Git» (только просмотр): ветки, история с графом и коммиты.

export interface GitCommitInfo {
  hash: string;
  /** Родители: первый — основная линия, остальные — влитые ветки. */
  parents: string[];
  subject: string;
  author: string;
  /** ISO-время автора. */
  at: string;
  /** Ветки и теги на этом коммите: main, origin/main, tag: v1.0. */
  refs: string[];
}

export interface GitBranchInfo {
  name: string;
  remote: boolean;
  /** Последний коммит. */
  hash: string;
  at: string;
  /** Насколько впереди и позади основной ветки; нет — это и есть основная или считать не с чем. */
  ahead?: number;
  behind?: number;
  /** Ветка прогона PurpleFlow: id и название задачи. */
  run?: { id: string; title: string };
}

export interface GitGraph {
  /** Ветка в рабочей копии; нет — detached HEAD. */
  current: string | null;
  head: string;
  /** С чем сравниваются ветки: main, master или текущая. */
  base: string | null;
  branches: GitBranchInfo[];
  /** Сверху новые, в порядке, пригодном для графа (родители ниже детей). */
  commits: GitCommitInfo[];
  /** Показаны не все коммиты. */
  more: boolean;
}
