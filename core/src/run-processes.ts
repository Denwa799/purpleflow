/** Child process groups owned by a run, including detached service calls. */
export const runProcessGroups = (id: string): string[] => [
  id,
  `${id}:server`,
  `${id}:preview`,
  `${id}:visual-cleanup`,
  `${id}:manager`,
  `${id}:summary`,
  `${id}:map`,
  `${id}:learn`,
];
