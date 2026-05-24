import { ReactNode, useCallback, useState } from "react";

interface Props {
  id: string;
  title: string;
  count?: string;
  actions?: ReactNode;
  defaultCollapsed?: boolean;
  wide?: boolean;
  children: ReactNode;
}

function readCollapsed(id: string, defaultCollapsed: boolean): boolean {
  try {
    const stored = localStorage.getItem(`admin:pane:${id}`);
    if (stored !== null) return stored === "true";
  } catch {}
  return defaultCollapsed;
}

export function Pane({ id, title, count, actions, defaultCollapsed = false, wide = false, children }: Props) {
  const [collapsed, setCollapsed] = useState(() => readCollapsed(id, defaultCollapsed));

  const toggle = useCallback(() => {
    setCollapsed((prev) => {
      const next = !prev;
      try { localStorage.setItem(`admin:pane:${id}`, String(next)); } catch {}
      return next;
    });
  }, [id]);

  return (
    <div className="admin-pane" data-collapsed={collapsed} data-span={wide ? "wide" : undefined}>
      <div className="admin-pane-header" onClick={toggle} role="button" aria-expanded={!collapsed} aria-controls={`pane-body-${id}`}>
        <div className="admin-pane-header-left">
          <span className="admin-pane-caret" aria-hidden>▾</span>
          <h3 className="sb-heading admin-pane-title">{title}</h3>
          {count !== undefined && <span className="all-entries-count">{count}</span>}
        </div>
        {actions && (
          <div className="admin-pane-actions" onClick={(e) => e.stopPropagation()}>
            {actions}
          </div>
        )}
      </div>
      <div id={`pane-body-${id}`} className="admin-pane-body">
        {children}
      </div>
    </div>
  );
}
