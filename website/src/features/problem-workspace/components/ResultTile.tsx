interface ResultTileProps {
  value: string;
  label: string;
}

export function ResultTile({ value, label }: ResultTileProps) {
  return (
    <div style={{ border: '1px solid var(--border)', borderRadius: 8, padding: '10px 12px' }}>
      <span
        style={{
          display: 'block',
          fontFamily: 'var(--font-mono)',
          fontSize: 15,
          fontWeight: 650,
          whiteSpace: 'nowrap',
          overflow: 'hidden',
          textOverflow: 'ellipsis',
        }}
      >
        {value}
      </span>
      <span
        style={{
          fontSize: 11,
          color: 'var(--text3)',
          display: 'block',
          whiteSpace: 'nowrap',
          overflow: 'hidden',
          textOverflow: 'ellipsis',
        }}
      >
        {label}
      </span>
    </div>
  );
}
