// Тема фона окна: цвет непрозрачного окна и тонировка стекла — CSS-переменными на <html>.
import { themeOf } from '../../../shared/themes';

export function applyTheme(id: string | undefined) {
  const t = themeOf(id);
  const root = document.documentElement;
  root.dataset.theme = t.id;
  root.style.setProperty('--theme-bg', t.bg);
  root.style.setProperty('--theme-tint', t.tint);
}
