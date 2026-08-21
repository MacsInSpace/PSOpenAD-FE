/**
 * ADUC's "Move" browser: pick a container from the tree instead of typing a
 * distinguished name.
 *
 * Typing a DN is how the Move verb shipped first, and it is the worst kind of
 * input - long, exact, unforgiving, and wrong in ways that only show up as a
 * server error. Everything needed to browse for it already existed.
 *
 * Its own tree state rather than the console's: expanding a node here should
 * not disturb what the console is showing behind the dialog.
 */
import { useCallback, useEffect, useState } from "react";
import { getChildren, type DirectoryRow } from "../lib/api";
import { ObjectIcon } from "./ObjectIcon";

type Node = {
  dn: string;
  name: string;
  objectClass?: string | null;
  children?: Node[];
  loaded?: boolean;
  expanded?: boolean;
};

export function ContainerPicker({
  domainKey,
  rootDn,
  rootLabel,
  title,
  /** Containers that cannot be chosen - an object cannot move into itself. */
  disallow = [],
  busy = false,
  error = null,
  confirmLabel = "OK",
  onCancel,
  onPick,
}: {
  domainKey: string;
  rootDn: string;
  rootLabel: string;
  title: string;
  disallow?: string[];
  busy?: boolean;
  error?: string | null;
  confirmLabel?: string;
  onCancel: () => void;
  onPick: (dn: string) => void;
}) {
  const [nodes, setNodes] = useState<Node[]>([]);
  const [selected, setSelected] = useState<string>(rootDn);
  const [loadError, setLoadError] = useState<string | null>(null);

  const blocked = new Set(disallow.map((d) => d.toLowerCase()));

  const toNodes = (rows: DirectoryRow[]): Node[] =>
    rows
      .filter((r) => r.distinguishedName)
      .map((r) => ({
        dn: r.distinguishedName,
        name: r.name || r.distinguishedName,
        objectClass: r.objectClass,
        loaded: false,
        expanded: false,
      }));

  useEffect(() => {
    void (async () => {
      try {
        setNodes(toNodes(await getChildren(domainKey, rootDn)));
      } catch (err) {
        setLoadError(err instanceof Error ? err.message : String(err));
      }
    })();
  }, [domainKey, rootDn]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onCancel();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onCancel]);

  const toggle = useCallback(
    async (dn: string) => {
      let needsLoad = false;
      const walk = (list: Node[]): Node[] =>
        list.map((n) => {
          if (n.dn === dn) {
            needsLoad = !n.expanded && !n.loaded;
            return { ...n, expanded: !n.expanded };
          }
          return n.children ? { ...n, children: walk(n.children) } : n;
        });
      setNodes((prev) => walk(prev));
      if (!needsLoad) return;

      try {
        const kids = toNodes(await getChildren(domainKey, dn));
        const attach = (list: Node[]): Node[] =>
          list.map((n) =>
            n.dn === dn
              ? { ...n, loaded: true, children: kids }
              : n.children
                ? { ...n, children: attach(n.children) }
                : n,
          );
        setNodes((prev) => attach(prev));
      } catch (err) {
        setLoadError(err instanceof Error ? err.message : String(err));
      }
    },
    [domainKey],
  );

  const selectable = selected && !blocked.has(selected.toLowerCase());

  const render = (list: Node[], depth: number) =>
    list.map((n) => {
      const isBlocked = blocked.has(n.dn.toLowerCase());
      return (
        <li key={n.dn}>
          <div
            className={`tree-row${selected === n.dn ? " is-selected" : ""}${isBlocked ? " is-dimmed" : ""}`}
          >
            <button
              type="button"
              className={n.expanded ? "tree-twist is-open" : "tree-twist"}
              aria-label={n.expanded ? "Collapse" : "Expand"}
              onClick={(e) => {
                e.stopPropagation();
                void toggle(n.dn);
              }}
            >
              &#9656;
            </button>
            <button
              type="button"
              className="tree-node"
              title={isBlocked ? "Cannot move an object into itself" : n.dn}
              disabled={isBlocked}
              onClick={() => !isBlocked && setSelected(n.dn)}
              onDoubleClick={() => void toggle(n.dn)}
            >
              <ObjectIcon
                row={{ objectClass: n.objectClass || "organizationalUnit" }}
                size={14}
              />
              <span className="tree-label">{n.name}</span>
            </button>
          </div>
          {n.expanded && n.children && n.children.length > 0 && (
            <ul className="tree-list">{render(n.children, depth + 1)}</ul>
          )}
        </li>
      );
    });

  return (
    <div className="modal-scrim" onMouseDown={busy ? undefined : onCancel}>
      <div
        className="dialog picker-dialog container-picker"
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

        <div className="dialog-body picker-body">
          <div className="list-frame container-tree">
            <ul className="tree-list is-root">
              <li>
                <div className={`tree-row${selected === rootDn ? " is-selected" : ""}`}>
                  <span className="tree-twist is-open" aria-hidden>
                    &#9656;
                  </span>
                  <button
                    type="button"
                    className="tree-node"
                    title={rootDn}
                    onClick={() => setSelected(rootDn)}
                  >
                    <ObjectIcon row={{ objectClass: "domainDNS" }} size={14} />
                    <span className="tree-label">{rootLabel}</span>
                  </button>
                </div>
                <ul className="tree-list">{render(nodes, 1)}</ul>
              </li>
            </ul>
          </div>

          <div className="field-row">
            <label className="field-label">Selected</label>
            <input className="field-input mono" value={selected} readOnly />
          </div>

          {loadError && <pre className="error-block">{loadError}</pre>}
          {error && <pre className="error-block">{error}</pre>}
        </div>

        <div className="dialog-footer">
          <button
            type="button"
            className="btn btn-primary"
            disabled={busy || !selectable}
            onClick={() => onPick(selected)}
          >
            {busy ? "Working..." : confirmLabel}
          </button>
          <button type="button" className="btn" onClick={onCancel} disabled={busy}>
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}
