/**
 * The MMC console tree.
 *
 * Shaped exactly like ADUC's left pane, because that shape is how an admin
 * orients themselves in the first second: a console root naming the DC, then
 * Saved Queries, then the domain with its containers nested underneath.
 *
 * The console root, Saved Queries and Deleted Objects are synthetic nodes -
 * everything below the domain is lazily loaded from the directory. Saved
 * Queries is where the style guide maps search results ("a distinct list
 * mode").
 *
 * Deleted Objects sits under the domain, which is where ADUC puts it once
 * Advanced Features is on. It is synthetic for a practical reason: the real
 * container is invisible to an ordinary search, since reading it at all
 * requires the Show Deleted control.
 */
import { useState, type MouseEvent, type ReactNode } from "react";
import { ObjectIcon } from "./ObjectIcon";

export type TreeNode = {
  dn: string;
  name: string;
  objectClass?: string | null;
  children?: TreeNode[];
  loaded?: boolean;
  expanded?: boolean;
};

/*
 * Pseudo-DNs for the synthetic nodes. Never sent to LDAP - they exist only to
 * be compared against the current container.
 *
 * A leading space is enough to guarantee these can never collide with a real
 * distinguished name, because RFC 4514 requires a leading space in an RDN to be
 * escaped. These used to lead with a NUL, which was equally safe and quietly
 * awful: one control byte makes the whole file binary to grep, so searching for
 * anything in here silently returned nothing.
 */
export const SAVED_QUERIES = " saved-queries";

/** The Deleted Objects container; the real DN is resolved by the sidecar. */
export const DELETED_OBJECTS = " deleted-objects";

type ContextHandler = (e: MouseEvent, dn: string, name: string) => void;

export function ConsoleTree({
  serverLabel,
  domainName,
  domainDn,
  nodes,
  selectedDn,
  showDeletedObjects = false,
  onSelect,
  onToggle,
  onContextMenu,
}: {
  serverLabel: string;
  domainName: string;
  domainDn: string;
  nodes: TreeNode[];
  selectedDn: string;
  /** Only when the forest has the Recycle Bin on - see getRecycleBinState. */
  showDeletedObjects?: boolean;
  onSelect: (dn: string) => void;
  onToggle: (dn: string) => void;
  onContextMenu: ContextHandler;
}) {
  const [domainOpen, setDomainOpen] = useState(true);

  return (
    <div className="tree-scroll" role="tree" aria-label="Console tree">
      <ul className="tree-list is-root">
        <li>
          <div className="tree-row is-static">
            <span className="tree-twist is-open" aria-hidden>
              &#9656;
            </span>
            <span className="tree-node">
              <ObjectIcon row={{ objectClass: "container" }} size={14} />
              <span className="tree-label">
                Active Directory Users and Computers [{serverLabel}]
              </span>
            </span>
          </div>

          <ul className="tree-list">
            <li>
              <TreeRow
                icon={<ObjectIcon row={{ objectClass: "container" }} size={14} />}
                label="Saved Queries"
                title="Results of the last Find - ADUC keeps searches here"
                selected={selectedDn === SAVED_QUERIES}
                onSelect={() => onSelect(SAVED_QUERIES)}
                onContextMenu={(e) => onContextMenu(e, SAVED_QUERIES, "Saved Queries")}
              />
            </li>
            <li>
              <TreeRow
                icon={<ObjectIcon row={{ objectClass: "domainDNS" }} size={14} />}
                label={domainName}
                title={domainDn}
                selected={selectedDn === domainDn}
                expanded={domainOpen}
                hasChildren
                onToggle={() => setDomainOpen((v) => !v)}
                onSelect={() => onSelect(domainDn)}
                onContextMenu={(e) => onContextMenu(e, domainDn, domainName)}
              />
              {domainOpen && showDeletedObjects && (
                <ul className="tree-list">
                  <li>
                    <TreeRow
                      icon={<ObjectIcon row={{ objectClass: "container" }} size={14} />}
                      label="Deleted Objects"
                      title="Objects awaiting restore or expiry - the AD Recycle Bin"
                      selected={selectedDn === DELETED_OBJECTS}
                      onSelect={() => onSelect(DELETED_OBJECTS)}
                      onContextMenu={(e) =>
                        onContextMenu(e, DELETED_OBJECTS, "Deleted Objects")
                      }
                    />
                  </li>
                </ul>
              )}
              {domainOpen && (
                <TreeLevel
                  nodes={nodes}
                  selectedDn={selectedDn}
                  onSelect={onSelect}
                  onToggle={onToggle}
                  onContextMenu={onContextMenu}
                />
              )}
            </li>
          </ul>
        </li>
      </ul>
    </div>
  );
}

function TreeLevel({
  nodes,
  selectedDn,
  onSelect,
  onToggle,
  onContextMenu,
}: {
  nodes: TreeNode[];
  selectedDn: string;
  onSelect: (dn: string) => void;
  onToggle: (dn: string) => void;
  onContextMenu: ContextHandler;
}) {
  if (nodes.length === 0) return null;
  return (
    <ul className="tree-list">
      {nodes.map((n) => (
        <li key={n.dn}>
          <TreeRow
            icon={
              <ObjectIcon
                row={{ objectClass: n.objectClass || "organizationalUnit" }}
                size={14}
              />
            }
            label={n.name || n.dn}
            title={n.dn}
            selected={selectedDn === n.dn}
            expanded={n.expanded}
            /* An unexplored node keeps its expander: ADUC shows one until you
               open a container and it turns out to have no sub-containers. */
            hasChildren={!n.loaded || (n.children?.length ?? 0) > 0}
            onToggle={() => onToggle(n.dn)}
            onSelect={() => onSelect(n.dn)}
            onContextMenu={(e) => onContextMenu(e, n.dn, n.name)}
          />
          {n.expanded && n.children && (
            <TreeLevel
              nodes={n.children}
              selectedDn={selectedDn}
              onSelect={onSelect}
              onToggle={onToggle}
              onContextMenu={onContextMenu}
            />
          )}
        </li>
      ))}
    </ul>
  );
}

function TreeRow({
  icon,
  label,
  title,
  selected,
  expanded,
  hasChildren = false,
  onToggle,
  onSelect,
  onContextMenu,
}: {
  icon: ReactNode;
  label: string;
  title?: string;
  selected: boolean;
  expanded?: boolean;
  hasChildren?: boolean;
  onToggle?: () => void;
  onSelect: () => void;
  onContextMenu: (e: MouseEvent) => void;
}) {
  return (
    <div
      className={selected ? "tree-row is-selected" : "tree-row"}
      role="treeitem"
      aria-selected={selected}
      aria-expanded={hasChildren ? Boolean(expanded) : undefined}
      onContextMenu={onContextMenu}
    >
      {hasChildren ? (
        <button
          type="button"
          className={expanded ? "tree-twist is-open" : "tree-twist"}
          aria-label={expanded ? "Collapse" : "Expand"}
          onClick={(e) => {
            e.stopPropagation();
            onToggle?.();
          }}
        >
          &#9656;
        </button>
      ) : (
        <span className="tree-twist" aria-hidden />
      )}
      <button
        type="button"
        className="tree-node"
        title={title}
        onClick={onSelect}
        /* ADUC expands a node when you double-click its label. */
        onDoubleClick={() => onToggle?.()}
      >
        {icon}
        <span className="tree-label">{label}</span>
      </button>
    </div>
  );
}
