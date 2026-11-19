import { act, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';

export async function renderReact(element: ReactNode) {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  let mounted = true;
  await act(async () => root.render(element));
  return {
    container,
    rerender: async (next: ReactNode) => {
      await act(async () => root.render(next));
    },
    unmount: async () => {
      if (!mounted) return;
      mounted = false;
      await act(async () => root.unmount());
      container.remove();
    },
  };
}

export function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}
