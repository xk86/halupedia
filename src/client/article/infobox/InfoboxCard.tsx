import type { ReactNode } from "react";

import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Table, TableBody, TableCell, TableRow } from "@/components/ui/table";
import { cn } from "@/lib/utils";
import type { InfoboxGroup } from "@/types";

const infoboxCardClasses = "infobox group/sb gap-0 rounded-sm py-0";
const infoboxHeaderClasses =
  "gap-0 rounded-none border-b border-panel-border bg-accent-wash-strong px-0 py-0";
const collapsedContentClasses =
  "max-[680px]:group-data-[collapsed=true]/sb:hidden";

interface InfoboxCardProps {
  title?: string;
  subtitle?: string;
  groups: InfoboxGroup[];
  collapsed?: boolean;
  titleAction?: ReactNode;
  beforeTable?: ReactNode;
  footer?: ReactNode;
}

export function InfoboxCard({
  title,
  subtitle,
  groups,
  collapsed = false,
  titleAction,
  beforeTable,
  footer,
}: InfoboxCardProps) {
  return (
    <Card size="sm" className={infoboxCardClasses} data-collapsed={collapsed}>
      <CardHeader className={infoboxHeaderClasses}>
        {title ? (
          <CardTitle
            className="infobox-title"
            dangerouslySetInnerHTML={{ __html: title }}
          />
        ) : null}
        {titleAction ? <CardAction>{titleAction}</CardAction> : null}
      </CardHeader>

      {subtitle ? (
        <CardDescription
          className={cn("infobox-subtitle", collapsedContentClasses)}
          dangerouslySetInnerHTML={{ __html: subtitle }}
        />
      ) : null}

      {beforeTable ? (
        <CardContent className="px-0">{beforeTable}</CardContent>
      ) : null}

      {groups.length > 0 ? (
        <CardContent className={cn("px-0", collapsedContentClasses)}>
          <Table className="infobox-table">
            {groups.map((group, groupIndex) => (
              <TableBody key={groupIndex}>
                {group.label ? (
                  <TableRow>
                    <th
                      className="infobox-group-header"
                      colSpan={2}
                      dangerouslySetInnerHTML={{ __html: group.label }}
                    />
                  </TableRow>
                ) : null}
                {group.rows.map((row, rowIndex) => (
                  <TableRow key={rowIndex}>
                    <th
                      className="infobox-label"
                      scope="row"
                      dangerouslySetInnerHTML={{ __html: row.label }}
                    />
                    <TableCell
                      className="infobox-value whitespace-normal"
                      dangerouslySetInnerHTML={{ __html: row.value }}
                    />
                  </TableRow>
                ))}
              </TableBody>
            ))}
          </Table>
        </CardContent>
      ) : null}

      {footer ? (
        <CardFooter className="block rounded-none px-0">{footer}</CardFooter>
      ) : null}
    </Card>
  );
}
