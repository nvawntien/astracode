import { Spinner } from '@/components/ui';
import type { RunTestCaseResult } from '@/lib/types';
import { formatRunStatus } from '../runResult';
import { ResultTile } from './ResultTile';
import { runOutputBlock, testLabel } from './workspaceStyles';

interface RunCaseDetailsProps {
  result?: RunTestCaseResult;
  running: boolean;
}

export function RunCaseDetails({ result, running }: RunCaseDetailsProps) {
  if (running) {
    return (
      <div role="status" style={{ marginTop: 12, display: 'flex', alignItems: 'center', gap: 8 }}>
        <Spinner size={12} />
        <span style={{ fontSize: 12, color: 'var(--text3)', fontFamily: 'var(--font-mono)' }}>
          Running all visible test cases…
        </span>
      </div>
    );
  }

  if (!result) return null;

  const ok = result.status === 'accepted' || result.status === 'executed';
  return (
    <div
      style={{
        marginTop: 12,
        border: '1px solid var(--border)',
        borderRadius: 8,
        background: 'var(--code-bg)',
        padding: 10,
        display: 'grid',
        gap: 8,
      }}
    >
      <ResultTile value={formatRunStatus(result.status)} label="Status" />
      <ResultTile value={`${result.execution_time_ms} ms`} label="Runtime" />
      <ResultTile value={`${result.memory_used_kb} KB`} label="Memory" />
      <div>
        <div style={testLabel}>Actual Output</div>
        <pre style={runOutputBlock}>
          {result.stdout || result.stderr || (ok ? '' : 'No output')}
        </pre>
      </div>
    </div>
  );
}
