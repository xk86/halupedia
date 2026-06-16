import { Pane } from "../Pane";
import { ArticleSearchDropdown } from "../../ArticleSearchDropdown";

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
        <ArticleSearchDropdown
          wrapClassName="flex-1"
          inputType="text"
          query={deleteSlug}
          onQueryChange={onDeleteSlugChange}
          onPick={(s) => onDeleteSlugChange(s.slug)}
          placeholder="Search or enter slug to delete…"
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
        <ArticleSearchDropdown
          wrapClassName="flex-1"
          inputType="text"
          query={summarySlug}
          onQueryChange={onSummarySlugChange}
          onPick={(s) => onSummarySlugChange(s.slug)}
          placeholder="Search or paste /wiki/ link…"
        />
        <button
          className="all-entries-more-btn"
          onClick={onRegenerateSummary}
          disabled={regeneratingSummary || !summarySlug.trim()}
        >
          {regeneratingSummary ? "Regenerating..." : "Regenerate summary"}
        </button>
      </div>
      {summaryResult ? (
        <p className="admin-result-headline">{summaryResult}</p>
      ) : null}
    </Pane>
  );
}
