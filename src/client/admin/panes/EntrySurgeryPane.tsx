import { Pane } from "../Pane";

interface Props {
  deleteSlug: string;
  onDeleteSlugChange: (v: string) => void;
  onDeleteArticle: () => void;
  deleting: boolean;
  summarySlug: string;
  onSummarySlugChange: (v: string) => void;
  onRegenerateSummary: () => void;
  regeneratingSummary: boolean;
  summaryResult: string | null;
}

export function EntrySurgeryPane({
  deleteSlug,
  onDeleteSlugChange,
  onDeleteArticle,
  deleting,
  summarySlug,
  onSummarySlugChange,
  onRegenerateSummary,
  regeneratingSummary,
  summaryResult,
}: Props) {
  return (
    <Pane id="entry-surgery" title="Entry Surgery">
      <div className="all-entries-toolbar">
        <input
          type="text"
          className="all-entries-search"
          placeholder="Delete article by slug"
          value={deleteSlug}
          onChange={(e) => onDeleteSlugChange(e.target.value)}
        />
        <button
          className="all-entries-more-btn"
          onClick={onDeleteArticle}
          disabled={deleting || !deleteSlug.trim()}
        >
          {deleting ? "Deleting..." : "Delete article"}
        </button>
      </div>
      <div className="all-entries-toolbar admin-action-row">
        <input
          type="text"
          className="all-entries-search"
          placeholder="Slug or /wiki/ link for summary"
          value={summarySlug}
          onChange={(e) => onSummarySlugChange(e.target.value)}
        />
        <button
          className="all-entries-more-btn"
          onClick={onRegenerateSummary}
          disabled={regeneratingSummary || !summarySlug.trim()}
        >
          {regeneratingSummary ? "Regenerating..." : "Regenerate summary"}
        </button>
      </div>
      {summaryResult ? <p className="admin-result-headline">{summaryResult}</p> : null}
    </Pane>
  );
}
