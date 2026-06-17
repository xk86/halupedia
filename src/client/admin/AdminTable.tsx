import { type ReactNode, type TableHTMLAttributes } from "react";
import clsx from "clsx";

/**
 * Shared admin data table (formerly .admin-model-table-wrap / .admin-model-table
 * + its th/td rules). The th/td styling is applied via descendant variants so
 * panes only supply <thead>/<tbody>. Columns 1 and 5 render monospace (the
 * id/status columns in the model + pipeline-run tables).
 */
const TABLE =
  "w-full min-w-[620px] border-collapse " +
  "[&_th]:pt-[0.62rem] [&_th]:pr-[0.75rem] [&_th]:pb-[0.62rem] [&_th]:pl-0 [&_th]:text-left [&_th]:align-top [&_th]:[border-bottom:1px_solid_var(--rule)] [&_th]:font-mono [&_th]:text-[0.68rem] [&_th]:tracking-[0.08em] [&_th]:uppercase [&_th]:text-ink-fade " +
  "[&_td]:pt-[0.62rem] [&_td]:pr-[0.75rem] [&_td]:pb-[0.62rem] [&_td]:pl-0 [&_td]:text-left [&_td]:align-top [&_td]:[border-bottom:1px_solid_var(--rule)] [&_td]:text-[0.92rem] [&_td]:text-ink " +
  "[&_td:nth-child(1)]:font-mono [&_td:nth-child(1)]:text-[0.78rem] [&_td:nth-child(5)]:font-mono [&_td:nth-child(5)]:text-[0.78rem]";

interface AdminTableProps extends TableHTMLAttributes<HTMLTableElement> {
  /** The pipeline-runs table lets expandable rows overflow rather than scroll. */
  overflowVisible?: boolean;
  wrapClassName?: string;
  children: ReactNode;
}

export function AdminTable({
  overflowVisible = false,
  wrapClassName,
  className,
  children,
  ...rest
}: AdminTableProps) {
  return (
    <div
      className={clsx(
        "mt-[0.85rem] [border-top:1px_solid_var(--rule)]",
        overflowVisible ? "overflow-x-visible" : "overflow-x-auto",
        wrapClassName,
      )}
    >
      <table className={clsx(TABLE, className)} {...rest}>
        {children}
      </table>
    </div>
  );
}
