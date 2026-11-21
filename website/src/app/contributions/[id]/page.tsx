'use client';

import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { PageHeading } from '@/components/AppShell';
import { AdminProblemForm } from '@/components/admin/AdminProblemForm';
import { AdminDialog, adminCard } from '@/components/admin/AdminStates';
import { TestcaseManager } from '@/components/admin/TestcaseManager';
import { useToast } from '@/components/ToastProvider';
import { ErrorState, SkeletonBar, buttonStyles } from '@/components/ui';
import { ApiError, NetworkError, contributionProblemApi } from '@/lib/api';
import type { AdminProblemDetail, CreateAdminProblemRequest, UpdateAdminProblemRequest } from '@/lib/types';

function errorMessage(error: unknown, fallback = 'The contribution could not be loaded.') {
  if (error instanceof NetworkError) return 'The Problem Service could not be reached.';
  if (error instanceof ApiError) return error.message || `Request failed with ${error.httpStatus}.`;
  return fallback;
}

export default function ContributionDetailPage() {
  const params = useParams<{ id: string }>();
  const router = useRouter();
  const problemId = useMemo(() => Number(params.id), [params.id]);
  const { showToast } = useToast();
  const [problem, setProblem] = useState<AdminProblemDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const deletePending = useRef(false);

  const load = useCallback((signal?: AbortSignal) => {
    if (!Number.isSafeInteger(problemId) || problemId < 1) {
      setError('The contribution ID is invalid.');
      setLoading(false);
      return;
    }
    setLoading(true);
    setError('');
    contributionProblemApi
      .getOwn(problemId, signal)
      .then(setProblem)
      .catch((loadError) => {
        if (!signal?.aborted) setError(errorMessage(loadError));
      })
      .finally(() => {
        if (!signal?.aborted) setLoading(false);
      });
  }, [problemId]);

  useEffect(() => {
    const controller = new AbortController();
    load(controller.signal);
    return () => controller.abort();
  }, [load]);

  const updateProblem = async (body: CreateAdminProblemRequest | UpdateAdminProblemRequest) => {
    await contributionProblemApi.updateOwn(problemId, body as UpdateAdminProblemRequest);
    showToast('Problem draft updated', 'success');
    setProblem(await contributionProblemApi.getOwn(problemId));
  };

  const deleteDraft = async () => {
    if (deletePending.current) return;
    deletePending.current = true;
    setDeleting(true);
    try {
      await contributionProblemApi.deleteOwn(problemId);
      setConfirmDelete(false);
      showToast('Problem draft deleted', 'success');
      router.replace('/contributions');
    } catch (deleteError) {
      showToast(errorMessage(deleteError, 'The draft could not be deleted.'), 'error');
    } finally {
      setDeleting(false);
      deletePending.current = false;
    }
  };

  if (loading) {
    return (
      <div aria-label="Loading contribution" style={{ display: 'grid', gap: 12 }}>
        <SkeletonBar width="34%" height={28} />
        <SkeletonBar width="100%" height={220} />
      </div>
    );
  }
  if (error) return <ErrorState title="Could not load this contribution" detail={error} onRetry={() => load()} />;
  if (!problem) return <ErrorState title="Contribution not found" detail="No problem detail was returned." onRetry={() => load()} />;

  if (!problem.is_hidden) {
    return (
      <>
        <PageHeading title={problem.title} subtitle={`${problem.slug} · Published`} />
        <section style={{ ...adminCard, padding: 20 }}>
          <h2 style={{ margin: '0 0 8px', fontSize: 16 }}>Published contribution</h2>
          <p style={{ margin: '0 0 16px', color: 'var(--text2)', lineHeight: 1.6 }}>
            A Moderator or Admin can return this problem to draft.
          </p>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
            <Link href={`/problems/${encodeURIComponent(problem.slug)}`} className="ac-hover-accent" style={buttonStyles.primary(38)}>
              View problem
            </Link>
            <Link href="/contributions" className="ac-hover-surface2" style={buttonStyles.secondary(38)}>
              Back to contributions
            </Link>
          </div>
        </section>
      </>
    );
  }

  return (
    <>
      <PageHeading
        title={problem.title}
        subtitle={`${problem.slug} · Draft`}
        actions={
          <button type="button" onClick={() => setConfirmDelete(true)} style={buttonStyles.secondary(38)}>
            Delete draft
          </button>
        }
      />
      <AdminProblemForm
        mode="edit"
        problem={problem}
        cancelHref="/contributions"
        onSubmit={updateProblem}
      />
      <TestcaseManager
        problemId={problemId}
        testcase={problem.testcase}
        onUpload={async (file) => {
          await contributionProblemApi.uploadTestCase(problemId, file);
          setProblem(await contributionProblemApi.getOwn(problemId));
        }}
        onDelete={async () => {
          await contributionProblemApi.deleteTestCase(problemId);
          setProblem(await contributionProblemApi.getOwn(problemId));
        }}
      />
      {confirmDelete && (
        <AdminDialog title="Delete this draft?" onClose={() => !deleting && setConfirmDelete(false)}>
          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
            <button type="button" onClick={() => setConfirmDelete(false)} disabled={deleting} style={buttonStyles.secondary(38)}>
              Cancel
            </button>
            <button
              type="button"
              onClick={deleteDraft}
              disabled={deleting}
              aria-busy={deleting}
              style={{ ...buttonStyles.primary(38), background: 'var(--error)' }}
            >
              {deleting ? 'Deleting...' : 'Delete'}
            </button>
          </div>
        </AdminDialog>
      )}
    </>
  );
}
