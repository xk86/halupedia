import { Pane } from "../Pane";

interface Props {
  databasePath: string;
  promptConfigPath: string;
  ragMode: string;
}

export function RuntimePane({ databasePath, promptConfigPath, ragMode }: Props) {
  return (
    <Pane id="runtime" title="Runtime">
      <p className="sb-copy">Database: {databasePath}</p>
      <p className="sb-copy">Prompts: {promptConfigPath}</p>
      <p className="sb-copy">RAG mode: {ragMode}</p>
      <a
        className="all-entries-more-btn"
        href="/api/admin/db-backup/latest"
        download
        style={{ display: "inline-block", marginTop: "0.5rem" }}
      >
        Download latest DB backup
      </a>
    </Pane>
  );
}
