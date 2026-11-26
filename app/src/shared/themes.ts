// Цветовые темы фона окна: общие для главного процесса (цвет окна до первой отрисовки) и окна (CSS).

export type WindowTheme = 'graphite' | 'black' | 'midnight' | 'violet' | 'forest' | 'mocha';

export interface ThemeDef {
  id: WindowTheme;
  label: string;
  /** Фон непрозрачного окна. */
  bg: string;
  /** Тонировка поверх размытого рабочего стола в прозрачном окне. */
  tint: string;
  /** Цвет кружка в настройках: ярче фона, чтобы темы различались с первого взгляда. */
  swatch: string;
}

export const THEMES: ThemeDef[] = [
  { id: 'graphite', swatch: '#6e6e74', label: 'Графит', bg: '#252527', tint: 'rgba(8, 9, 11, 0.16)' },
  { id: 'black', swatch: '#141518', label: 'Чёрный', bg: '#0c0d0f', tint: 'rgba(4, 5, 6, 0.62)' },
  { id: 'midnight', swatch: '#3f5a9a', label: 'Полночь', bg: '#1c2130', tint: 'rgba(14, 22, 48, 0.42)' },
  { id: 'violet', swatch: '#7356c9', label: 'Фиолетовый', bg: '#231f33', tint: 'rgba(36, 22, 66, 0.42)' },
  { id: 'forest', swatch: '#3f7a5f', label: 'Лес', bg: '#1b2522', tint: 'rgba(12, 36, 28, 0.42)' },
  { id: 'mocha', swatch: '#8a6446', label: 'Кофе', bg: '#29231f', tint: 'rgba(44, 30, 20, 0.42)' },
];

export const DEFAULT_THEME: WindowTheme = 'graphite';

export const themeOf = (id: string | undefined): ThemeDef => THEMES.find((t) => t.id === id) ?? THEMES[0];
