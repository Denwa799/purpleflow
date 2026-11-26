// Название чата, которое придумывает модель: пока думает — мерцающая заглушка, потом название печатается по буквам.
import { useEffect, useRef, useState } from 'react';

const reduceMotion = () => {
  try {
    return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  } catch {
    return false;
  }
};

/**
 * Текст названия для показа: после генерации (titling true → false) новое название печатается по буквам,
 * в остальных случаях — сразу как есть.
 */
export function useTypedTitle(title: string, titling?: boolean): string {
  const [shown, setShown] = useState(title);
  const wasTitling = useRef(Boolean(titling));
  useEffect(() => {
    const reveal = wasTitling.current && !titling;
    wasTitling.current = Boolean(titling);
    if (!reveal || reduceMotion()) {
      setShown(title);
      return;
    }
    let i = 0;
    setShown('');
    // Короткое название печатается не дольше ~0,8 с: шаг меньше, если букв много.
    const step = Math.max(14, Math.min(40, 800 / Math.max(1, title.length)));
    const t = window.setInterval(() => {
      i += 1;
      setShown(title.slice(0, i));
      if (i >= title.length) window.clearInterval(t);
    }, step);
    return () => window.clearInterval(t);
  }, [title, titling]);
  return shown;
}

/** Заглушка на месте названия: пара мерцающих полосок. */
export function TitleSkeleton({ wide = false }: { wide?: boolean }) {
  return (
    <span className={`title-skel ${wide ? 'is-wide' : ''}`} role="status" aria-label="Придумываю название">
      <i />
      <i />
    </span>
  );
}

/** Название чата в строке списка: заглушка, пока модель думает, затем печать по буквам. */
export function ChatTitleText({ title, titling, className }: { title: string; titling?: boolean; className?: string }) {
  const shown = useTypedTitle(title, titling);
  if (titling) return <TitleSkeleton />;
  return (
    <span className={className} title={title}>
      {shown}
      {shown.length < title.length && <span className="title-caret" aria-hidden />}
    </span>
  );
}
