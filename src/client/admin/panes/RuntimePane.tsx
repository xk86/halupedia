import { memo } from "react";
import { Pane } from "../Pane";
import { buttonVariants } from "@/components/ui/button";
import { Table, TableBody, TableCell, TableRow } from "@/components/ui/table";

interface Props {
  databasePath: string;
  promptConfigPath: string;
  ragMode: string;
}

function RuntimePaneComponent({
  databasePath,
  promptConfigPath,
  ragMode,
}: Props) {
  return (
    <Pane
      id="runtime"
      title="Runtime"
      description="Database, prompt, and retrieval configuration."
    >
      <Table
        containerClassName="rounded-md border border-border"
        className="table-fixed text-xs [&_td]:px-2 [&_td]:py-1.5"
      >
        <TableBody>
          <RuntimeRow label="Database" value={databasePath} />
          <RuntimeRow label="Prompts" value={promptConfigPath} />
          <RuntimeRow label="RAG mode" value={ragMode} />
        </TableBody>
      </Table>
      <a
        className={buttonVariants({ className: "mt-3", size: "sm" })}
        href="/api/admin/db-backup/latest"
        download
      >
        Download latest DB backup
      </a>
    </Pane>
  );
}

function RuntimeRow({ label, value }: { label: string; value: string }) {
  return (
    <TableRow>
      <TableCell className="w-24 font-medium text-muted-foreground">
        {label}
      </TableCell>
      <TableCell className="truncate font-mono" title={value}>
        {value}
      </TableCell>
    </TableRow>
  );
}

export const RuntimePane = memo(RuntimePaneComponent);
