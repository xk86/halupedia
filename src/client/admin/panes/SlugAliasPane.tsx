import { memo, MutableRefObject } from "react";
import { Pane } from "../Pane";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import {
  ArticleSearchDropdown,
  SEARCH_INPUT,
} from "../../ArticleSearchDropdown";

interface AliasResult {
  slug: string;
  title: string;
  aliases: Array<{ aliasSlug: string; articleSlug: string }>;
}

interface ArchivedArticle {
  slug: string;
  title: string;
  archivedAt: number;
  reason: string;
}

interface RedirectConfirmData {
  displacedTitle: string;
  message: string;
}

interface Props {
  aliasSearch: string;
  onAliasSearchChange: (v: string) => void;
  aliasResults: AliasResult[];
  aliasSearching: boolean;
  aliasSearchTimer: MutableRefObject<ReturnType<typeof setTimeout> | null>;
  onDoAliasSearch: (q: string) => void;
  newAliasSlug: string;
  onNewAliasSlugChange: (v: string) => void;
  newAliasTarget: string;
  onNewAliasTargetChange: (v: string) => void;
  onAddAlias: () => void;
  onRemoveAlias: (aliasSlug: string) => void;
  aliasMsg: string | null;
  redirectSource: string;
  onRedirectSourceChange: (v: string) => void;
  redirectTarget: string;
  onRedirectTargetChange: (v: string) => void;
  redirectConfirmData: RedirectConfirmData | null;
  onCreateRedirect: (confirm: boolean) => void;
  onClearRedirectConfirm: () => void;
  redirectBusy: boolean;
  redirectMsg: string | null;
  archived: ArchivedArticle[];
  archivedLoading: boolean;
  onLoadArchived: () => void;
  restoreConfirm: string | null;
  onRestoreArchived: (slug: string, confirm: boolean) => void;
  onClearRestoreConfirm: () => void;
  restoreMsg: string | null;
}

function SlugAliasPaneComponent({
  aliasSearch,
  onAliasSearchChange,
  aliasResults,
  aliasSearching,
  aliasSearchTimer,
  onDoAliasSearch,
  newAliasSlug,
  onNewAliasSlugChange,
  newAliasTarget,
  onNewAliasTargetChange,
  onAddAlias,
  onRemoveAlias,
  aliasMsg,
  redirectSource,
  onRedirectSourceChange,
  redirectTarget,
  onRedirectTargetChange,
  redirectConfirmData,
  onCreateRedirect,
  onClearRedirectConfirm,
  redirectBusy,
  redirectMsg,
  archived,
  archivedLoading,
  onLoadArchived,
  restoreConfirm,
  onRestoreArchived,
  onClearRestoreConfirm,
  restoreMsg,
}: Props) {
  return (
    <Pane
      id="slug-alias"
      title="Slug & Alias Management"
      description="Aliases, canonical redirects, and archived articles."
      wide
    >
      <p className="mb-[1rem] text-[0.875rem] text-ink-fade">
        <strong>Aliases</strong> let multiple slug paths resolve to the same
        article. A <strong>canonical redirect</strong> makes a source slug
        silently rewrite to a target slug (useful for merging two articles — the
        displaced article is archived and restorable).
      </p>

      <h3 className="sb-heading mb-[0.5rem]">Find Aliases by Slug</h3>
      <div className="mb-[0.5rem] flex items-center gap-[0.5rem]">
        <ArticleSearchDropdown
          wrapClassName="flex-1"
          inputType="text"
          query={aliasSearch}
          onQueryChange={(v) => {
            onAliasSearchChange(v);
            if (aliasSearchTimer.current)
              clearTimeout(aliasSearchTimer.current);
            aliasSearchTimer.current = setTimeout(
              () => onDoAliasSearch(v),
              300,
            );
          }}
          onPick={(s) => {
            onAliasSearchChange(s.slug);
            onDoAliasSearch(s.slug);
          }}
          placeholder="Search article (slug or /wiki/ link)…"
        />
        {aliasSearching && <span className="text-[0.8rem]">Searching…</span>}
      </div>
      {aliasResults.map((r) => (
        <div
          key={r.slug}
          className="mb-[0.5rem] rounded-xl p-[0.75rem] [border:1px_solid_var(--rule)]"
        >
          <strong>{r.title}</strong>{" "}
          <code className="text-[0.8rem]">{r.slug}</code>
          {r.aliases.length > 0 && (
            <ul className="mt-[0.4rem] pl-[1.2rem]">
              {r.aliases.map((a) => (
                <li
                  key={a.aliasSlug}
                  className="mb-[0.2rem] flex items-center gap-[0.5rem]"
                >
                  <code className="text-[0.8rem]">{a.aliasSlug}</code>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => onRemoveAlias(a.aliasSlug)}
                  >
                    Remove
                  </Button>
                </li>
              ))}
            </ul>
          )}
          {r.aliases.length === 0 && (
            <p className="mt-[0.3rem] text-[0.8rem] text-ink-fade">
              No aliases.
            </p>
          )}
        </div>
      ))}

      <h3 className="sb-heading mt-[1rem] mb-[0.5rem]">Add Alias</h3>
      <p className="mb-[0.4rem] text-[0.8rem] text-ink-fade">
        Alias slug → canonical slug. Visiting the alias will serve the canonical
        article.
      </p>
      <div className="mb-[0.5rem] flex flex-wrap items-start gap-[0.5rem]">
        <Input
          className={`${SEARCH_INPUT} min-w-[140px] flex-1`}
          placeholder="new alias-slug"
          value={newAliasSlug}
          onChange={(e) => onNewAliasSlugChange(e.target.value)}
        />
        <span className="self-center">→</span>
        <ArticleSearchDropdown
          wrapClassName="min-w-[140px] flex-1"
          inputType="text"
          query={newAliasTarget}
          onQueryChange={onNewAliasTargetChange}
          onPick={(s) => onNewAliasTargetChange(s.slug)}
          placeholder="canonical article…"
        />
        <Button
          variant="outline"
          onClick={onAddAlias}
          disabled={!newAliasSlug.trim() || !newAliasTarget.trim()}
        >
          Add Alias
        </Button>
      </div>
      {aliasMsg && <p className="mt-[0.3rem] text-[0.85rem]">{aliasMsg}</p>}

      <h3 className="sb-heading mt-[1.5rem] mb-[0.5rem]">
        Canonical Slug Redirect
      </h3>
      <p className="mb-[0.4rem] text-[0.8rem] text-ink-fade">
        All traffic to <em>source slug</em> will silently redirect to{" "}
        <em>canonical slug</em>. If an article exists at the source slug it will
        be archived (see below). Use this to merge two pages.
      </p>
      <div className="mb-[0.5rem] flex flex-wrap items-start gap-[0.5rem]">
        <ArticleSearchDropdown
          wrapClassName="min-w-[140px] flex-1"
          inputType="text"
          query={redirectSource}
          onQueryChange={onRedirectSourceChange}
          onPick={(s) => onRedirectSourceChange(s.slug)}
          placeholder="source article (will redirect)…"
        />
        <span className="self-center">→</span>
        <ArticleSearchDropdown
          wrapClassName="min-w-[140px] flex-1"
          inputType="text"
          query={redirectTarget}
          onQueryChange={onRedirectTargetChange}
          onPick={(s) => onRedirectTargetChange(s.slug)}
          placeholder="canonical article (stays)…"
        />
        <Button
          variant="destructive"
          onClick={() => onCreateRedirect(false)}
          disabled={
            redirectBusy || !redirectSource.trim() || !redirectTarget.trim()
          }
        >
          Create Redirect
        </Button>
      </div>
      <AlertDialog
        open={!!redirectConfirmData}
        onOpenChange={(open) => {
          if (!open) onClearRedirectConfirm();
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Confirm redirect</AlertDialogTitle>
            <AlertDialogDescription>
              {redirectConfirmData?.message}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={redirectBusy}>
              Cancel
            </AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              disabled={redirectBusy}
              onClick={() => onCreateRedirect(true)}
            >
              Confirm & Archive
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
      {redirectMsg && (
        <p className="mt-[0.3rem] text-[0.85rem]">{redirectMsg}</p>
      )}

      <h3 className="sb-heading mt-[1.5rem] mb-[0.5rem]">
        Archived Articles
        <Button
          variant="outline"
          className="ml-[0.75rem]"
          onClick={onLoadArchived}
          disabled={archivedLoading}
        >
          {archivedLoading ? "Loading…" : "Load / Refresh"}
        </Button>
      </h3>
      <p className="mb-[0.4rem] text-[0.8rem] text-ink-fade">
        Articles displaced by canonical redirects. Restore to bring them back as
        a live article at their original slug.
      </p>
      {archived.length === 0 && !archivedLoading && (
        <p className="text-[0.85rem] text-ink-fade">
          No archived articles. Click Load to check.
        </p>
      )}
      {archived.map((a) => (
        <div
          key={a.slug}
          className="flex items-center gap-[0.75rem] py-[0.5rem] [border-bottom:1px_solid_var(--rule-soft)]"
        >
          <div className="flex-1">
            <strong>{a.title}</strong>{" "}
            <code className="text-[0.8rem]">{a.slug}</code>
            <div className="text-[0.75rem] text-ink-fade">
              {a.reason} — archived {new Date(a.archivedAt).toLocaleString()}
            </div>
          </div>
          <Button
            variant="outline"
            onClick={() => onRestoreArchived(a.slug, false)}
          >
            Restore
          </Button>
          <AlertDialog
            open={restoreConfirm === a.slug}
            onOpenChange={(open) => {
              if (!open) onClearRestoreConfirm();
            }}
          >
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>Restore archived article?</AlertDialogTitle>
                <AlertDialogDescription>
                  Restore <strong>{a.title}</strong> ({a.slug}) from the
                  archive?
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel>Cancel</AlertDialogCancel>
                <AlertDialogAction
                  variant="destructive"
                  onClick={() => onRestoreArchived(a.slug, true)}
                >
                  Confirm Restore
                </AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
        </div>
      ))}
      {restoreMsg && <p className="mt-[0.5rem] text-[0.85rem]">{restoreMsg}</p>}
    </Pane>
  );
}

export const SlugAliasPane = memo(SlugAliasPaneComponent);
