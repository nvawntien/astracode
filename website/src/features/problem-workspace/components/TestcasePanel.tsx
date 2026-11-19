import { useId } from 'react';
import { matchesRunCase } from '../runResult';
import { MAX_RUN_TESTCASES } from '../testcases';
import type { RunCases, RunOutcome, TestCase, TestCasePatch } from '../types';
import { RunCaseDetails } from './RunCaseDetails';
import { testField, testLabel } from './workspaceStyles';

interface TestcasePanelProps {
  tests: TestCase[];
  selected: number;
  includedIds: ReadonlySet<string>;
  pendingCases: RunCases | null;
  lastRun: RunOutcome | null;
  onSelect: (id: string) => void;
  onInclude: (id: string, included: boolean) => void;
  onAdd: () => void;
  onRemove: (id: string) => void;
  onUpdate: (id: string, patch: TestCasePatch) => void;
}

export function TestcasePanel({
  tests,
  selected,
  includedIds,
  pendingCases,
  lastRun,
  onSelect,
  onInclude,
  onAdd,
  onRemove,
  onUpdate,
}: TestcasePanelProps) {
  const summaryId = useId();
  const current = tests[selected];
  const cases = pendingCases ?? lastRun?.cases;
  const submitted = current && cases?.find((test) => test.id === current.id);
  const matches = submitted && matchesRunCase(current, submitted);
  const currentResult =
    !pendingCases && matches
      ? lastRun?.result.tests.find((test) => test.id === current.id && test.kind === current.kind)
      : undefined;
  let caseMessage = '';
  if (cases && !submitted) {
    caseMessage = pendingCases ? 'Not included in this Run' : 'Not included in the last Run';
  } else if (submitted && !matches) {
    caseMessage = pendingCases ? 'Changed since this Run started' : 'Changed since the last Run';
  } else if (submitted && !pendingCases && !currentResult) {
    caseMessage = 'No result for this case in the last Run';
  }

  return (
    <>
      <p id={summaryId} aria-live="polite" style={{ ...testLabel, margin: '4px 0 8px' }}>
        {includedIds.size} / {MAX_RUN_TESTCASES} selected · {tests.length} available
        {includedIds.size === 0 && <> — Select 1–10 test cases to run.</>}
        {includedIds.size === MAX_RUN_TESTCASES && tests.length > MAX_RUN_TESTCASES && (
          <> — Uncheck a case to include another.</>
        )}
      </p>
      <div
        role="group"
        aria-label="Test cases to run"
        aria-describedby={summaryId}
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
          const included = includedIds.has(test.id);
          return (
            <span
              key={test.id}
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                border: `1px solid ${active ? 'var(--accent)' : 'var(--border)'}`,
                background: active ? 'var(--accent-soft)' : 'var(--surface)',
                borderRadius: 8,
                overflow: 'hidden',
              }}
            >
              <label
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  padding: '0 4px 0 8px',
                  minHeight: 30,
                }}
              >
                <input
                  type="checkbox"
                  aria-label={`Include ${test.name} in Run${test.fromExample ? '' : ` (${test.id})`}`}
                  checked={included}
                  disabled={!included && includedIds.size >= MAX_RUN_TESTCASES}
                  onChange={(event) => onInclude(test.id, event.target.checked)}
                  style={{ margin: 0, accentColor: 'var(--accent)' }}
                />
              </label>
              <button
                type="button"
                onClick={() => onSelect(test.id)}
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
                  onClick={() => onRemove(test.id)}
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
              onChange={(event) => onUpdate(current.id, { input: event.target.value })}
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
                onUpdate(current.id, {
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
          {caseMessage && <p style={testLabel}>{caseMessage}</p>}
          <RunCaseDetails result={currentResult} running={Boolean(pendingCases && matches)} />
        </>
      )}
    </>
  );
}
