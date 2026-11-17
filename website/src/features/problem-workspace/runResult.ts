import type { CodeDiagnostic, RunResponse, RunTestCaseResult } from '../../lib/types';

export function isRunFailure(test: RunTestCaseResult): boolean {
  return !['accepted', 'executed'].includes(test.status);
}

export function formatRunStatus(status: string): string {
  return status
    .split('_')
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}

export function collectRunDiagnostics(result: RunResponse): CodeDiagnostic[] {
  const seen = new Set<string>();
  const diagnostics: CodeDiagnostic[] = [];
  const add = (diagnostic: CodeDiagnostic) => {
    if (!diagnostic || diagnostic.line <= 0) return;
    const key = [
      diagnostic.testcase_id ?? '',
      diagnostic.kind,
      diagnostic.line,
      diagnostic.column,
      diagnostic.message,
    ].join('|');
    if (seen.has(key)) return;
    seen.add(key);
    diagnostics.push(diagnostic);
  };

  for (const diagnostic of result.diagnostics ?? []) add(diagnostic);
  for (const test of result.tests ?? []) {
    for (const diagnostic of test.diagnostics ?? []) add(diagnostic);
  }
  return diagnostics;
}

export function buildRunConsoleLines(result: RunResponse): { text: string; color: string }[] {
  if (result.status === 'compile_error') {
    return [{ text: result.compile_output || 'Compilation failed', color: 'var(--warn)' }];
  }

  const lines: { text: string; color: string }[] = [];
  for (const test of result.tests) {
    if (test.stdout)
      lines.push({ text: `[${test.id}] stdout\n${test.stdout}`, color: 'var(--code-fg)' });
    if (test.stderr)
      lines.push({ text: `[${test.id}] stderr\n${test.stderr}`, color: 'var(--error)' });
  }
  return lines;
}
