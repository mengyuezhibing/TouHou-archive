import { onMounted, onUnmounted } from 'vue';

/**
 * 全局快捷键（对应 UI 设计文档第 22 节）。
 * 组合键统一规范化为 'ctrl+shift+e' / 'space' / 'f5' 这类小写形式。
 */

export interface Hotkey {
  /** 如 'ctrl+f' | 'space' | 'p' | 'f5' | 'ctrl+shift+e' */
  keys: string;
  handler: () => void;
  /** 是否允许在输入框聚焦时触发（搜索类快捷键需要） */
  allowInInput?: boolean;
  description?: string;
}

function normalize(e: KeyboardEvent): string {
  const parts: string[] = [];
  if (e.ctrlKey || e.metaKey) parts.push('ctrl');
  if (e.shiftKey) parts.push('shift');
  if (e.altKey) parts.push('alt');

  let key = e.key.toLowerCase();
  if (key === ' ') key = 'space';
  if (key === 'escape') key = 'esc';
  parts.push(key);
  return parts.join('+');
}

export function useHotkeys(hotkeys: Hotkey[]) {
  const map = new Map<string, Hotkey>();
  for (const h of hotkeys) map.set(h.keys.toLowerCase(), h);

  function onKeydown(e: KeyboardEvent) {
    const target = e.target as HTMLElement | null;
    const inInput = !!target && /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName);
    const hit = map.get(normalize(e));
    if (!hit) return;
    if (inInput && !hit.allowInInput) return;
    e.preventDefault();
    hit.handler();
  }

  onMounted(() => window.addEventListener('keydown', onKeydown));
  onUnmounted(() => window.removeEventListener('keydown', onKeydown));
}

/** 供界面展示的快捷键清单 */
export const HOTKEY_LIST: Array<{ keys: string; label: string }> = [
  { keys: 'Ctrl+F', label: '搜索素材' },
  { keys: 'Ctrl+E', label: '前往解包中心' },
  { keys: 'Space', label: '预览 / 暂停播放' },
  { keys: 'P', label: '切换动画播放' },
  { keys: 'Ctrl+Shift+E', label: '打开导出中心' },
  { keys: 'F5', label: '弹幕模拟 / 重算' },
  { keys: 'Esc', label: '关闭抽屉与弹层' },
];
