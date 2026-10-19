import { useRef, type ReactNode } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import {
  getCoreRowModel,
  getExpandedRowModel,
  getSortedRowModel,
  useLegacyTable,
  type LegacyColumnDef,
} from "@tanstack/react-table/legacy";
import { flexRender, type ExpandedState, type RowData, type SortingState, type Updater } from "@tanstack/react-table";
import clsx from "clsx";

/**
 * A virtualized, sortable, tree-capable grid.
 *
 * `@tanstack/react-table` v9 re-implements the library on a state-atom store whose
 * shape is not the one every example and doc describes; its own `legacy` entrypoint is
 * the v8 row-model API kept for exactly this case, so that is what is imported here.
 * Virtualization comes from React Virtual, and the row model is already flat when it
 * reaches the windowing layer, which is why a 200-row tree scrolls like a 20-row one.
 */

export type Column<T extends RowData> = LegacyColumnDef<T, any>;

export interface DataTableProps<T extends RowData> {
  rows: T[];
  columns: Column<T>[];
  getRowId: (row: T) => string;
  getSubRows?: (row: T) => T[] | undefined;
  sorting?: SortingState;
  onSortingChange?: (updater: Updater<SortingState>) => void;
  expanded?: ExpandedState;
  onExpandedChange?: (updater: Updater<ExpandedState>) => void;
  onRowClick?: (row: T) => void;
  onRowHover?: (row: T | null) => void;
  activeId?: string | null;
  rowHeight?: number;
  empty?: ReactNode;
  className?: string;
}

export function DataTable<T extends RowData>({
  rows,
  columns,
  getRowId,
  getSubRows,
  sorting,
  onSortingChange,
  expanded,
  onExpandedChange,
  onRowClick,
  onRowHover,
  activeId,
  rowHeight = 23,
  empty,
  className,
}: DataTableProps<T>) {
  const table = useLegacyTable<T>({
    data: rows,
    columns,
    state: { sorting, expanded },
    onSortingChange,
    onExpandedChange,
    getRowId,
    getSubRows,
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
    getExpandedRowModel: getExpandedRowModel(),
    getRowCanExpand: (row) => !!getSubRows?.(row.original)?.length,
  });

  const model = table.getRowModel().rows;
  const scrollRef = useRef<HTMLDivElement>(null);
  const virt = useVirtualizer({
    count: model.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => rowHeight,
    overscan: 14,
  });

  const header = table.getHeaderGroups()[0];
  const template = header.headers.map((h) => h.column.columnDef.size ?? 120).map((w) => `${w}px`).join(" ");
  // The tracks are fixed pixel widths, so on a narrow panel the grid is wider than its
  // container. Giving the sticky header and the rows the same explicit min-width keeps
  // them in one scroller: the panel scrolls sideways, the document does not.
  const trackWidth = header.headers.reduce((sum, h) => sum + (h.column.columnDef.size ?? 120), 0);

  return (
    <div className={clsx("flex min-h-0 min-w-0 flex-1 flex-col", className)}>
      <div ref={scrollRef} className="no-scrollbar min-h-0 flex-1 overflow-auto">
        <div style={{ minWidth: trackWidth }}>
          <div className="grid-head grid shrink-0" style={{ gridTemplateColumns: template }} role="row">
            {header.headers.map((h) => {
              const sorted = h.column.getIsSorted();
              const align = (h.column.columnDef.meta as { align?: string } | undefined)?.align;
              return (
                <div
                  key={h.id}
                  className={clsx("grid-cell flex items-center gap-1 py-[3px]", align === "right" && "justify-end")}
                  style={{ width: h.column.columnDef.size }}
                >
                  {h.column.getCanSort() ? (
                    <button
                      type="button"
                      onClick={h.column.getToggleSortingHandler()}
                      className="micro flex w-full items-center gap-1 text-left hover:text-ink"
                      style={{ justifyContent: align === "right" ? "flex-end" : undefined }}
                      title="sort"
                    >
                      {flexRender(h.column.columnDef.header, h.getContext())}
                      <span className="text-[8px] text-flow">{sorted === "asc" ? "▲" : sorted === "desc" ? "▼" : ""}</span>
                    </button>
                  ) : (
                    <span className="micro truncate">{flexRender(h.column.columnDef.header, h.getContext())}</span>
                  )}
                </div>
              );
            })}
          </div>

          {model.length === 0 ? (
            <div className="tape p-2 text-ink-faint">{empty ?? "nothing matches this slice"}</div>
          ) : (
            <div style={{ height: virt.getTotalSize(), position: "relative" }}>
              {virt.getVirtualItems().map((item) => {
                const row = model[item.index];
                const id = row.id;
                return (
                  <div
                    key={id}
                    role="row"
                    className={clsx(
                      "grid-row absolute left-0 top-0 grid w-full",
                      onRowClick && "cursor-pointer",
                      activeId === id && "grid-row-on"
                    )}
                    style={{ gridTemplateColumns: template, height: rowHeight, transform: `translateY(${item.start}px)` }}
                    onClick={onRowClick ? () => onRowClick(row.original) : undefined}
                    onMouseEnter={onRowHover ? () => onRowHover(row.original) : undefined}
                    onMouseLeave={onRowHover ? () => onRowHover(null) : undefined}
                  >
                    {row.getVisibleCells().map((cell) => {
                      const align = (cell.column.columnDef.meta as { align?: string } | undefined)?.align;
                      return (
                        <div key={cell.id} className={clsx("grid-cell flex items-center", align === "right" && "justify-end")}>
                          {flexRender(cell.column.columnDef.cell, cell.getContext())}
                        </div>
                      );
                    })}
                    {row.depth > 0 && <span className="pointer-events-none absolute left-0 top-0 h-full" style={{ width: 1 }} />}
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

/** The caret an expandable row shows; a leaf row keeps the indent. */
export function Caret({ open, hasChildren, onToggle }: { open?: boolean; hasChildren?: boolean; onToggle?: () => void }) {
  if (!hasChildren) return <span className="inline-block w-[12px] shrink-0" />;
  return (
    <button
      type="button"
      onClick={(e) => {
        e.stopPropagation();
        onToggle?.();
      }}
      className="inline-block w-[12px] shrink-0 text-[9px] text-ink-faint hover:text-ink"
      title={open ? "collapse sub-agents" : "expand sub-agents"}
    >
      {open ? "▾" : "▸"}
    </button>
  );
}
