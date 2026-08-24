import { useState, type ReactNode } from 'react';
import { STATUS_LABEL_KO, type WorkStatus } from '../lib/events';

export function Card({
  title,
  hint,
  action,
  children,
  className = '',
}: {
  title?: string;
  hint?: string;
  action?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section className={`card ${className}`}>
      {(title || action) && (
        <header className="card__head">
          {title && <h2 className="card__title">{title}</h2>}
          {hint && <span className="card__hint">{hint}</span>}
          <span className="header__spacer" />
          {action}
        </header>
      )}
      {children}
    </section>
  );
}

const CHIP_CLASS: Record<WorkStatus, string> = {
  not_started: 'chip--idle',
  working: 'chip--working',
  away: 'chip--away',
  finished: 'chip--finished',
};

export function StatusChip({
  status,
  testId = 'status-chip',
}: {
  status: WorkStatus;
  testId?: string;
}) {
  const live = status === 'working' || status === 'away';
  return (
    <span className={`chip ${CHIP_CLASS[status]}`} data-testid={testId}>
      <span className={`chip__dot ${live ? 'chip__dot--pulse' : ''}`} />
      {STATUS_LABEL_KO[status]}
    </span>
  );
}

export function Tile({
  label,
  value,
  accent = false,
  testId,
}: {
  label: string;
  value: string;
  accent?: boolean;
  testId?: string;
}) {
  return (
    <div className={`tile ${accent ? 'tile--accent' : ''}`}>
      <div className="tile__label">{label}</div>
      <div className="tile__value" data-testid={testId}>
        {value}
      </div>
    </div>
  );
}

export function Banner({
  kind,
  children,
}: {
  kind: 'info' | 'warn' | 'danger' | 'success';
  children: ReactNode;
}) {
  const icon = kind === 'warn' ? '⚠️' : kind === 'danger' ? '⛔' : kind === 'success' ? '✅' : 'ℹ️';
  return (
    <div className={`banner banner--${kind}`} role="status">
      <span aria-hidden="true">{icon}</span>
      <span>{children}</span>
    </div>
  );
}

/**
 * 이 화면이 낡은 코드를 돌리고 있을 때 띄우는 줄.
 *
 * 노션 임베드 위젯은 iframe 이 며칠씩 그대로 살아 있어서, 버그를 고쳐 배포해도
 * 화면은 옛 코드를 계속 돌린다. 사용자 입장에서는 "고쳤다는데 그대로"이고,
 * 밖에서는 어느 코드가 도는지 볼 방법조차 없었다. 그래서 앱이 직접 알린다.
 */
export function UpdateBanner() {
  return (
    <button
      type="button"
      className="banner banner--warn banner--action"
      data-testid="update-banner"
      onClick={() => window.location.reload()}
    >
      <span aria-hidden="true">🔄</span>
      <span>앱이 업데이트되었습니다 — 눌러서 새로고침하세요.</span>
    </button>
  );
}

export function EmptyState({ children }: { children: ReactNode }) {
  return <p className="empty">{children}</p>;
}

/**
 * 눌러서 그 자리에서 고치는 한 줄 텍스트.
 *
 * 할 일 문구는 전체 화면과 위젯 두 군데에 나온다. 고치는 규칙(Enter 저장 ·
 * Esc 취소 · 포커스를 잃으면 저장 · 빈 값은 무시)이 한쪽에만 있으면 같은 목록인데
 * 화면마다 다르게 굴러서, 사용자는 "여기선 되고 저기선 안 된다"를 겪는다.
 * 그래서 규칙은 이 한 곳에만 둔다.
 */
export function EditableText({
  value,
  onCommit,
  maxLength,
  className = '',
  editClassName = '',
  title = '눌러서 수정',
  editLabel,
  testId,
  editTestId,
}: {
  value: string;
  onCommit: (next: string) => void;
  maxLength?: number;
  className?: string;
  editClassName?: string;
  title?: string;
  editLabel?: string;
  testId?: string;
  editTestId?: string;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value);

  function commit() {
    onCommit(draft);
    setEditing(false);
  }

  if (editing) {
    return (
      <input
        className={`input ${editClassName}`}
        autoFocus
        value={draft}
        maxLength={maxLength}
        aria-label={editLabel}
        data-testid={editTestId}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            commit();
          }
          if (e.key === 'Escape') {
            setDraft(value);
            setEditing(false);
          }
        }}
      />
    );
  }

  return (
    <button
      type="button"
      className={className}
      title={title}
      data-testid={testId}
      onClick={() => {
        setDraft(value);
        setEditing(true);
      }}
    >
      {value}
    </button>
  );
}
