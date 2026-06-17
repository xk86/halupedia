import { Pane } from "../Pane";

interface Props {
  databasePath: string;
  promptConfigPath: string;
  ragMode: string;
}

export function RuntimePane({
  databasePath,
  promptConfigPath,
  ragMode,
}: Props) {
  return (
    <Pane id="runtime" title="Runtime">
      <p className="sb-copy">Database: {databasePath}</p>
      <p className="sb-copy">Prompts: {promptConfigPath}</p>
      <p className="sb-copy">RAG mode: {ragMode}</p>
      <a
        className="mt-[0.5rem] inline-flex cursor-pointer items-center gap-[0.3rem] rounded-[3px] bg-ink px-[0.65rem] py-[0.28rem] font-mono text-[0.8rem] text-parchment no-underline [border:1px_solid_var(--ink)] hover:[border-color:var(--accent)] hover:bg-accent hover:text-parchment"
        href="/api/admin/db-backup/latest"
        download
      >
        Download latest DB backup
      </a>
    </Pane>
  );
}
