import { Pane } from "../Pane";
import { Button } from "@/components/ui/button";
import { TOOLBAR } from "../ui";
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
      <div className={TOOLBAR}>
        <ArticleSearchDropdown
          wrapClassName="flex-1"
          inputType="text"
          query={deleteSlug}
          onQueryChange={onDeleteSlugChange}
          onPick={(s) => onDeleteSlugChange(s.slug)}
          placeholder="Search or enter slug to delete…"
        />
        <Button
          variant="default"
          onClick={onDeleteArticle}
          disabled={deleting || !deleteSlug.trim()}
        >
          {deleting ? "Deleting..." : "Delete article"}
        </Button>
      </div>
      <div className={`${TOOLBAR} admin-action-row`}>
        <ArticleSearchDropdown
          wrapClassName="flex-1"
          inputType="text"
          query={summarySlug}
          onQueryChange={onSummarySlugChange}
          onPick={(s) => onSummarySlugChange(s.slug)}
          placeholder="Search or paste /wiki/ link…"
        />
        <Button
          variant="default"
          onClick={onRegenerateSummary}
          disabled={regeneratingSummary || !summarySlug.trim()}
        >
          {regeneratingSummary ? "Regenerating..." : "Regenerate summary"}
        </Button>
      </div>
      {summaryResult ? (
        <p className="admin-result-headline">{summaryResult}</p>
      ) : null}
    </Pane>
  );
}
