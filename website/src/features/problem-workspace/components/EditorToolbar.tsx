import type { ChangeEventHandler, RefObject } from 'react';
import { Icon } from '@/components/ui';
import { LANGUAGES, languageMeta } from '@/lib/format';
import type { LanguageCode } from '@/lib/types';
import { iconButton, settingsLabel } from './workspaceStyles';

interface EditorToolbarProps {
  language: LanguageCode;
  draftSavedAt: number | null;
  fontSize: number;
  tabSize: number;
  settingsOpen: boolean;
  settingsRef: RefObject<HTMLDivElement | null>;
  stacked: boolean;
  fullscreen: boolean;
  onLanguageChange: (language: LanguageCode) => void;
  onFontSizeChange: ChangeEventHandler<HTMLInputElement>;
  onTabSizeChange: ChangeEventHandler<HTMLSelectElement>;
  onToggleSettings: () => void;
  onReset: () => void;
  onToggleFullscreen: () => void;
}

export function EditorToolbar({
  language,
  draftSavedAt,
  fontSize,
  tabSize,
  settingsOpen,
  settingsRef,
  stacked,
  fullscreen,
  onLanguageChange,
  onFontSizeChange,
  onTabSizeChange,
  onToggleSettings,
  onReset,
  onToggleFullscreen,
}: EditorToolbarProps) {
  const langMeta = languageMeta(language);
  return (
    <div
      className="ac-workspace-editor-toolbar"
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 7,
        padding: '6px 10px',
        borderBottom: '1px solid var(--code-line)',
        background: 'var(--editor-chrome)',
        flexShrink: 0,
      }}
    >
      <select
        value={language}
        onChange={(event) => onLanguageChange(event.target.value as LanguageCode)}
        aria-label="Programming language"
        style={{
          height: 30,
          borderRadius: 6,
          border: '1px solid var(--code-line)',
          background: 'var(--code-bg)',
          padding: '0 8px',
          fontSize: 12.5,
          fontWeight: 600,
          color: 'var(--text)',
          cursor: 'pointer',
          fontFamily: 'var(--font-mono)',
        }}
      >
        {LANGUAGES.map((item) => (
          <option key={item.code} value={item.code}>
            {item.label}
          </option>
        ))}
      </select>
      <span
        className="ac-workspace-editor-file"
        style={{ fontSize: 11, color: 'var(--text3)', fontFamily: 'var(--font-mono)' }}
      >
        main.{langMeta.ext}
      </span>
      {draftSavedAt !== null && (
        <span
          aria-label="Draft saved locally"
          style={{ fontSize: 10.5, color: 'var(--text3)', fontFamily: 'var(--font-mono)' }}
        >
          · saved locally
        </span>
      )}

      <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 6 }}>
        <div style={{ position: 'relative' }} ref={settingsRef}>
          <button
            type="button"
            onClick={onToggleSettings}
            aria-label="Editor settings"
            aria-expanded={settingsOpen}
            title="Editor settings — font size, tab size"
            className="ac-hover-surface2"
            style={iconButton}
          >
            <Icon.Gear />
          </button>
          {settingsOpen && (
            <div
              role="menu"
              aria-label="Editor settings"
              style={{
                position: 'absolute',
                right: 0,
                top: 38,
                width: 210,
                background: 'var(--surface)',
                border: '1px solid var(--border)',
                borderRadius: 12,
                boxShadow: 'var(--shadow-lg)',
                padding: 12,
                zIndex: 30,
                animation: 'acPop .15s ease',
              }}
            >
              <label style={settingsLabel}>Font size — {fontSize}px</label>
              <input
                type="range"
                min={11}
                max={18}
                value={fontSize}
                onChange={onFontSizeChange}
                aria-label="Editor font size"
                style={{ width: '100%', accentColor: 'var(--accent)' }}
              />
              <label style={{ ...settingsLabel, margin: '12px 0 6px' }}>Tab size</label>
              <select
                value={tabSize}
                onChange={onTabSizeChange}
                aria-label="Tab size"
                style={{
                  width: '100%',
                  height: 32,
                  borderRadius: 8,
                  border: '1px solid var(--border)',
                  background: 'var(--surface2)',
                  padding: '0 8px',
                  fontSize: 12.5,
                  color: 'var(--text)',
                }}
              >
                <option value={2}>2 spaces</option>
                <option value={4}>4 spaces</option>
                <option value={8}>8 spaces</option>
              </select>
            </div>
          )}
        </div>

        <button
          type="button"
          onClick={onReset}
          aria-label="Reset code to template"
          title="Reset code"
          className="ac-hover-surface2"
          style={iconButton}
        >
          <Icon.Reset />
        </button>

        {(!stacked || fullscreen) && (
          <button
            type="button"
            onClick={onToggleFullscreen}
            aria-label={fullscreen ? 'Exit full-width editor' : 'Full-width editor'}
            aria-pressed={fullscreen}
            title={fullscreen ? 'Exit full-width editor' : 'Full-width editor'}
            className="ac-hover-surface2"
            style={iconButton}
          >
            {fullscreen ? <Icon.Collapse /> : <Icon.Expand />}
          </button>
        )}
      </div>
    </div>
  );
}
