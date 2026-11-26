// Вкладки браузера чатов — настоящие <webview>. Живут в слое окна (ChatWebHost), а не в панели: панель закрыли или
// ушли в другой чат — страницы не перезагружаются, и агент продолжает с ними работать через мост main.
import { useSyncExternalStore } from 'react';
import type { WebviewTag } from 'electron';
import { bridge } from './api';
import { onCoreEvent } from './store';

export interface WebTab {
  key: string;
  /** Адрес, с которым вкладка открылась (src webview; дальше не меняется). */
  src: string;
  url: string;
  title: string;
  loading: boolean;
  back: boolean;
  forward: boolean;
  error: string | null;
  /** id вкладки у агента (CDP) — после регистрации в мосте. */
  targetId: string | null;
  /** webContentsId — для «Телефона» и ссылок в новое окно. */
  wcId: number | null;
  /** Размер страницы — выбрал человек или задал агент (pw resize); null — по размеру панели. */
  size: { width: number; height: number } | null;
  /** Страница считает себя телефоном (мобильный user agent) — пресет «Телефон». */
  mobile: boolean;
  /** Ждёт ли агент эту вкладку (он её и открыл). */
  reqId?: string;
}

export interface ChatWeb {
  tabs: WebTab[];
  active: string | null;
  /** Сколько раз агент открывал вкладку — экран чата по этому открывает панель «Браузер». */
  agentOpened: number;
}

const EMPTY: ChatWeb = { tabs: [], active: null, agentOpened: 0 };
const chats = new Map<string, ChatWeb>();
const views = new Map<string, WebviewTag>();
const slots = new Map<string, HTMLElement>();
const listeners = new Set<() => void>();
let all: [string, ChatWeb][] = [];
let seq = 0;

function emit() {
  all = [...chats.entries()];
  for (const l of listeners) l();
}
const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => listeners.delete(l);
};

function update(chatId: string, fn: (c: ChatWeb) => ChatWeb) {
  const next = fn(chats.get(chatId) ?? EMPTY);
  if (next.tabs.length || chats.has(chatId)) chats.set(chatId, next);
  emit();
}

export const getAllChatWebIds = () => [...chats.keys()];

/** Владелец вкладок — прогон (`run:<id>`: визуальная проверка, самопроверка), а не чат. */
export const isRunOwner = (owner: string) => owner.startsWith('run:');
/** Сессия webview: у каждого прогона своя (куки задач не смешиваются), чаты — общая сессия браузера. */
export const partitionOf = (owner: string) => (isRunOwner(owner) ? `purpleflow-run-${owner.slice(4)}` : 'purpleflow-preview');
export const getChatWeb = (chatId: string): ChatWeb => chats.get(chatId) ?? EMPTY;
export const useChatWeb = (chatId: string): ChatWeb => useSyncExternalStore(subscribe, () => getChatWeb(chatId));
export const useAllChatWeb = (): [string, ChatWeb][] => useSyncExternalStore(subscribe, () => all);

/** Окно открыло браузер чата — ядро подключит к нему агента в следующем ходе. */
const told = new Set<string>();
function tellCore(chatId: string) {
  // Вкладки прогона открывает сам агент стадии — ядру сообщать не о чем.
  if (told.has(chatId) || isRunOwner(chatId)) return;
  told.add(chatId);
  void bridge.core.controlChatBrowser(chatId, { type: 'opened' }).catch(() => told.delete(chatId));
}

export function openTab(chatId: string, url: string, o: { reqId?: string } = {}): string {
  const key = `t${++seq}`;
  const tab: WebTab = {
    key,
    src: url,
    url: url === 'about:blank' ? '' : url,
    title: '',
    loading: url !== 'about:blank',
    back: false,
    forward: false,
    error: null,
    targetId: null,
    wcId: null,
    size: null,
    mobile: false,
    reqId: o.reqId,
  };
  update(chatId, (c) => ({ ...c, tabs: [...c.tabs, tab], active: key, agentOpened: c.agentOpened + (o.reqId ? 1 : 0) }));
  tellCore(chatId);
  return key;
}

export function closeTab(chatId: string, key: string) {
  update(chatId, (c) => {
    const i = c.tabs.findIndex((t) => t.key === key);
    if (i < 0) return c;
    const tabs = c.tabs.filter((t) => t.key !== key);
    // Закрыли показанную — показываем соседнюю, как в обычном браузере.
    const active = c.active === key ? (tabs[Math.min(i, tabs.length - 1)]?.key ?? null) : c.active;
    return { ...c, tabs, active };
  });
  views.delete(key);
}

export const selectTab = (chatId: string, key: string) => update(chatId, (c) => ({ ...c, active: key }));

export function patchTab(chatId: string, key: string, patch: Partial<WebTab>) {
  update(chatId, (c) => ({ ...c, tabs: c.tabs.map((t) => (t.key === key ? { ...t, ...patch } : t)) }));
}

/** Размеры страницы на выбор в панели: настоящие пиксели, в панели — уменьшенные целиком, если не влезают. */
export const SIZES = [
  { id: 'phone', label: 'Телефон', width: 390, height: 844, mobile: true },
  { id: 'tablet', label: 'Планшет', width: 768, height: 1024, mobile: false },
  { id: 'laptop', label: 'Ноутбук', width: 1280, height: 800, mobile: false },
  { id: 'desktop', label: 'Десктоп', width: 1440, height: 900, mobile: false },
  { id: 'wide', label: 'Широкий', width: 1920, height: 1080, mobile: false },
] as const;

/** Размер вкладки (null — по панели); «Телефон» ещё и мобильный user agent — страница перезагрузится. */
export function setTabSize(chatId: string, key: string, size: { width: number; height: number } | null, mobile: boolean) {
  const t = getChatWeb(chatId).tabs.find((x) => x.key === key);
  if (!t) return;
  patchTab(chatId, key, { size, mobile });
  if (t.wcId && t.mobile !== mobile) void bridge.previewEmulate(t.wcId, mobile);
}

/** Чат удалён — его вкладки закрываются. */
export function dropChat(chatId: string) {
  for (const t of getChatWeb(chatId).tabs) views.delete(t.key);
  chats.delete(chatId);
  told.delete(chatId);
  emit();
}

export const viewOf = (key: string) => views.get(key) ?? null;
export function setView(key: string, el: WebviewTag | null) {
  if (el) views.set(key, el);
  else views.delete(key);
}

/** Место в панели, куда слой ставит вкладки чата; панели нет — вкладки живут за окном. */
export const slotOf = (chatId: string) => slots.get(chatId) ?? null;
export function setSlot(chatId: string, el: HTMLElement | null) {
  if (el) slots.set(chatId, el);
  else if (slots.get(chatId)) slots.delete(chatId);
}

const keyOfTarget = (chatId: string, targetId: string) => getChatWeb(chatId).tabs.find((t) => t.targetId === targetId)?.key;

// Агент открывает, закрывает и выбирает вкладки через мост main.
bridge.onChatWeb((e) => {
  if (e.type === 'open') return void openTab(e.chatId, e.url, { reqId: e.reqId });
  const key = keyOfTarget(e.chatId, e.targetId);
  if (!key) return;
  if (e.type === 'close') closeTab(e.chatId, key);
  else if (e.type === 'size') patchTab(e.chatId, key, { size: e.width && e.height ? { width: e.width, height: e.height } : null });
  else selectTab(e.chatId, key);
});

// Страница открыла ссылку в новом окне — новая вкладка того же чата.
bridge.onPreviewNewTab((fromId, url) => {
  for (const [chatId, c] of chats) if (c.tabs.some((t) => t.wcId === fromId)) return void openTab(chatId, url);
});

// Стадия кончилась — её вкладки закрываются.
onCoreEvent((e) => {
  if (e.type === 'browser.drop') dropChat(e.owner);
});
