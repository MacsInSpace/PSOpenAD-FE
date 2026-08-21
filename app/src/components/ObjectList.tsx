/**
 * ADUC's result pane.
 *
 * Columns come from the caller, which gets them from the registry in
 * lib/columns.ts and from View > Add/Remove Columns. The default is ADUC's own
 * leading three - Name / Type / Description - plus the logon name this app
 * always has to hand. Name renders with an icon and Type with the group scope
 * wording; every other column is whatever the registry says it is.
 *
 * Selection follows the Explorer/ADUC rules exactly, because bulk work is the
 * point of a list this dense:
 *
 *   click                 select just this row, and make it the anchor
 *   Cmd/Ctrl + click      toggle this row, leave the rest alone
 *   Shift + click         select the range from the anchor to here
 *   arrows                move the selection
 *   Shift + arrows        extend the range from the anchor
 *   Cmd/Ctrl + A          select everything listed
 *
 * The anchor is the last plain click, not the last row touched, which is what
 * makes a shift-click after a ctrl-click behave the way people expect.
 */
import { useEffect, useRef, type MouseEvent } from "react";
import { type DirectoryRow } from "../lib/api";
import { COLUMNS, type ColumnKey } from "../lib/columns";
import { ObjectIcon } from "./ObjectIcon";

export type SortKey = ColumnKey;

/** How a click or keypress should change the selection. */
export type SelectMode = "replace" | "toggle" | "range";

export function ObjectList({
  rows,
  columns,
  selectedDns,
  busy,
  emptyMessage,
  sortKey,
  sortAsc,
  onSort,
  onSelect,
  onSelectAll,
  onActivate,
  onContextMenu,
}: {
  rows: DirectoryRow[];
  columns: ColumnKey[];
  selectedDns: Set<string>;
  busy: boolean;
  emptyMessage: string;
  sortKey: SortKey;
  sortAsc: boolean;
  onSort: (key: SortKey) => void;
  onSelect: (row: DirectoryRow, mode: SelectMode) => void;
  onSelectAll: () => void;
  onActivate: (row: DirectoryRow) => void;
  onContextMenu: (e: MouseEvent, row: DirectoryRow) => void;
}) {
  const bodyRef = useRef<HTMLTableSectionElement>(null);

  // Keep the most recently selected row in view when the keyboard walks past
  // the edge. Last, not first, so extending downward follows the cursor.
  useEffect(() => {
    if (selectedDns.size === 0) return;
    const all = bodyRef.current?.querySelectorAll<HTMLTableRowElement>("tr.is-selected");
    all?.[all.length - 1]?.scrollIntoView({ block: "nearest" });
  }, [selectedDns]);

  function modeFor(e: {
    metaKey: boolean;
    ctrlKey: boolean;
    shiftKey: boolean;
  }): SelectMode {
    if (e.shiftKey) return "range";
    if (e.metaKey || e.ctrlKey) return "toggle";
    return "replace";
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLTableSectionElement>) {
    if (rows.length === 0) return;

    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "a") {
      e.preventDefault();
      onSelectAll();
      return;
    }

    // Walk from the last selected row, so Shift+Arrow grows the range.
    let i = -1;
    for (let n = rows.length - 1; n >= 0; n--) {
      if (selectedDns.has(rows[n]!.distinguishedName)) {
        i = n;
        break;
      }
    }

    const go = (next: number) => {
      e.preventDefault();
      const row = rows[Math.max(0, Math.min(rows.length - 1, next))];
      if (row) onSelect(row, e.shiftKey ? "range" : "replace");
    };

    if (e.key === "ArrowDown") go(i + 1);
    else if (e.key === "ArrowUp") go(i <= 0 ? 0 : i - 1);
    else if (e.key === "Home") go(0);
    else if (e.key === "End") go(rows.length - 1);
    else if (e.key === "Enter" && i >= 0 && selectedDns.size === 1) {
      e.preventDefault();
      onActivate(rows[i]!);
    }
  }

  return (
    <div className="list-frame">
      <table className="object-table">
        <thead>
          <tr>
            {columns.map((key) => (
              <th
                key={key}
                aria-sort={
                  sortKey === key ? (sortAsc ? "ascending" : "descending") : "none"
                }
              >
                <button type="button" className="col-head" onClick={() => onSort(key)}>
                  {COLUMNS[key].label}
                  <span className="col-sort" aria-hidden>
                    {sortKey === key ? (sortAsc ? "\u25B4" : "\u25BE") : ""}
                  </span>
                </button>
              </th>
            ))}
          </tr>
        </thead>
        <tbody ref={bodyRef} tabIndex={0} onKeyDown={onKeyDown}>
          {rows.map((r) => {
            const isSelected = selectedDns.has(r.distinguishedName);
            return (
              <tr
                key={r.distinguishedName}
                className={isSelected ? "is-selected" : undefined}
                onClick={(e) => onSelect(r, modeFor(e))}
                onDoubleClick={() => onActivate(r)}
                onContextMenu={(e) => {
                  /* ADUC keeps a multi-selection when you right-click inside
                     it, and selects the row when you right-click outside it. */
                  if (!isSelected) onSelect(r, "replace");
                  onContextMenu(e, r);
                }}
              >
                {columns.map((key) => {
                  const text = COLUMNS[key].value(r);
                  if (key === "name") {
                    return (
                      <td key={key}>
                        <span className="name-cell">
                          <ObjectIcon row={r} />
                          <span className="name-text">{text}</span>
                        </span>
                      </td>
                    );
                  }
                  return (
                    <td
                      key={key}
                      className={COLUMNS[key].mono ? "mono" : "cell-text"}
                      title={text || undefined}
                    >
                      {text}
                    </td>
                  );
                })}
              </tr>
            );
          })}

          {rows.length === 0 && (
            <tr className="no-hover">
              <td colSpan={columns.length} className="empty">
                {busy ? "Loading..." : emptyMessage}
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}
