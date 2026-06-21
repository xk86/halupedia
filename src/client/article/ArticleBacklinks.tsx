import { Separator } from "@/components/ui/separator";

interface Backlink {
  slug: string;
  title: string;
}

interface ArticleBacklinksProps {
  existing: Backlink[];
  unwritten: Backlink[];
  onNavigate: (title: string) => void;
}

const backlinkListClasses = "m-0 flex list-none flex-wrap gap-x-3 gap-y-1 p-0";
const backlinkItemClasses = "text-sm [hyphens:manual] [word-break:break-all]";

export function ArticleBacklinks({
  existing,
  unwritten,
  onNavigate,
}: ArticleBacklinksProps) {
  const count = existing.length + unwritten.length;
  if (count === 0) return null;

  const renderLink = (backlink: Backlink, isUnwritten: boolean) => {
    const titlePath = backlink.title.replace(/\s+/g, "_");
    return (
      <li key={backlink.slug} className={backlinkItemClasses}>
        <a
          href={`/wiki/${titlePath}`}
          onClick={(event) => {
            event.preventDefault();
            onNavigate(titlePath);
          }}
        >
          {backlink.title}
        </a>
        {isUnwritten ? (
          <span className="text-muted-foreground"> (unwritten)</span>
        ) : null}
      </li>
    );
  };

  return (
    <section className="mt-8 max-w-[87dvw]" aria-label="Referenced by">
      <Separator className="mb-3" />
      <h4 className="mb-2 text-xs font-semibold tracking-wide text-muted-foreground uppercase">
        Referenced by <span className="font-normal">({count})</span>
      </h4>
      <ul className={backlinkListClasses}>
        {existing.map((backlink) => renderLink(backlink, false))}
        {unwritten.map((backlink) => renderLink(backlink, true))}
      </ul>
    </section>
  );
}
