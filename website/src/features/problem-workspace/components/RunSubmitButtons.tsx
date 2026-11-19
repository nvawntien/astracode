import { Icon, Spinner } from '@/components/ui';

interface RunSubmitButtonsProps {
  variant: 'desktop' | 'mobile';
  busy: boolean;
  online: boolean;
  running: boolean;
  submitting: boolean;
  onRun: () => void;
  onSubmit: () => void;
}

export function RunSubmitButtons({
  variant,
  busy,
  online,
  running,
  submitting,
  onRun,
  onSubmit,
}: RunSubmitButtonsProps) {
  if (variant === 'mobile') {
    return (
      <>
        <button
          type="button"
          onClick={onRun}
          title="Run selected test cases"
          disabled={busy || !online}
          className="ac-hover-surface2"
          style={{
            flex: 1,
            minHeight: 44,
            border: '1px solid var(--border2)',
            borderRadius: 9,
            background: 'var(--surface)',
            color: 'var(--text)',
            fontSize: 13.5,
            fontWeight: 600,
            cursor: 'pointer',
            opacity: busy || !online ? 0.55 : 1,
          }}
        >
          Run
        </button>
        <button
          type="button"
          onClick={onSubmit}
          disabled={busy || !online}
          className="ac-hover-accent"
          style={{
            flex: 2,
            minHeight: 44,
            border: 'none',
            borderRadius: 9,
            background: 'var(--accent)',
            color: 'var(--accent-ink)',
            fontSize: 13.5,
            fontWeight: 600,
            cursor: 'pointer',
            opacity: busy || !online ? 0.55 : 1,
          }}
        >
          Submit
        </button>
      </>
    );
  }
  return (
    <>
      <button
        type="button"
        onClick={onRun}
        disabled={busy || !online}
        title="Run selected test cases (Ctrl+Enter)"
        className="ac-hover-surface2"
        style={{
          height: 30,
          padding: '0 13px',
          border: '1px solid var(--border2)',
          borderRadius: 7,
          background: 'var(--editor-chrome)',
          color: 'var(--text)',
          fontSize: 12.5,
          fontWeight: 600,
          cursor: busy ? 'progress' : 'pointer',
          display: 'flex',
          alignItems: 'center',
          gap: 6,
          opacity: busy || !online ? 0.55 : 1,
        }}
      >
        {running ? <Spinner size={11} /> : <Icon.Play />}
        Run
      </button>
      <button
        type="button"
        onClick={onSubmit}
        disabled={busy || !online}
        title="Submit to the judge (Ctrl+Shift+Enter)"
        className="ac-hover-accent ac-active-press"
        style={{
          height: 30,
          padding: '0 14px',
          border: 'none',
          borderRadius: 7,
          background: 'var(--accent)',
          color: 'var(--accent-ink)',
          fontSize: 12.5,
          fontWeight: 600,
          cursor: busy ? 'progress' : 'pointer',
          display: 'flex',
          alignItems: 'center',
          gap: 6,
          opacity: busy || !online ? 0.55 : 1,
        }}
      >
        {submitting && <Spinner size={11} color="currentColor" />}
        Submit
      </button>
    </>
  );
}
