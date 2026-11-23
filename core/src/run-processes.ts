/** Фоновые вызовы прогона вне цикла стадий: менеджер, сводка, карта файлов, уроки. */
export const backgroundProcessGroups = (id: string): string[] => [`${id}:manager`, `${id}:summary`, `${id}:map`, `${id}:learn`];

/** Child process groups owned by a run, including detached service calls. */
export const runProcessGroups = (id: string): string[] => [
  id,
  `${id}:server`,
  `${id}:preview`,
  `${id}:visual-cleanup`,
  ...backgroundProcessGroups(id),
];
