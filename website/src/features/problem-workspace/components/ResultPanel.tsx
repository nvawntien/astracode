import { Spinner } from '@/components/ui';
import {
  formatMemoryKb,
  formatRuntimeMs,
  formatTestcaseCount,
  isPendingStatus,
  languageMeta,
  verdictMeta,
} from '@/lib/format';
import type { SubmissionStreamState } from '@/lib/submission-stream';
import type { CodeDiagnostic, RunResponse, Submission, SubmissionDetail } from '@/lib/types';
import { formatRunStatus, isRunFailure } from '../runResult';
import { ResultTile } from './ResultTile';
import { runOutputBlock, settingsLabel, smallActionButton } from './workspaceStyles';

export type ResultSource = 'run' | 'submission';

interface ResultPanelProps {
  source: ResultSource | null;
  submitting: boolean;
  checkingResult: boolean;
  submission: Submission | null;
  streamState: SubmissionStreamState;
  liveUpdateError: string;
  detailFetchError: string;
  runResult: RunResponse | null;
  running: boolean;
  diagnostics: CodeDiagnostic[];
  onReconnectStream: () => void;
  onCheckResult: () => void;
  onSelectDiagnostic: (diagnostic: CodeDiagnostic) => void;
  onOpenSubmissions: () => void;
}

export function ResultPanel({
  source,
  submitting,
  checkingResult,
  submission: officialSubmission,
  streamState,
  liveUpdateError,
  detailFetchError,
  runResult: availableRunResult,
  running: runPending,
  diagnostics,
  onReconnectStream,
  onCheckResult,
  onSelectDiagnostic,
  onOpenSubmissions,
}: ResultPanelProps) {
  // Availability and asynchronous completion do not choose the display source.
  // Keep both data objects in their lifecycle owners; project only the selected
  // source into the existing presentation branches, including empty/error states.
  const submission = source === 'submission' ? officialSubmission : null;
  const runResult = source === 'run' ? availableRunResult : null;
  const running = source === 'run' && runPending;

  if (source === 'submission' && submitting && !submission) {
    return (
      <div
        role="status"
        style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '10px 0' }}
      >
        <Spinner />
        <span style={{ fontSize: 12.5, color: 'var(--text2)', fontFamily: 'var(--font-mono)' }}>
          Submitting your code…
        </span>
      </div>
    );
  }

  if (running) {
    return (
      <div
        role="status"
        style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '10px 0' }}
      >
        <Spinner />
        <span style={{ fontSize: 12.5, color: 'var(--text2)', fontFamily: 'var(--font-mono)' }}>
          Running your code…
        </span>
      </div>
    );
  }

  if (
    submission &&
    isPendingStatus(submission.status) &&
    (submitting || liveUpdateError || detailFetchError || streamState !== 'idle')
  ) {
    const queued = submission.status === 'PENDING';
    const reconnecting = streamState === 'reconnecting';
    const connecting = streamState === 'requesting_ticket' || streamState === 'connecting';
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        <div
          role="status"
          style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '10px 0' }}
        >
          {!liveUpdateError && <Spinner color={queued ? 'var(--accent)' : 'var(--success)'} />}
          <span style={{ fontSize: 12.5, color: 'var(--text2)', fontFamily: 'var(--font-mono)' }}>
            {liveUpdateError
              ? `Submission #${submission.id} is saved, but live updates are unavailable.`
              : reconnecting
                ? `Submission #${submission.id} reconnecting to live updates…`
                : connecting
                  ? `Submission #${submission.id} connecting to live updates…`
                  : queued
                    ? `Submission #${submission.id} queued — waiting for a judge worker…`
                    : `Submission #${submission.id} is being judged…`}
          </span>
        </div>

        {(liveUpdateError || detailFetchError) && (
          <div
            role="alert"
            style={{
              display: 'flex',
              flexWrap: 'wrap',
              alignItems: 'center',
              gap: 10,
              padding: '10px 12px',
              border: '1px solid var(--warn)',
              borderRadius: 10,
              background: 'var(--warn-bg)',
            }}
          >
            <span style={{ flex: 1, minWidth: 200, fontSize: 12.5 }}>
              {detailFetchError && (
                <span style={{ display: 'block', marginBottom: liveUpdateError ? 4 : 0 }}>
                  {detailFetchError}
                </span>
              )}
              {liveUpdateError && (
                <span>
                  {liveUpdateError} You can reconnect live updates or check the result once.
                </span>
              )}
            </span>
            {liveUpdateError && (
              <button
                type="button"
                onClick={onReconnectStream}
                className="ac-hover-surface2"
                style={smallActionButton}
              >
                Reconnect
              </button>
            )}
            <button
              type="button"
              onClick={onCheckResult}
              disabled={checkingResult}
              className="ac-hover-surface2"
              style={{ ...smallActionButton, opacity: checkingResult ? 0.6 : 1 }}
            >
              {checkingResult ? 'Checking…' : detailFetchError ? 'Retry detail' : 'Check result'}
            </button>
            {liveUpdateError && (
              <button
                type="button"
                onClick={onOpenSubmissions}
                className="ac-hover-surface2"
                style={smallActionButton}
              >
                View submissions
              </button>
            )}
          </div>
        )}
      </div>
    );
  }

  if (detailFetchError && submission) {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        <div
          role="alert"
          style={{
            display: 'flex',
            flexWrap: 'wrap',
            alignItems: 'center',
            gap: 10,
            padding: '10px 12px',
            border: '1px solid var(--warn)',
            borderRadius: 10,
            background: 'var(--warn-bg)',
          }}
        >
          <span style={{ flex: 1, minWidth: 200, fontSize: 12.5 }}>{detailFetchError}</span>
          <button
            type="button"
            onClick={onCheckResult}
            disabled={checkingResult}
            className="ac-hover-surface2"
            style={{ ...smallActionButton, opacity: checkingResult ? 0.6 : 1 }}
          >
            {checkingResult ? 'Checking…' : 'Retry detail'}
          </button>
        </div>
      </div>
    );
  }

  if (submission && !isPendingStatus(submission.status)) {
    const verdict = verdictMeta(submission.status);
    const diagnosticOutput = submissionDetailOutput(submission);

    return (
      <div style={{ animation: 'acFadeUp .3s ease' }}>
        <div
          style={{
            display: 'flex',
            flexWrap: 'wrap',
            alignItems: 'center',
            gap: 10,
            padding: '12px 14px',
            border: `1px solid ${verdict.color}`,
            borderRadius: 10,
            background: verdict.bg,
            marginBottom: 12,
          }}
        >
          <span
            aria-hidden="true"
            style={{
              width: 24,
              height: 24,
              borderRadius: verdict.shape,
              background: 'var(--surface)',
              color: verdict.color,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              fontSize: 13,
              fontWeight: 800,
              flexShrink: 0,
            }}
          >
            {verdict.icon}
          </span>
          <span style={{ fontSize: 14, fontWeight: 700, color: verdict.color }}>
            {verdict.label}
          </span>
          <span
            style={{
              marginLeft: 'auto',
              fontFamily: 'var(--font-mono)',
              fontSize: 11.5,
              color: verdict.color,
              whiteSpace: 'nowrap',
            }}
          >
            #{submission.id}
          </span>
        </div>

        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fit,minmax(150px,1fr))',
            gap: 10,
            marginBottom: 12,
          }}
        >
          <ResultTile value={languageMeta(submission.language).label} label="Language" />
          <ResultTile value={`#${submission.problem_id}`} label={submission.problem_title} />
          <ResultTile value={formatRuntimeMs(submission.execution_time_ms)} label="Runtime" />
          <ResultTile value={formatMemoryKb(submission.memory_used_kb)} label="Memory" />
          <ResultTile
            value={formatTestcaseCount(submission.passed_testcases, submission.total_testcases)}
            label="Test cases"
          />
          <ResultTile
            value={new Date(submission.updated_at).toLocaleTimeString()}
            label="Judged at"
          />
        </div>

        {diagnosticOutput && (
          <div style={{ marginBottom: 12 }}>
            <div style={settingsLabel}>{diagnosticOutput.label}</div>
            <pre style={runOutputBlock}>{diagnosticOutput.output}</pre>
          </div>
        )}

        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
          <button
            type="button"
            onClick={onOpenSubmissions}
            className="ac-hover-surface2"
            style={{
              height: 34,
              padding: '0 14px',
              border: '1px solid var(--border2)',
              borderRadius: 8,
              background: 'var(--surface)',
              color: 'var(--text)',
              fontSize: 12.5,
              fontWeight: 600,
              cursor: 'pointer',
            }}
          >
            View all submissions
          </button>
        </div>
      </div>
    );
  }

  if (runResult) {
    if (runResult.status === 'compile_error') {
      return (
        <div style={{ animation: 'acFadeUp .25s ease' }}>
          <div style={{ marginBottom: 10, fontSize: 13, fontWeight: 650, color: 'var(--warn)' }}>
            Compile Error
          </div>
          <pre style={runOutputBlock}>{runResult.compile_output || 'Compilation failed'}</pre>
          <DiagnosticList diagnostics={diagnostics} onSelect={onSelectDiagnostic} />
        </div>
      );
    }

    const passed = runResult.tests.filter((test) => !isRunFailure(test)).length;
    const allPassed = runResult.tests.length > 0 && passed === runResult.tests.length;
    return (
      <div style={{ animation: 'acFadeUp .25s ease' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10 }}>
          <span
            style={{
              fontSize: 13,
              fontWeight: 650,
              color: allPassed ? 'var(--success)' : 'var(--error)',
            }}
          >
            {allPassed ? '✓ All test cases passed' : `✕ ${runResult.tests.length - passed} failed`}
          </span>
          <span style={{ fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--text3)' }}>
            {passed}/{runResult.tests.length}
          </span>
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          {runResult.tests.map((test, index) => (
            <div
              key={test.id}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 10,
                padding: '8px 10px',
                border: '1px solid var(--border)',
                borderRadius: 8,
                background: 'var(--code-bg)',
              }}
            >
              <span
                role="img"
                aria-label={isRunFailure(test) ? 'Failed' : 'Passed'}
                style={{
                  width: 18,
                  height: 18,
                  borderRadius: isRunFailure(test) ? 4 : '50%',
                  background: isRunFailure(test) ? 'var(--error-bg)' : 'var(--success-bg)',
                  color: isRunFailure(test) ? 'var(--error)' : 'var(--success)',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  fontSize: 10,
                  fontWeight: 700,
                  flexShrink: 0,
                }}
              >
                {isRunFailure(test) ? '✕' : '✓'}
              </span>
              <span
                style={{
                  fontFamily: 'var(--font-mono)',
                  fontSize: 11,
                  color: 'var(--text3)',
                  flexShrink: 0,
                }}
              >
                {test.id}
              </span>
              <span
                style={{
                  fontFamily: 'var(--font-mono)',
                  fontSize: 11.5,
                  color: 'var(--syn-str)',
                  flex: 1,
                  minWidth: 0,
                  whiteSpace: 'nowrap',
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                }}
              >
                → {formatRunStatus(test.status)}
              </span>
              <span
                style={{ fontFamily: 'var(--font-mono)', fontSize: 10.5, color: 'var(--text3)' }}
              >
                {test.execution_time_ms} ms
              </span>
            </div>
          ))}
        </div>
        <DiagnosticList diagnostics={diagnostics} onSelect={onSelectDiagnostic} />
      </div>
    );
  }

  return (
    <p style={{ margin: '8px 0', fontSize: 12.5, color: 'var(--text3)' }}>
      Run your code against the test cases, or submit for the full judge.
    </p>
  );
}

interface DiagnosticListProps {
  diagnostics: CodeDiagnostic[];
  onSelect: (diagnostic: CodeDiagnostic) => void;
}

function DiagnosticList({ diagnostics, onSelect }: DiagnosticListProps) {
  if (diagnostics.length === 0) return null;

  return (
    <div
      role="list"
      aria-label="Code diagnostics"
      style={{
        marginTop: 12,
        border: '1px solid var(--error)',
        borderRadius: 10,
        background: 'var(--error-bg)',
        overflow: 'hidden',
      }}
    >
      {diagnostics.map((diagnostic, index) => (
        <button
          key={`${diagnostic.kind}-${diagnostic.testcase_id ?? 'compile'}-${diagnostic.line}-${diagnostic.column}-${index}`}
          type="button"
          role="listitem"
          onClick={() => onSelect(diagnostic)}
          className="ac-hover-surface2"
          style={{
            display: 'flex',
            width: '100%',
            gap: 10,
            alignItems: 'flex-start',
            padding: '9px 11px',
            border: 'none',
            borderTop:
              index === 0 ? 'none' : '1px solid color-mix(in srgb, var(--error) 25%, transparent)',
            background: 'transparent',
            color: 'var(--text)',
            textAlign: 'left',
            cursor: diagnostic.line > 0 ? 'pointer' : 'default',
          }}
        >
          <span
            aria-hidden="true"
            style={{
              width: 18,
              height: 18,
              borderRadius: 5,
              background: 'var(--surface)',
              color: 'var(--error)',
              display: 'inline-flex',
              alignItems: 'center',
              justifyContent: 'center',
              fontSize: 11,
              fontWeight: 800,
              flexShrink: 0,
            }}
          >
            !
          </span>
          <span style={{ flex: 1, minWidth: 0 }}>
            <span
              style={{
                display: 'block',
                fontFamily: 'var(--font-mono)',
                fontSize: 11.5,
                color: 'var(--error)',
              }}
            >
              {diagnostic.testcase_id ? `${diagnostic.testcase_id} · ` : ''}
              Line {diagnostic.line || '—'}, Column {diagnostic.column || 1}
            </span>
            <span style={{ display: 'block', marginTop: 2, fontSize: 12.5, color: 'var(--text2)' }}>
              {diagnostic.message}
            </span>
          </span>
        </button>
      ))}
    </div>
  );
}

function submissionDetailOutput(
  submission: Pick<Submission | SubmissionDetail, 'status' | 'compile_output' | 'error_message'>,
): { label: string; output: string } | null {
  if (submission.status === 'COMPILATION_ERROR' && submission.compile_output) {
    return { label: 'Compilation output', output: submission.compile_output };
  }
  if (submission.status === 'RUNTIME_ERROR' && submission.error_message) {
    return { label: 'Runtime error', output: submission.error_message };
  }
  if (submission.status === 'SYSTEM_ERROR' && submission.error_message) {
    return { label: 'System error', output: submission.error_message };
  }
  if (
    (submission.status === 'TIME_LIMIT_EXCEEDED' ||
      submission.status === 'MEMORY_LIMIT_EXCEEDED') &&
    submission.error_message
  ) {
    return { label: 'Message', output: submission.error_message };
  }
  if (submission.status === 'OUTPUT_LIMIT_EXCEEDED' && submission.error_message) {
    return { label: 'Message', output: submission.error_message };
  }
  return null;
}
