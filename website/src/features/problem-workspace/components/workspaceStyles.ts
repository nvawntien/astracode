import type { CSSProperties } from 'react';

export const iconButton: CSSProperties = {
  width: 30,
  height: 30,
  borderRadius: 7,
  border: '1px solid var(--code-line)',
  background: 'var(--editor-chrome)',
  color: 'var(--text2)',
  cursor: 'pointer',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
};

export const smallActionButton: CSSProperties = {
  height: 32,
  padding: '0 13px',
  border: '1px solid var(--border2)',
  borderRadius: 8,
  background: 'var(--surface)',
  color: 'var(--text)',
  fontSize: 12,
  fontWeight: 600,
  cursor: 'pointer',
};

export const settingsLabel: CSSProperties = {
  display: 'block',
  fontSize: 11,
  fontWeight: 650,
  color: 'var(--text3)',
  textTransform: 'uppercase',
  letterSpacing: '.06em',
  marginBottom: 6,
};

export const testLabel: CSSProperties = {
  display: 'block',
  fontSize: 11,
  fontWeight: 650,
  color: 'var(--text3)',
  textTransform: 'uppercase',
  letterSpacing: '.06em',
};

export const testField: CSSProperties = {
  display: 'block',
  width: '100%',
  boxSizing: 'border-box',
  resize: 'vertical',
  border: '1px solid var(--border)',
  borderRadius: 8,
  background: 'var(--code-bg)',
  color: 'var(--code-fg)',
  fontFamily: 'var(--font-mono)',
  fontSize: 12.5,
  padding: '9px 11px',
  lineHeight: 1.6,
  marginTop: 6,
};

export const runOutputBlock: CSSProperties = {
  margin: '5px 0 0',
  minHeight: 34,
  maxHeight: 120,
  overflow: 'auto',
  whiteSpace: 'pre-wrap',
  fontFamily: 'var(--font-mono)',
  fontSize: 12,
  lineHeight: 1.6,
  color: 'var(--code-fg)',
};
