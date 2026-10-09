// Canvas keybindings (session-canvas rebuild).
//
// The interaction vocabulary is ported from termcanvas's spatial model — focus toggle, tile
// cycling, waypoints, palette, search — mapped onto OUR objects (a tile is an agent session,
// not a terminal). Only the interaction ideas are borrowed; no upstream code.
//
// Two rules govern everything here:
//  1. A key never fires while the operator is TYPING. Tiles contain live composers and the
//     inspector is a form; stealing Delete or Escape from a textarea would destroy work.
//  2. The bindings are DECLARED, not just handled — `CANVAS_KEYS` is exported so the command
//     palette shows the same truth the listener enforces (a palette that lies about a shortcut
//     is worse than one that shows none).

import { useEffect, useMemo, useRef } from 'react';

export type CanvasKeyAction =
  | 'focus-toggle'
  | 'cycle-next'
  | 'cycle-prev'
  | 'palette'
  | 'search'
  | 'fit-all'
  | 'delete-selection'
  | 'escape'
  | 'save-waypoint'
  | 'recall-waypoint'
  | 'undo'
  | 'redo';

export interface CanvasKeyBinding {
  action: CanvasKeyAction;
  /** Human-readable hint shown in the palette (mac glyphs when on mac). */
  hint: string;
  label: string;
}

const isMacPlatform = (): boolean =>
  typeof navigator !== 'undefined' && /mac/i.test(navigator.platform || navigator.userAgent || '');

/** Binding table. `mod` renders as ⌘ on mac and Ctrl elsewhere. */
export function canvasKeyBindings(mac = isMacPlatform()): CanvasKeyBinding[] {
  const mod = mac ? '⌘' : 'Ctrl';
  return [
    { action: 'focus-toggle', hint: `${mod}E`, label: '聚焦 / 退出聚焦' },
    { action: 'cycle-next', hint: `${mod}]`, label: '下一个节点' },
    { action: 'cycle-prev', hint: `${mod}[`, label: '上一个节点' },
    { action: 'palette', hint: `${mod}P`, label: '命令面板' },
    { action: 'search', hint: `${mod}K`, label: '搜索画布' },
    { action: 'fit-all', hint: `${mod}0`, label: '适应全部' },
    { action: 'delete-selection', hint: 'Delete', label: '删除所选' },
    { action: 'undo', hint: `${mod}Z`, label: '撤销' },
    { action: 'redo', hint: `${mod}⇧Z`, label: '重做' },
    { action: 'save-waypoint', hint: `${mod}⇧1-9`, label: '保存路标' },
    { action: 'recall-waypoint', hint: `${mod}1-9`, label: '回到路标' },
    { action: 'escape', hint: 'Esc', label: '退出聚焦 / 关闭浮层' },
  ];
}

export interface CanvasKeyHandlers {
  onFocusToggle?: () => void;
  onCycle?: (dir: 1 | -1) => void;
  onPalette?: () => void;
  onSearch?: () => void;
  onFitAll?: () => void;
  onDeleteSelection?: () => void;
  onUndo?: () => void;
  onRedo?: () => void;
  onEscape?: () => void;
  onSaveWaypoint?: (slot: number) => void;
  onRecallWaypoint?: (slot: number) => void;
}

/** Is the event aimed at something the operator is typing into? */
export function isTypingTarget(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  if (!el || !el.tagName) return false;
  if (el.isContentEditable) return true;
  return /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName);
}

/**
 * Bind the canvas keyboard layer for as long as the component is mounted.
 *
 * Escape is the ONE key allowed through from a typing target — it is how an operator gets out
 * of a composer — but it is then reported as a plain escape so the surface can decide (blur the
 * field, or unwind focus) rather than this hook guessing.
 */
export function useCanvasKeys(handlers: CanvasKeyHandlers, enabled = true): CanvasKeyBinding[] {
  // Handlers change identity every render; read them through a ref so the listener binds once.
  const ref = useRef(handlers);
  ref.current = handlers;

  useEffect(() => {
    if (!enabled) return undefined;
    const onKey = (e: KeyboardEvent) => {
      const h = ref.current;
      const typing = isTypingTarget(e.target);

      if (e.key === 'Escape') {
        // Allowed from anywhere — including a composer — because it is the escape hatch.
        h.onEscape?.();
        return;
      }
      if (typing) return; // every binding below would otherwise eat real typing

      const mod = e.metaKey || e.ctrlKey;

      if (!mod) {
        if ((e.key === 'Delete' || e.key === 'Backspace') && h.onDeleteSelection) {
          e.preventDefault();
          h.onDeleteSelection();
        }
        return;
      }

      // Digits: ⌘⇧1-9 saves a waypoint, ⌘1-9 recalls it. e.code is used rather than e.key
      // because Shift rewrites the printed character on most layouts (⌘⇧1 arrives as '!').
      const digitMatch = /^Digit([1-9])$/.exec(e.code || '');
      if (digitMatch) {
        const slot = Number(digitMatch[1]);
        if (e.shiftKey) {
          if (h.onSaveWaypoint) {
            e.preventDefault();
            h.onSaveWaypoint(slot);
          }
        } else if (h.onRecallWaypoint) {
          e.preventDefault();
          h.onRecallWaypoint(slot);
        }
        return;
      }
      if ((e.code === 'Digit0' || e.key === '0') && h.onFitAll) {
        e.preventDefault();
        h.onFitAll();
        return;
      }

      switch (e.key.toLowerCase()) {
        // ⌘Z undo, ⌘⇧Z (and ⌘Y, the Windows habit) redo. preventDefault always, even when the
        // handler is absent: letting the browser's own undo reach a canvas would edit whatever
        // input it last touched, which is worse than doing nothing.
        case 'z':
          e.preventDefault();
          if (e.shiftKey) h.onRedo?.();
          else h.onUndo?.();
          break;
        case 'y':
          e.preventDefault();
          h.onRedo?.();
          break;
        case 'e':
          if (!h.onFocusToggle) return;
          e.preventDefault();
          h.onFocusToggle();
          break;
        case 'p':
          if (!h.onPalette) return;
          e.preventDefault(); // browser print
          h.onPalette();
          break;
        case 'k':
          if (!h.onSearch) return;
          e.preventDefault(); // browser search bar focus
          h.onSearch();
          break;
        case ']':
          if (!h.onCycle) return;
          e.preventDefault();
          h.onCycle(1);
          break;
        case '[':
          if (!h.onCycle) return;
          e.preventDefault();
          h.onCycle(-1);
          break;
        default:
          break;
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [enabled]);

  return useMemo(() => canvasKeyBindings(), []);
}

/** Palette hint map: action → printable shortcut, for CommandBar's keyHints. */
export function keyHintMap(bindings: ReadonlyArray<CanvasKeyBinding>): Record<string, string> {
  const map: Record<string, string> = {};
  for (const b of bindings) map[b.action] = b.hint;
  return map;
}
