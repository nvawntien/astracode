'use client';

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type KeyboardEventHandler,
  type MouseEventHandler,
  type RefObject,
} from 'react';

type DragDirection = 'h' | 'v';

const SPLIT = { initial: 52, min: 30, max: 68, step: 2 };
const BOTTOM = { initial: 235, min: 120, max: 520, step: 20 };

interface Geometry {
  splitPct: number;
  bottomPx: number;
}

interface DragSession {
  direction: DragDirection;
  userSelect: string;
}

interface ResizeSeparatorProps {
  onKeyDown: KeyboardEventHandler<HTMLDivElement>;
  'aria-valuemin': number;
  'aria-valuemax': number;
  'aria-valuenow': number;
  'aria-valuetext': string;
}

interface WorkspaceGeometry {
  shellRef: RefObject<HTMLDivElement | null>;
  splitPct: number;
  bottomPx: number;
  startDrag: (mode: DragDirection) => MouseEventHandler<HTMLDivElement>;
  resetSplit: () => void;
  resetBottom: () => void;
  splitSeparatorProps: ResizeSeparatorProps;
  bottomSeparatorProps: ResizeSeparatorProps;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function persistGeometry({ splitPct, bottomPx }: Partial<Geometry>): void {
  try {
    if (splitPct !== undefined) sessionStorage.setItem('astra-split', String(splitPct));
    if (bottomPx !== undefined) sessionStorage.setItem('astra-bottom', String(bottomPx));
  } catch {
    /* ignore */
  }
}

export function useWorkspaceGeometry(): WorkspaceGeometry {
  const [splitPct, setSplitPct] = useState(SPLIT.initial);
  const [bottomPx, setBottomPx] = useState(BOTTOM.initial);
  // Update alongside each accepted value, before React can batch the corresponding state update.
  const geometryRef = useRef<Geometry>({ splitPct: SPLIT.initial, bottomPx: BOTTOM.initial });
  const draggingRef = useRef<DragSession | null>(null);
  const shellRef = useRef<HTMLDivElement>(null);

  const updateSplit = useCallback((value: number, persist = false) => {
    const next = clamp(value, SPLIT.min, SPLIT.max);
    geometryRef.current.splitPct = next;
    setSplitPct(next);
    if (persist) persistGeometry({ splitPct: next });
  }, []);

  const updateBottom = useCallback((value: number, persist = false) => {
    const next = clamp(value, BOTTOM.min, BOTTOM.max);
    geometryRef.current.bottomPx = next;
    setBottomPx(next);
    if (persist) persistGeometry({ bottomPx: next });
  }, []);

  useEffect(() => {
    try {
      const stored = Number(sessionStorage.getItem('astra-split'));
      if (stored >= SPLIT.min && stored <= SPLIT.max) updateSplit(stored);
      const storedBottom = Number(sessionStorage.getItem('astra-bottom'));
      if (storedBottom >= BOTTOM.min && storedBottom <= BOTTOM.max) updateBottom(storedBottom);
    } catch {
      /* ignore */
    }
  }, [updateSplit, updateBottom]);

  const endDrag = useCallback((persist: boolean) => {
    const session = draggingRef.current;
    if (!session) return;
    draggingRef.current = null;
    document.body.style.userSelect = session.userSelect;
    if (persist) persistGeometry(geometryRef.current);
  }, []);

  // Stable listeners keep a drag active across geometry updates and ordinary rerenders.
  useEffect(() => {
    const onMove = (event: MouseEvent) => {
      const session = draggingRef.current;
      if (!session || !shellRef.current) return;
      const rect = shellRef.current.getBoundingClientRect();

      if (session.direction === 'h') {
        updateSplit(((event.clientX - rect.left) / rect.width) * 100);
      } else {
        updateBottom(rect.bottom - event.clientY);
      }
    };

    const onEnd = () => endDrag(true);

    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onEnd);
    window.addEventListener('blur', onEnd);
    return () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onEnd);
      window.removeEventListener('blur', onEnd);
      // Unmount restores selection without adding a persistence write.
      endDrag(false);
    };
  }, [endDrag, updateSplit, updateBottom]);

  const startDrag =
    (mode: DragDirection): MouseEventHandler<HTMLDivElement> =>
    (event) => {
      event.preventDefault();
      draggingRef.current = {
        direction: mode,
        userSelect: draggingRef.current?.userSelect ?? document.body.style.userSelect,
      };
      document.body.style.userSelect = 'none';
    };

  const resetSplit = () => {
    endDrag(false);
    updateSplit(SPLIT.initial, true);
  };

  const resetBottom = () => {
    endDrag(false);
    updateBottom(BOTTOM.initial, true);
  };

  const onSplitKeyDown: KeyboardEventHandler<HTMLDivElement> = (event) => {
    if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
    let next: number;
    switch (event.key) {
      case 'ArrowLeft':
        next = geometryRef.current.splitPct - SPLIT.step;
        break;
      case 'ArrowRight':
        next = geometryRef.current.splitPct + SPLIT.step;
        break;
      case 'Home':
        next = SPLIT.min;
        break;
      case 'End':
        next = SPLIT.max;
        break;
      default:
        return;
    }
    event.preventDefault();
    endDrag(false);
    updateSplit(next, true);
  };

  const onBottomKeyDown: KeyboardEventHandler<HTMLDivElement> = (event) => {
    if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
    let next: number;
    switch (event.key) {
      case 'ArrowUp':
        next = geometryRef.current.bottomPx + BOTTOM.step;
        break;
      case 'ArrowDown':
        next = geometryRef.current.bottomPx - BOTTOM.step;
        break;
      case 'Home':
        next = BOTTOM.min;
        break;
      case 'End':
        next = BOTTOM.max;
        break;
      default:
        return;
    }
    event.preventDefault();
    endDrag(false);
    updateBottom(next, true);
  };

  return {
    shellRef,
    splitPct,
    bottomPx,
    startDrag,
    resetSplit,
    resetBottom,
    splitSeparatorProps: {
      onKeyDown: onSplitKeyDown,
      'aria-valuemin': SPLIT.min,
      'aria-valuemax': SPLIT.max,
      'aria-valuenow': splitPct,
      'aria-valuetext': `${splitPct}% left pane width`,
    },
    bottomSeparatorProps: {
      onKeyDown: onBottomKeyDown,
      'aria-valuemin': BOTTOM.min,
      'aria-valuemax': BOTTOM.max,
      'aria-valuenow': bottomPx,
      'aria-valuetext': `${bottomPx} pixels when expanded`,
    },
  };
}
