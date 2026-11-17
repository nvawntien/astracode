'use client';

import { useEffect, useRef, useState, type MouseEventHandler, type RefObject } from 'react';

type DragDirection = 'h' | 'v';

interface WorkspaceGeometry {
  shellRef: RefObject<HTMLDivElement | null>;
  splitPct: number;
  bottomPx: number;
  startDrag: (mode: DragDirection) => MouseEventHandler<HTMLDivElement>;
  resetSplit: () => void;
  resetBottom: () => void;
}

export function useWorkspaceGeometry(): WorkspaceGeometry {
  const [splitPct, setSplitPct] = useState(52);
  const [bottomPx, setBottomPx] = useState(235);
  const draggingRef = useRef<DragDirection | null>(null);
  const shellRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    try {
      const stored = Number(sessionStorage.getItem('astra-split'));
      if (stored >= 30 && stored <= 68) setSplitPct(stored);
      const storedBottom = Number(sessionStorage.getItem('astra-bottom'));
      if (storedBottom >= 120 && storedBottom <= 520) setBottomPx(storedBottom);
    } catch {
      /* ignore */
    }
  }, []);

  // Mouseup persists the geometry captured by this render, as in the route implementation.
  useEffect(() => {
    const onMove = (event: MouseEvent) => {
      const mode = draggingRef.current;
      if (!mode || !shellRef.current) return;
      const rect = shellRef.current.getBoundingClientRect();

      if (mode === 'h') {
        const pct = Math.min(68, Math.max(30, ((event.clientX - rect.left) / rect.width) * 100));
        setSplitPct(pct);
      } else {
        const px = Math.min(520, Math.max(120, rect.bottom - event.clientY));
        setBottomPx(px);
      }
    };

    const onUp = () => {
      if (!draggingRef.current) return;
      draggingRef.current = null;
      document.body.style.userSelect = '';
      try {
        sessionStorage.setItem('astra-split', String(splitPct));
        sessionStorage.setItem('astra-bottom', String(bottomPx));
      } catch {
        /* ignore */
      }
    };

    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    return () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
  }, [splitPct, bottomPx]);

  const startDrag =
    (mode: DragDirection): MouseEventHandler<HTMLDivElement> =>
    (event) => {
      event.preventDefault();
      draggingRef.current = mode;
      document.body.style.userSelect = 'none';
    };

  const resetSplit = () => setSplitPct(52);
  const resetBottom = () => setBottomPx(235);

  return { shellRef, splitPct, bottomPx, startDrag, resetSplit, resetBottom };
}
