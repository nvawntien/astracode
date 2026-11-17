import type { RunTestCaseResult } from '@/lib/types';
import type { TestCase } from '../types';
import { RunCaseDetails } from './RunCaseDetails';
import { testField, testLabel } from './workspaceStyles';

interface TestcasePanelProps {
  tests: TestCase[];
  selected: number;
  results: Map<string, RunTestCaseResult>;
  running: boolean;
  onSelect: (index: number) => void;
  onAdd: () => void;
  onRemove: (index: number) => void;
  onUpdate: (index: number, patch: Partial<TestCase>) => void;
}

export function TestcasePanel({
  tests,
  selected,
  results,
  running,
  onSelect,
  onAdd,
  onRemove,
  onUpdate,
}: TestcasePanelProps) {
  const current = tests[selected];
  const currentResult = current ? results.get(current.id) : undefined;

  return (
    <>
      <div
        style={{
          display: 'flex',
          flexWrap: 'wrap',
          alignItems: 'center',
          gap: 6,
          marginBottom: 12,
        }}
      >
        {tests.map((test, index) => {
          const active = index === selected;
          return (
            <span
              key={index}
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                border: `1px solid ${active ? 'var(--accent)' : 'var(--border)'}`,
                background: active ? 'var(--accent-soft)' : 'var(--surface)',
                borderRadius: 8,
                overflow: 'hidden',
              }}
            >
              <button
                type="button"
                onClick={() => onSelect(index)}
                aria-pressed={active}
                style={{
                  height: 30,
                  padding: '0 11px',
                  border: 'none',
                  background: 'none',
                  fontSize: 12,
                  fontWeight: 600,
                  color: active ? 'var(--accent-fg)' : 'var(--text2)',
                  cursor: 'pointer',
                  fontFamily: 'var(--font-mono)',
                }}
              >
                {test.name}
              </button>
              {!test.fromExample && tests.length > 1 && (
                <button
                  type="button"
                  onClick={() => onRemove(index)}
                  aria-label={`Remove ${test.name}`}
                  className="ac-hover-error"
                  style={{
                    height: 30,
                    width: 24,
                    border: 'none',
                    background: 'none',
                    color: 'var(--text3)',
                    cursor: 'pointer',
                    fontSize: 10,
                  }}
                >
                  ✕
                </button>
              )}
            </span>
          );
        })}
        <button
          type="button"
          onClick={onAdd}
          className="ac-hover-dash"
          style={{
            height: 30,
            padding: '0 11px',
            border: '1px dashed var(--border2)',
            borderRadius: 8,
            background: 'none',
            color: 'var(--text2)',
            fontSize: 12,
            fontWeight: 600,
            cursor: 'pointer',
            whiteSpace: 'nowrap',
          }}
        >
          + Add case
        </button>
      </div>

      {current && (
        <>
          <label style={testLabel}>
            Input — {current.name}
            <textarea
              value={current.input}
              onChange={(event) => onUpdate(selected, { input: event.target.value })}
              readOnly={current.fromExample}
              rows={4}
              spellCheck={false}
              aria-label={`Test input for ${current.name}`}
              className="ac-field"
              style={testField}
            />
          </label>
          <label style={{ ...testLabel, marginTop: 10 }}>
            Expected output
            <textarea
              value={current.expected ?? ''}
              onChange={(event) =>
                onUpdate(selected, {
                  expected:
                    event.target.value === '' && current.kind === 'custom'
                      ? null
                      : event.target.value,
                })
              }
              readOnly={current.fromExample}
              rows={2}
              spellCheck={false}
              aria-label={`Expected output for ${current.name}`}
              className="ac-field"
              style={testField}
            />
          </label>
          <RunCaseDetails result={currentResult} running={running} />
        </>
      )}
    </>
  );
}
