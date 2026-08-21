/**
 * ADUC's "Select Users, Contacts, Computers, Service Accounts, or Groups"
 * dialog, which is what sits behind every Add... button in the product.
 *
 * ADUC's version asks you to type names and press Check Names, which only
 * works if you already know what the object is called. This searches as you
 * ask and shows you what it found, because the common case here is "add
 * everyone whose name starts with", not "I know the exact CN".
 *
 * Multi-select, because adding one member at a time to a group is the single
 * most tedious thing in ADUC.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { objectKind, searchDirectory, type DirectoryRow } from "../lib/api";
import { kindLabel } from "../lib/adTerms";
import { ObjectIcon } from "./ObjectIcon";

export type PickKind = "user" | "group" | "computer" | "object";

export function ObjectPicker({
  domainKey,
  searchBase,
  allow,
  title,
  /** DNs already present, shown greyed so you cannot add a duplicate. */
  exclude = [],
  busy = false,
  error = null,
  onCancel,
  onPick,
}: {
  domainKey: string;
  searchBase: string;
  allow: PickKind[];
  title: string;
  exclude?: string[];
  busy?: boolean;
  error?: string | null;
  onCancel: () => void;
  onPick: (dns: string[]) => void;
}) {
  const [kind, setKind] = useState<PickKind>(allow[0] ?? "object");
  const [query, setQuery] = useState("");
  const [rows, setRows] = useState<DirectoryRow[] | null>(null);
  const [chosen, setChosen] = useState<Record<string, DirectoryRow>>({});
  const [searching, setSearching] = useState(false);
  const [searchError, setSearchError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const excluded = new Set(exclude.map((d) => d.toLowerCase()));

  useEffect(() => {
    inputRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onCancel();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onCancel]);

  const run = useCallback(async () => {
    setSearching(true);
    setSearchError(null);
    try {
      const found = await searchDirectory({
        domainKey,
        kind,
        query: query.trim(),
        searchBase,
        limit: 200,
      });
      /* This picks security principals. A container or OU can never be a group
         member, so offering one only earns a server-side rejection. */
      setRows(
        found.filter((r) => {
          const k = objectKind(r);
          return k !== "ou" && k !== "container";
        }),
      );
    } catch (err) {
      setSearchError(err instanceof Error ? err.message : String(err));
      setRows([]);
    } finally {
      setSearching(false);
    }
  }, [domainKey, kind, query, searchBase]);

  function toggle(row: DirectoryRow) {
    setChosen((prev) => {
      const next = { ...prev };
      if (next[row.distinguishedName]) delete next[row.distinguishedName];
      else next[row.distinguishedName] = row;
      return next;
    });
  }

  const picked = Object.values(chosen);

  return (
    <div className="modal-scrim" onMouseDown={busy ? undefined : onCancel}>
      <div
        className="dialog picker-dialog"
        role="dialog"
        aria-modal="true"
        aria-label={title}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="dialog-title">
          <span>{title}</span>
          <button
            type="button"
            className="dialog-close"
            onClick={onCancel}
            disabled={busy}
            aria-label="Close"
          >
            &#10005;
          </button>
        </div>

        <form
          className="picker-search"
          onSubmit={(e) => {
            e.preventDefault();
            void run();
          }}
        >
          {allow.length > 1 && (
            <select
              value={kind}
              aria-label="Object type"
              onChange={(e) => setKind(e.target.value as PickKind)}
            >
              {allow.map((k) => (
                <option key={k} value={k}>
                  {k === "object" ? "All types" : `${kindLabel(k)}s`}
                </option>
              ))}
            </select>
          )}
          <input
            ref={inputRef}
            type="search"
            placeholder="Name, logon name or description"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          <button type="submit" className="btn btn-primary" disabled={searching}>
            {searching ? "Finding..." : "Find Now"}
          </button>
        </form>

        <div className="dialog-body picker-body">
          <div className="list-frame">
            <table className="sheet-table">
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Type</th>
                  <th>In folder</th>
                </tr>
              </thead>
              <tbody>
                {(rows ?? []).map((r) => {
                  const already = excluded.has(r.distinguishedName.toLowerCase());
                  const on = Boolean(chosen[r.distinguishedName]);
                  return (
                    <tr
                      key={r.distinguishedName}
                      className={on ? "is-selected" : already ? "is-dimmed" : undefined}
                      onClick={() => !already && toggle(r)}
                      title={already ? "Already a member" : r.distinguishedName}
                    >
                      <td>
                        <span className="name-cell">
                          <input
                            type="checkbox"
                            checked={on}
                            disabled={already}
                            readOnly
                            tabIndex={-1}
                          />
                          <ObjectIcon row={r} />
                          <span className="name-text">{r.displayName || r.name}</span>
                        </span>
                      </td>
                      <td className="type-cell">{kindLabel(objectKind(r))}</td>
                      <td className="mono">{folderOf(r.distinguishedName)}</td>
                    </tr>
                  );
                })}

                {rows !== null && rows.length === 0 && (
                  <tr className="no-hover">
                    <td colSpan={3} className="empty">
                      Nothing matched. Try a shorter name, or a different type.
                    </td>
                  </tr>
                )}
                {rows === null && !searching && (
                  <tr className="no-hover">
                    <td colSpan={3} className="empty">
                      Type a name and choose Find Now. Leave it blank to list
                      everything of that type.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>

          {searchError && <pre className="error-block">{searchError}</pre>}
          {error && <pre className="error-block">{error}</pre>}
        </div>

        <div className="picker-chosen">
          {picked.length === 0 ? (
            <span className="muted">Nothing selected</span>
          ) : (
            picked.map((r) => (
              <button
                key={r.distinguishedName}
                type="button"
                className="chip"
                title="Remove from selection"
                onClick={() => toggle(r)}
              >
                {r.displayName || r.name}
                <span aria-hidden>&#10005;</span>
              </button>
            ))
          )}
        </div>

        <div className="dialog-footer">
          <button
            type="button"
            className="btn btn-primary"
            disabled={busy || picked.length === 0}
            onClick={() => onPick(picked.map((r) => r.distinguishedName))}
          >
            {busy ? "Working..." : `OK${picked.length ? ` (${picked.length})` : ""}`}
          </button>
          <button type="button" className="btn" onClick={onCancel} disabled={busy}>
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}

/** ADUC's "In folder" column: domain/OU/OU, not a raw DN. */
function folderOf(dn: string) {
  const parts = dn.split(",").slice(1);
  const dcs = parts.filter((p) => /^DC=/i.test(p.trim())).map((p) => p.trim().slice(3));
  const path = parts
    .filter((p) => !/^DC=/i.test(p.trim()))
    .map((p) => p.trim().replace(/^[^=]+=/, ""))
    .reverse();
  return [dcs.join("."), ...path].filter(Boolean).join("/");
}
