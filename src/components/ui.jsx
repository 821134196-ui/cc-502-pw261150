import React from 'react';
import { STATE_LABEL } from '../lib.js';

export function StateBadge({ state, label }) {
  if (!state) return null;
  return (
    <span className={`badge ${state}`}>
      <span className="dot" aria-hidden="true" />
      {label || STATE_LABEL[state] || state}
    </span>
  );
}

const SOURCE_LABELS = {
  measured: ['Measured', ''],
  'no-data': ['Missing rows', 'nodata'],
  'upstream-missing': ['Upstream missing', 'breached'],
};

export function SourceBadge({ source }) {
  const [label, cls] = SOURCE_LABELS[source] || [source, ''];
  return <span className={`badge ${cls}`}>{label}</span>;
}

export function Sparkline({ values, width = 108, height = 26, color = 'var(--series-1)', min, max, ariaLabel }) {
  const data = values || [];
  const present = data.filter((v) => v != null);
  if (present.length < 2) return <span className="muted">—</span>;
  const lo = min ?? Math.min(...present);
  const hi = max ?? Math.max(...present);
  const span = hi - lo || 1;
  const step = data.length > 1 ? width / (data.length - 1) : width;
  let d = '';
  let open = false;
  data.forEach((v, i) => {
    if (v == null) {
      open = false;
      return;
    }
    const x = i * step;
    const y = height - 1.5 - ((v - lo) / span) * (height - 3);
    d += `${open ? 'L' : 'M'}${x.toFixed(1)} ${y.toFixed(1)} `;
    open = true;
  });
  const lastIdx = data.reduce((acc, v, i) => (v != null ? i : acc), -1);
  const lastVal = lastIdx >= 0 ? data[lastIdx] : null;
  const lastY = lastVal == null ? null : height - 1.5 - ((lastVal - lo) / span) * (height - 3);
  return (
    <svg
      className="sparkline"
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      role="img"
      aria-label={ariaLabel || 'trend'}
    >
      <path d={d} fill="none" stroke={color} strokeWidth="1.6" strokeLinejoin="round" strokeLinecap="round" opacity="0.6" />
      {lastY != null && lastIdx >= 0 && (
        <circle cx={lastIdx * step} cy={lastY} r="2.6" fill={color} stroke="var(--surface-1)" strokeWidth="1.6" />
      )}
    </svg>
  );
}

export function Meter({ value, target, color }) {
  const width = value == null ? 0 : Math.max(0, Math.min(1, (value / target) * 0.94 + 0.03));
  const tone = color || (value == null ? 'var(--grid)' : value < target ? 'var(--status-critical)' : 'var(--status-good)');
  return (
    <div className="meter" aria-hidden="true">
      <span style={{ width: `${width * 100}%`, background: tone }} />
    </div>
  );
}

export function Legend({ items }) {
  return (
    <div className="legend">
      {items.map((it) => (
        <span className="key" key={it.label}>
          <span
            className={it.line ? 'line-key' : 'swatch'}
            style={{ background: it.color }}
            aria-hidden="true"
          />
          {it.label}
        </span>
      ))}
    </div>
  );
}

export function Empty({ children }) {
  return <div className="empty">{children}</div>;
}
