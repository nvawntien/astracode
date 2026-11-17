'use client';

import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Header } from '@/components/Header';
import { useAuth } from '@/components/AuthProvider';
import { useToast } from '@/components/ToastProvider';
import { CodeEditor } from '@/components/CodeEditor';
import {
  ProblemNotFound,
  ProblemPanel,
  ProblemPanelSkeleton,
  type ProblemTab,
} from '@/components/workspace/ProblemPanel';
import { Icon } from '@/components/ui';
import { ApiError, NetworkError, problemApi, submissionApi } from '@/lib/api';
import {
  LANGUAGES,
  formatDateTime,
  isPendingStatus,
  isTerminalSubmissionStatus,
  languageMeta,
  verdictMeta,
} from '@/lib/format';
import { useDismissable, useOnline, useViewportWidth } from '@/lib/hooks';
import { fetchProgress, invalidateProgress } from '@/lib/progress';
import { useSubmissionStream } from '@/lib/submission-stream';
import type {
  CodeDiagnostic,
  LanguageCode,
  Problem,
  Submission,
  SubmissionDetail,
  SubmissionStreamEvent,
} from '@/lib/types';

import { EditorToolbar } from '@/features/problem-workspace/components/EditorToolbar';
import { RunSubmitButtons } from '@/features/problem-workspace/components/RunSubmitButtons';
import { TestcasePanel } from '@/features/problem-workspace/components/TestcasePanel';
import { ResultPanel } from '@/features/problem-workspace/components/ResultPanel';
import { iconButton } from '@/features/problem-workspace/components/workspaceStyles';
import { useEditorDraft } from '@/features/problem-workspace/hooks/useEditorDraft';
import { useEditorPreferences } from '@/features/problem-workspace/hooks/useEditorPreferences';
import { useTestcases } from '@/features/problem-workspace/hooks/useTestcases';
import { useRunCode } from '@/features/problem-workspace/hooks/useRunCode';

type BottomTab = 'tests' | 'console' | 'result';
type LoadState = 'loading' | 'ready' | 'notfound' | 'error';

export default function WorkspacePage() {
  const params = useParams<{ slug: string }>();
  const slug = params?.slug ?? '';
  const router = useRouter();
  const { user, loading: authLoading } = useAuth();
  const { showToast } = useToast();
  const online = useOnline();
  const width = useViewportWidth();

  const stacked = width < 1020;
  const isMobile = width < 760;
  const [mobileView, setMobileView] = useState<'problem' | 'editor'>('problem');

  /* -------------------------------------------------------------- problem */

  const [problem, setProblem] = useState<Problem | null>(null);
  const [loadState, setLoadState] = useState<LoadState>('loading');
  const [loadError, setLoadError] = useState<string>('');
  const [tab, setTab] = useState<ProblemTab>('description');

  useEffect(() => {
    if (!slug) return;
    const controller = new AbortController();
    setLoadState('loading');

    problemApi
      .bySlug(slug, controller.signal)
      .then((res) => {
        setProblem(res);
        setLoadState('ready');
      })
      .catch((err) => {
        if (controller.signal.aborted) return;
        if (err instanceof ApiError && err.isNotFound) {
          setLoadState('notfound');
        } else {
          setLoadError(
            err instanceof NetworkError
              ? 'AstraCode is temporarily unreachable. Check your connection and try again.'
              : 'This problem could not be loaded.',
          );
          setLoadState('error');
        }
      });

    return () => controller.abort();
  }, [slug]);

  /* ------------------------------------------------------------- progress */

  const [solved, setSolved] = useState(false);
  const [attempted, setAttempted] = useState(false);

  const syncProgress = useCallback(
    async (force = false) => {
      if (!user || !problem) return;
      try {
        const progress = await fetchProgress(force);
        setSolved(progress.solvedIds.has(problem.id));
        setAttempted(progress.attemptedIds.has(problem.id));
      } catch {
        /* progress is decorative */
      }
    },
    [user, problem],
  );

  useEffect(() => {
    void syncProgress();
  }, [syncProgress]);

  /* --------------------------------------------------------------- editor */

  const [settingsOpen, setSettingsOpen] = useState(false);
  const [resetDialog, setResetDialog] = useState(false);
  const [jumpLine, setJumpLine] = useState<number | null>(null);
  const [codeDiagnostics, setCodeDiagnostics] = useState<CodeDiagnostic[]>([]);
  const [fullscreen, setFullscreen] = useState(false);
  const [restoreSubmission, setRestoreSubmission] = useState<SubmissionDetail | null>(null);
  const [historyRefreshKey, setHistoryRefreshKey] = useState(0);

  const settingsRef = useDismissable<HTMLDivElement>(settingsOpen, () => setSettingsOpen(false));

  const {
    language,
    setLanguage,
    changeLanguage: changeEditorLanguage,
    fontSize,
    tabSize,
    changeFontSize,
    changeTabSize,
  } = useEditorPreferences();

  // Diagnostics belong to execution; only draft/preferences state moves into hooks.
  useEffect(() => {
    if (!problem) return;
    setCodeDiagnostics([]);
    setJumpLine(null);
  }, [problem, language]);

  const { code, setCode, draftSavedAt, resetCode, restoreDraft } = useEditorDraft({
    problem,
    language,
    setLanguage,
  });

  const changeLanguage = (next: LanguageCode) => {
    changeEditorLanguage(next);
    setCodeDiagnostics([]);
    setJumpLine(null);
  };

  const restoreSubmissionCode = useCallback(
    (detail: SubmissionDetail) => {
      if (!problem) return;
      const nextLanguage = detail.language.toUpperCase() as LanguageCode;
      if (!LANGUAGES.some((item) => item.code === nextLanguage)) {
        showToast(`Cannot restore unsupported language: ${detail.language}`, 'error');
        return;
      }

      restoreDraft(nextLanguage, detail.source_code);
      setCodeDiagnostics([]);
      setJumpLine(null);
      setRestoreSubmission(null);
      setBottomOpen(true);
      setBottomTab('tests');
      if (stacked) setMobileView('editor');
      showToast(`Submission #${detail.id} restored to the editor`, 'success');
    },
    [problem, restoreDraft, showToast, stacked],
  );

  const requestRestoreSubmissionCode = useCallback(
    (detail: SubmissionDetail) => {
      const nextLanguage = detail.language.toUpperCase() as LanguageCode;
      const willReplaceDraft = code !== detail.source_code || language !== nextLanguage;
      if (willReplaceDraft) {
        setRestoreSubmission(detail);
        return;
      }
      restoreSubmissionCode(detail);
    },
    [code, language, restoreSubmissionCode],
  );

  /* ---------------------------------------------------------------- tests */

  const {
    tests,
    selectedTest,
    setSelectedTest,
    updateTest,
    addTest,
    removeTest,
    addExample,
    selectRunResult,
  } = useTestcases({ problem, showToast });

  /* --------------------------------------------------------- run & submit */

  const [bottomTab, setBottomTab] = useState<BottomTab>('tests');
  const [bottomOpen, setBottomOpen] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [checkingResult, setCheckingResult] = useState(false);
  const [submission, setSubmission] = useState<Submission | null>(null);
  const [activeSubmissionId, setActiveSubmissionId] = useState<number | null>(null);
  const [liveUpdateError, setLiveUpdateError] = useState('');
  const [detailFetchError, setDetailFetchError] = useState('');
  const terminalDetailHandledRef = useRef(false);
  const terminalDetailAbortRef = useRef<AbortController | null>(null);

  useEffect(
    () => () => {
      terminalDetailAbortRef.current?.abort();
    },
    [],
  );

  useEffect(() => {
    terminalDetailAbortRef.current?.abort();
    terminalDetailHandledRef.current = false;
    setActiveSubmissionId(null);
    setSubmitting(false);
    setCheckingResult(false);
    setSubmission(null);
    setLiveUpdateError('');
    setDetailFetchError('');
  }, [slug]);

  useEffect(() => {
    if (user) return;
    terminalDetailAbortRef.current?.abort();
    terminalDetailHandledRef.current = false;
    setActiveSubmissionId(null);
    setSubmitting(false);
    setCheckingResult(false);
  }, [user]);

  const requireAuth = (action: string): boolean => {
    if (user) return true;
    showToast(`Sign in to ${action}`, 'error');
    router.push(`/login?next=/problems/${slug}`);
    return false;
  };

  const { running, runResult, consoleLines, run, setRunResult } = useRunCode({
    problem,
    language,
    code,
    tests,
    submitting,
    online,
    requireAuth,
    showToast,
    onStart: () => {
      setCodeDiagnostics([]);
      setJumpLine(null);
      setBottomTab('result');
    },
    onResult: (result, diagnostics) => {
      setCodeDiagnostics(diagnostics);
      if (diagnostics[0]?.line) setJumpLine(diagnostics[0].line);
      selectRunResult(result);
    },
    onUnavailable: () => setBottomTab('console'),
  });

  const applyStreamStatus = useCallback((event: SubmissionStreamEvent) => {
    setSubmission((current) => {
      if (!current || current.id !== event.submission_id) return current;
      return {
        ...current,
        status: event.status,
        updated_at: event.updated_at,
      };
    });
  }, []);

  const finishSubmissionFromDetail = useCallback(
    (detail: Submission) => {
      setSubmission(detail);
      setSubmitting(false);
      setActiveSubmissionId(null);
      setLiveUpdateError('');
      setDetailFetchError('');
      setHistoryRefreshKey((current) => current + 1);
      const verdict = verdictMeta(detail.status);
      showToast(
        detail.status === 'ACCEPTED' ? 'Accepted' : `Verdict: ${verdict.label}`,
        detail.status === 'ACCEPTED' ? 'success' : 'error',
      );
      invalidateProgress();
      void syncProgress(true);
    },
    [showToast, syncProgress],
  );

  const fetchTerminalSubmissionDetail = useCallback(
    async (id: number, terminalEvent?: SubmissionStreamEvent) => {
      if (terminalDetailHandledRef.current) return;
      terminalDetailHandledRef.current = true;
      terminalDetailAbortRef.current?.abort();
      const controller = new AbortController();
      terminalDetailAbortRef.current = controller;

      if (terminalEvent) {
        setSubmission((current) => {
          if (!current || current.id !== terminalEvent.submission_id) return current;
          return {
            ...current,
            status: terminalEvent.status,
            updated_at: terminalEvent.updated_at,
          };
        });
      }

      try {
        const detail = await submissionApi.get(id, controller.signal);
        if (controller.signal.aborted) return;
        finishSubmissionFromDetail(detail);
      } catch (err) {
        if (controller.signal.aborted) return;
        setSubmitting(false);
        setActiveSubmissionId(null);
        setDetailFetchError(
          err instanceof NetworkError
            ? 'Verdict received, but submission details could not be loaded. Check your connection and try again.'
            : err instanceof ApiError
              ? err.message || 'Verdict received, but submission detail could not be loaded.'
              : 'Verdict received, but submission detail could not be loaded.',
        );
      } finally {
        if (terminalDetailAbortRef.current === controller) {
          terminalDetailAbortRef.current = null;
        }
      }
    },
    [finishSubmissionFromDetail],
  );

  const checkResultOnce = useCallback(async () => {
    if (!submission || checkingResult) return;
    setCheckingResult(true);
    setDetailFetchError('');
    try {
      const latest = await submissionApi.get(submission.id);
      setSubmission(latest);
      if (isTerminalSubmissionStatus(latest.status)) {
        finishSubmissionFromDetail(latest);
      } else {
        showToast(
          `Submission #${latest.id} is still ${verdictMeta(latest.status).label.toLowerCase()}.`,
          'success',
        );
      }
    } catch (err) {
      if (err instanceof NetworkError) {
        setDetailFetchError(
          'AstraCode is temporarily unreachable. Check your connection and try again.',
        );
      } else if (err instanceof ApiError) {
        setDetailFetchError(err.message || 'Could not read the submission.');
      } else {
        setDetailFetchError('Could not read the submission.');
      }
    } finally {
      setCheckingResult(false);
    }
  }, [checkingResult, finishSubmissionFromDetail, showToast, submission]);

  const handleStreamTerminal = useCallback(
    (event: SubmissionStreamEvent) => {
      applyStreamStatus(event);
      void fetchTerminalSubmissionDetail(event.submission_id, event);
    },
    [applyStreamStatus, fetchTerminalSubmissionDetail],
  );

  const handleStreamError = useCallback((error: { message: string }) => {
    setLiveUpdateError(error.message);
    setSubmitting(false);
  }, []);

  const stream = useSubmissionStream({
    submissionId: activeSubmissionId,
    enabled: Boolean(activeSubmissionId && submission && isPendingStatus(submission.status)),
    onStatus: applyStreamStatus,
    onTerminal: handleStreamTerminal,
    onError: handleStreamError,
  });

  const submit = async () => {
    if (!problem || submitting || running) return;
    if (!requireAuth('submit')) return;
    if (!online) {
      showToast('You appear to be offline', 'error');
      return;
    }
    if (!code.trim()) {
      showToast('Write some code before submitting', 'error');
      return;
    }

    setSubmitting(true);
    terminalDetailAbortRef.current?.abort();
    terminalDetailHandledRef.current = false;
    setActiveSubmissionId(null);
    setLiveUpdateError('');
    setDetailFetchError('');
    setSubmission(null);
    setRunResult(null);
    setCodeDiagnostics([]);
    setJumpLine(null);
    setBottomTab('result');
    setBottomOpen(true);

    try {
      const created = await submissionApi.create({
        problem_id: problem.id,
        language,
        source_code: code,
      });
      setSubmission({
        id: created.id,
        problem_id: created.problem_id,
        problem_title: created.problem_title,
        user_id: user?.id ?? '',
        username: user?.username ?? '',
        language: created.language,
        source_code: code,
        status: created.status,
        execution_time_ms: null,
        memory_used_kb: null,
        passed_testcases: null,
        total_testcases: null,
        compile_output: null,
        error_message: null,
        created_at: created.created_at,
        updated_at: created.created_at,
      });
      if (isTerminalSubmissionStatus(created.status)) {
        void fetchTerminalSubmissionDetail(created.id);
      } else {
        setActiveSubmissionId(created.id);
      }
    } catch (err) {
      setSubmitting(false);
      if (err instanceof NetworkError) {
        showToast(
          'AstraCode is temporarily unreachable. Check your connection and try again.',
          'error',
        );
      } else if (err instanceof ApiError) {
        showToast(err.message || 'Submission rejected', 'error');
      } else {
        showToast('Submission failed', 'error');
      }
    }
  };

  // Ctrl/Cmd+Enter runs, Ctrl/Cmd+Shift+Enter submits.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (!(event.ctrlKey || event.metaKey) || event.key !== 'Enter') return;
      event.preventDefault();
      if (event.shiftKey) void submit();
      else void run();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  });

  /* ---------------------------------------------------------------- split */

  const [splitPct, setSplitPct] = useState(52);
  const [bottomPx, setBottomPx] = useState(235);
  const draggingRef = useRef<'h' | 'v' | null>(null);
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

  const startDrag = (mode: 'h' | 'v') => (event: React.MouseEvent) => {
    event.preventDefault();
    draggingRef.current = mode;
    document.body.style.userSelect = 'none';
  };

  /* -------------------------------------------------------------- derived */

  const langMeta = languageMeta(language);
  const busy = running || submitting || checkingResult;
  const runResultsByID = useMemo(() => {
    const entries = runResult?.tests.map((test) => [test.id, test] as const) ?? [];
    return new Map(entries);
  }, [runResult]);

  const bottomTabs: { key: BottomTab; label: string }[] = useMemo(
    () => [
      { key: 'tests', label: `Tests (${tests.length})` },
      { key: 'console', label: 'Console' },
      { key: 'result', label: 'Result' },
    ],
    [tests.length],
  );

  const leftVisible = !fullscreen && (!stacked || mobileView === 'problem');
  const rightVisible = !stacked || mobileView === 'editor' || fullscreen;

  /* -------------------------------------------------------------- render */

  if (loadState === 'loading' || (authLoading && !problem)) {
    return (
      <div style={{ minHeight: '100vh', background: 'var(--bg)' }}>
        <Header />
        <ProblemPanelSkeleton />
      </div>
    );
  }

  if (loadState === 'notfound') {
    return (
      <div style={{ minHeight: '100vh', background: 'var(--bg)' }}>
        <Header />
        <ProblemNotFound slug={slug} />
      </div>
    );
  }

  if (loadState === 'error' || !problem) {
    return (
      <div style={{ minHeight: '100vh', background: 'var(--bg)' }}>
        <Header />
        <div style={{ padding: '64px 24px', textAlign: 'center' }}>
          <p style={{ margin: '0 0 6px', fontSize: 14, fontWeight: 600 }}>
            Couldn&apos;t load the problem
          </p>
          <p
            style={{
              margin: '0 0 16px',
              fontSize: 12.5,
              color: 'var(--text3)',
              fontFamily: 'var(--font-mono)',
            }}
          >
            {loadError}
          </p>
          <Link href="/problems" style={{ fontSize: 13, fontWeight: 600 }}>
            ← Back to problems
          </Link>
        </div>
      </div>
    );
  }

  return (
    <div
      style={{
        minHeight: '100vh',
        background: 'var(--bg)',
        display: 'flex',
        flexDirection: 'column',
      }}
    >
      <Header />

      <main
        style={{
          height: 'calc(100vh - 57px)',
          display: 'flex',
          flexDirection: 'column',
          overflow: 'hidden',
          animation: 'acFadeUp .25s ease',
        }}
      >
        {stacked && (
          <div
            role="tablist"
            aria-label="Workspace views"
            style={{
              display: 'flex',
              gap: 4,
              padding: '6px 10px',
              borderBottom: '1px solid var(--border)',
              background: 'var(--surface)',
              flexShrink: 0,
            }}
          >
            {(['problem', 'editor'] as const).map((view) => {
              const active = mobileView === view;
              return (
                <button
                  key={view}
                  type="button"
                  role="tab"
                  aria-selected={active}
                  onClick={() => setMobileView(view)}
                  style={{
                    flex: 1,
                    minHeight: 44,
                    border: 'none',
                    borderRadius: 8,
                    background: active ? 'var(--accent-soft)' : 'transparent',
                    color: active ? 'var(--accent-fg)' : 'var(--text2)',
                    fontSize: 13,
                    fontWeight: active ? 600 : 500,
                    cursor: 'pointer',
                  }}
                >
                  {view === 'problem' ? 'Problem' : 'Code'}
                </button>
              );
            })}
          </div>
        )}

        <div ref={shellRef} style={{ flex: 1, display: 'flex', minHeight: 0 }}>
          {leftVisible && (
            <div
              style={{
                width: stacked ? '100%' : `${splitPct}%`,
                height: '100%',
                display: 'flex',
                flexDirection: 'column',
                minWidth: 0,
                background: 'var(--surface)',
                borderRight: stacked ? 'none' : '1px solid var(--border)',
                overflow: 'hidden',
              }}
            >
              <ProblemPanel
                problem={problem}
                tab={tab}
                onTabChange={setTab}
                solved={solved}
                attempted={attempted}
                signedIn={Boolean(user)}
                historyRefreshKey={historyRefreshKey}
                onUseExample={(input, expected) => {
                  addExample(input, expected);
                  setBottomTab('tests');
                  setBottomOpen(true);
                  showToast('Example added as a custom test', 'success');
                  if (stacked) setMobileView('editor');
                }}
                onUseSubmissionCode={requestRestoreSubmissionCode}
              />
            </div>
          )}

          {!stacked && !fullscreen && (
            <div
              onMouseDown={startDrag('h')}
              onDoubleClick={() => setSplitPct(52)}
              role="separator"
              aria-orientation="vertical"
              aria-label="Resize panels — drag, or double-click to reset"
              tabIndex={0}
              title="Drag to resize · double-click to reset"
              className="ac-hover-accent-soft2"
              style={{
                width: 8,
                cursor: 'col-resize',
                background: 'var(--surface2)',
                display: 'flex',
                flexDirection: 'column',
                alignItems: 'center',
                justifyContent: 'center',
                gap: 3,
                flexShrink: 0,
                transition: 'background .12s',
              }}
            >
              {[0, 1, 2].map((dot) => (
                <span
                  key={dot}
                  style={{ width: 3, height: 3, borderRadius: '50%', background: 'var(--border2)' }}
                />
              ))}
            </div>
          )}

          {rightVisible && (
            <div
              style={{
                width: stacked || fullscreen ? '100%' : `${100 - splitPct}%`,
                height: '100%',
                display: 'flex',
                flexDirection: 'column',
                minWidth: 0,
                background: 'var(--code-bg)',
                overflow: 'hidden',
              }}
            >
              {!online && (
                <div
                  role="alert"
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 9,
                    padding: '8px 14px',
                    background: 'var(--warn-bg)',
                    borderBottom: '1px solid var(--warn)',
                    flexShrink: 0,
                  }}
                >
                  <span
                    aria-hidden="true"
                    style={{ width: 7, height: 7, borderRadius: '50%', background: 'var(--warn)' }}
                  />
                  <span style={{ fontSize: 12, fontWeight: 550 }}>
                    Network disconnected — code is saved locally; Run and Submit are disabled until
                    you reconnect.
                  </span>
                </div>
              )}

              <EditorToolbar
                language={language}
                draftSavedAt={draftSavedAt}
                fontSize={fontSize}
                tabSize={tabSize}
                settingsOpen={settingsOpen}
                settingsRef={settingsRef}
                stacked={stacked}
                fullscreen={fullscreen}
                onLanguageChange={changeLanguage}
                onFontSizeChange={changeFontSize}
                onTabSizeChange={changeTabSize}
                onToggleSettings={() => setSettingsOpen(!settingsOpen)}
                onReset={() => setResetDialog(true)}
                onToggleFullscreen={() => setFullscreen(!fullscreen)}
              />

              <CodeEditor
                value={code}
                onChange={(next) => {
                  setCode(next);
                  setCodeDiagnostics([]);
                  setJumpLine(null);
                }}
                language={language}
                fontSize={fontSize}
                tabSize={tabSize}
                highlightLine={jumpLine}
                diagnostics={codeDiagnostics}
              />

              <div
                onMouseDown={startDrag('v')}
                onDoubleClick={() => setBottomPx(235)}
                role="separator"
                aria-orientation="horizontal"
                aria-label="Resize result panel — drag, or double-click to reset"
                tabIndex={0}
                className="ac-hover-accent-soft2"
                style={{
                  height: 8,
                  cursor: 'row-resize',
                  background: 'var(--surface2)',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  flexShrink: 0,
                  borderTop: '1px solid var(--border)',
                }}
              >
                <span
                  style={{ width: 34, height: 3, borderRadius: 2, background: 'var(--border2)' }}
                />
              </div>

              <div
                style={{
                  flexShrink: 0,
                  height: bottomOpen ? bottomPx : 39,
                  borderTop: '1px solid var(--border)',
                  background: 'var(--surface)',
                  display: 'flex',
                  flexDirection: 'column',
                  maxHeight: '60%',
                  minHeight: 0,
                }}
              >
                <div
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 2,
                    padding: '0 12px',
                    borderBottom: '1px solid var(--border)',
                    overflowX: 'auto',
                    flexShrink: 0,
                  }}
                >
                  {bottomTabs.map((item) => {
                    const active = bottomTab === item.key;
                    return (
                      <button
                        key={item.key}
                        type="button"
                        role="tab"
                        aria-selected={active}
                        onClick={() => {
                          setBottomTab(item.key);
                          setBottomOpen(true);
                        }}
                        className="ac-hover-text"
                        style={{
                          height: 36,
                          padding: '0 11px',
                          border: 'none',
                          borderBottom: `2px solid ${active ? 'var(--accent)' : 'transparent'}`,
                          background: 'none',
                          cursor: 'pointer',
                          fontSize: 12,
                          fontWeight: 600,
                          color: active ? 'var(--text)' : 'var(--text3)',
                          whiteSpace: 'nowrap',
                        }}
                      >
                        {item.label}
                      </button>
                    );
                  })}

                  {!isMobile && (
                    <div style={{ marginLeft: 'auto', display: 'flex', gap: 7, padding: '4px 0' }}>
                      <RunSubmitButtons
                        variant="desktop"
                        busy={busy}
                        online={online}
                        running={running}
                        submitting={submitting}
                        onRun={run}
                        onSubmit={submit}
                      />
                      <button
                        type="button"
                        onClick={() => setBottomOpen(!bottomOpen)}
                        aria-label={bottomOpen ? 'Collapse panel' : 'Expand panel'}
                        aria-expanded={bottomOpen}
                        className="ac-hover-surface2"
                        style={{ ...iconButton, flexShrink: 0 }}
                      >
                        <span
                          style={{
                            display: 'flex',
                            transform: bottomOpen ? 'none' : 'rotate(180deg)',
                            transition: 'transform .2s',
                          }}
                        >
                          <Icon.Chevron size={13} />
                        </span>
                      </button>
                    </div>
                  )}
                </div>

                {bottomOpen && (
                  <div style={{ overflowY: 'auto', padding: '10px 14px', flex: 1, minHeight: 0 }}>
                    {bottomTab === 'tests' && (
                      <TestcasePanel
                        tests={tests}
                        selected={selectedTest}
                        results={runResultsByID}
                        running={running}
                        onSelect={setSelectedTest}
                        onAdd={addTest}
                        onRemove={removeTest}
                        onUpdate={updateTest}
                      />
                    )}

                    {bottomTab === 'console' && (
                      <>
                        {consoleLines.length > 0 ? (
                          <div
                            style={{
                              fontFamily: 'var(--font-mono)',
                              fontSize: 12,
                              lineHeight: 1.8,
                              color: 'var(--code-fg)',
                            }}
                          >
                            {consoleLines.map((line, index) => (
                              <div
                                key={index}
                                style={{ color: line.color, whiteSpace: 'pre-wrap' }}
                              >
                                {line.text}
                              </div>
                            ))}
                          </div>
                        ) : (
                          <p style={{ margin: '8px 0', fontSize: 12.5, color: 'var(--text3)' }}>
                            Run your code to see program output and judge logs here.
                          </p>
                        )}
                      </>
                    )}

                    {bottomTab === 'result' && (
                      <ResultPanel
                        submitting={submitting}
                        checkingResult={checkingResult}
                        submission={submission}
                        streamState={stream.state}
                        liveUpdateError={liveUpdateError || stream.error?.message || ''}
                        detailFetchError={detailFetchError}
                        runResult={runResult}
                        running={running}
                        diagnostics={codeDiagnostics}
                        onReconnectStream={stream.reconnect}
                        onCheckResult={checkResultOnce}
                        onSelectDiagnostic={(diagnostic) => {
                          if (diagnostic.line > 0) {
                            setJumpLine(diagnostic.line);
                            if (stacked) setMobileView('editor');
                          }
                        }}
                        onOpenSubmissions={() => {
                          setTab('submissions');
                          if (stacked) setMobileView('problem');
                        }}
                      />
                    )}
                  </div>
                )}
              </div>

              {isMobile && (
                <div
                  style={{
                    flexShrink: 0,
                    display: 'flex',
                    gap: 10,
                    padding: '10px 14px',
                    borderTop: '1px solid var(--border)',
                    background: 'var(--surface)',
                  }}
                >
                  <RunSubmitButtons
                    variant="mobile"
                    busy={busy}
                    online={online}
                    running={running}
                    submitting={submitting}
                    onRun={run}
                    onSubmit={submit}
                  />
                </div>
              )}
            </div>
          )}
        </div>
      </main>

      {resetDialog && (
        <div
          style={{
            position: 'fixed',
            inset: 0,
            zIndex: 70,
            background: 'rgba(15,10,35,.45)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            padding: 20,
          }}
          onClick={() => setResetDialog(false)}
        >
          <div
            role="dialog"
            aria-modal="true"
            aria-label="Reset code"
            onClick={(event) => event.stopPropagation()}
            style={{
              background: 'var(--surface)',
              border: '1px solid var(--border)',
              borderRadius: 14,
              boxShadow: 'var(--shadow-lg)',
              padding: 22,
              width: '100%',
              maxWidth: 400,
              animation: 'acPop .18s ease',
            }}
          >
            <h2 style={{ margin: '0 0 6px', fontSize: 15.5, fontWeight: 650 }}>Reset your code?</h2>
            <p style={{ margin: '0 0 18px', fontSize: 13, color: 'var(--text2)' }}>
              This replaces the editor contents with the default {langMeta.label} template. Your
              current changes will be lost.
            </p>
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
              <button
                type="button"
                onClick={() => setResetDialog(false)}
                className="ac-hover-surface2"
                style={{
                  height: 36,
                  padding: '0 14px',
                  border: '1px solid var(--border)',
                  borderRadius: 8,
                  background: 'var(--surface)',
                  color: 'var(--text2)',
                  fontSize: 13,
                  fontWeight: 600,
                  cursor: 'pointer',
                }}
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={() => {
                  resetCode();
                  setResetDialog(false);
                  showToast('Code reset to the template', 'info');
                }}
                className="ac-hover-opacity"
                style={{
                  height: 36,
                  padding: '0 14px',
                  border: 'none',
                  borderRadius: 8,
                  background: 'var(--error)',
                  color: '#fff',
                  fontSize: 13,
                  fontWeight: 600,
                  cursor: 'pointer',
                }}
              >
                Reset code
              </button>
            </div>
          </div>
        </div>
      )}

      {restoreSubmission && (
        <div
          style={{
            position: 'fixed',
            inset: 0,
            zIndex: 70,
            background: 'rgba(15,10,35,.45)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            padding: 20,
          }}
          onClick={() => setRestoreSubmission(null)}
        >
          <div
            role="dialog"
            aria-modal="true"
            aria-label="Replace editor code"
            onClick={(event) => event.stopPropagation()}
            style={{
              background: 'var(--surface)',
              border: '1px solid var(--border)',
              borderRadius: 14,
              boxShadow: 'var(--shadow-lg)',
              padding: 22,
              width: '100%',
              maxWidth: 420,
              animation: 'acPop .18s ease',
            }}
          >
            <h2 style={{ margin: '0 0 6px', fontSize: 15.5, fontWeight: 650 }}>
              Replace current editor code?
            </h2>
            <p style={{ margin: '0 0 10px', fontSize: 13, color: 'var(--text2)' }}>
              Your current draft will be replaced with submission #{restoreSubmission.id}.
            </p>
            <p
              style={{
                margin: '0 0 18px',
                fontFamily: 'var(--font-mono)',
                fontSize: 11.5,
                color: 'var(--text3)',
              }}
            >
              {languageMeta(restoreSubmission.language).label} ·{' '}
              {formatDateTime(restoreSubmission.created_at)}
            </p>
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
              <button
                type="button"
                onClick={() => setRestoreSubmission(null)}
                className="ac-hover-surface2"
                style={{
                  height: 36,
                  padding: '0 14px',
                  border: '1px solid var(--border)',
                  borderRadius: 8,
                  background: 'var(--surface)',
                  color: 'var(--text2)',
                  fontSize: 13,
                  fontWeight: 600,
                  cursor: 'pointer',
                }}
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={() => restoreSubmissionCode(restoreSubmission)}
                className="ac-hover-accent"
                style={{
                  height: 36,
                  padding: '0 14px',
                  border: 'none',
                  borderRadius: 8,
                  background: 'var(--accent)',
                  color: 'var(--accent-ink)',
                  fontSize: 13,
                  fontWeight: 600,
                  cursor: 'pointer',
                }}
              >
                Use this code
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
