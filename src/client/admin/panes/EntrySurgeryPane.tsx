import { memo } from "react";
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

function EntrySurgeryPaneComponent({
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
    <Pane
      id="entry-surgery"
      title="Entry Surgery"
      description="Delete articles or rebuild generated summaries."
    >
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
      <div className={`${TOOLBAR} mt-3`}>
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
        <p className="mx-0 mt-0 mb-[0.6rem] italic">{summaryResult}</p>
      ) : null}
    </Pane>
  );
}

export const EntrySurgeryPane = memo(EntrySurgeryPaneComponent);
