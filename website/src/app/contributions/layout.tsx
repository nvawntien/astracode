import type { ReactNode } from 'react';
import { ContributionsShell } from '@/components/contributions/ContributionsShell';

export default function ContributionsLayout({ children }: { children: ReactNode }) {
  return <ContributionsShell>{children}</ContributionsShell>;
}
