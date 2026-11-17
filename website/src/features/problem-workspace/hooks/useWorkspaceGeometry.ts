'use client';

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type MouseEventHandler,
  type RefObject,
} from 'react';

type DragDirection = 'h' | 'v';

interface Geometry {
  splitPct: number;
  bottomPx: number;
}

interface DragSession {
  direction: DragDirection;
  userSelect: string;
}

interface WorkspaceGeometry {
  shellRef: RefObject<HTMLDivElement | null>;
  splitPct: number;
  bottomPx: number;
  startDrag: (mode: DragDirection) => MouseEventHandler<HTMLDivElement>;
  resetSplit: () => void;
  resetBottom: () => void;
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
  const [splitPct, setSplitPct] = useState(52);
  const [bottomPx, setBottomPx] = useState(235);
  // Update alongside each accepted value, before React can batch the corresponding state update.
  const geometryRef = useRef<Geometry>({ splitPct: 52, bottomPx: 235 });
  const draggingRef = useRef<DragSession | null>(null);
  const shellRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    try {
      const stored = Number(sessionStorage.getItem('astra-split'));
      if (stored >= 30 && stored <= 68) {
        geometryRef.current.splitPct = stored;
        setSplitPct(stored);
      }
      const storedBottom = Number(sessionStorage.getItem('astra-bottom'));
      if (storedBottom >= 120 && storedBottom <= 520) {
        geometryRef.current.bottomPx = storedBottom;
        setBottomPx(storedBottom);
      }
    } catch {
      /* ignore */
    }
  }, []);

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
        const pct = Math.min(68, Math.max(30, ((event.clientX - rect.left) / rect.width) * 100));
        geometryRef.current.splitPct = pct;
        setSplitPct(pct);
      } else {
        const px = Math.min(520, Math.max(120, rect.bottom - event.clientY));
        geometryRef.current.bottomPx = px;
        setBottomPx(px);
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
  }, [endDrag]);

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
    geometryRef.current.splitPct = 52;
    setSplitPct(52);
    persistGeometry({ splitPct: 52 });
  };

  const resetBottom = () => {
    endDrag(false);
    geometryRef.current.bottomPx = 235;
    setBottomPx(235);
    persistGeometry({ bottomPx: 235 });
  };

  return { shellRef, splitPct, bottomPx, startDrag, resetSplit, resetBottom };
}
