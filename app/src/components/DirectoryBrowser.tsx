/**
 * The console: menu bar, toolbar, console tree, result pane, status bar.
 *
 * This is the ADUC contract from docs/PSOPENAD_FE_StyleGuide.md section 1 made
 * literal. Someone who knows ADUC should not have to learn anything here:
 * the tree is on the left, objects are in a list, right-click acts on them,
 * and double-click opens Properties.
 *
 * The Action menu and the right-click menu are built from the same functions
 * (`objectVerbs` / `containerVerbs`), so a verb cannot appear in one and not
 * the other. Verbs the sidecar cannot yet perform render disabled but present,
 * with a tooltip saying why - the menu still documents what an object supports.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  addGroupMember,
  copyObject,
  getOperationsMasters,
  resetComputerAccount,
  getChildren,
  listContents,
  moveObject,
  objectKind,
  removeObject,
  renameObject,
  searchDirectory,
  setAccountEnabled,
  type ContentFilter,
  type DirectoryRow,
  type DomainSession,
  getRecycleBinState,
  listDeletedObjects,
  restoreObject,
  type RecycleBinState,
  setAttributes,
} from "../lib/api";
import { VERB, groupLabel, kindLabel } from "../lib/adTerms";
import {
  COLUMNS,
  DEFAULT_COLUMNS,
  DELETED_COLUMNS,
  loadColumns,
  saveColumns,
  type ColumnKey,
} from "../lib/columns";
import { ColumnsDialog } from "./ColumnsDialog";
import {
  BulkPropertiesDialog,
  type BulkPropertyChanges,
} from "./BulkPropertiesDialog";
import {
  ConsoleTree,
  DELETED_OBJECTS,
  SAVED_QUERIES,
  type TreeNode,
} from "./ConsoleTree";
import { ContainerPicker } from "./ContainerPicker";
import { ContextMenu, SEP, menuLabel, useContextMenu, type MenuItem } from "./ContextMenu";
import { ErrorBoundary } from "./ErrorBoundary";
import { MenuBar, type Menu } from "./MenuBar";
import { BulkDialog } from "./BulkDialog";
import { ObjectList, type SelectMode, type SortKey } from "./ObjectList";
import { AskDialog } from "./AskDialog";
import { ObjectPicker } from "./ObjectPicker";
import { LogDialog } from "./LogDialog";
import { NewObjectDialog, type NewKind } from "./NewObjectDialog";
import { PropertiesDialog } from "./PropertiesDialog";
import { ToolbarIcon, type ToolbarGlyph } from "./ToolbarIcon";

type Props = { session: DomainSession };

/** One operation applied across a multi-selection. */
type BulkJob = {
  title: string;
  verb: string;
  targets: DirectoryRow[];
  danger?: boolean;
  confirmMessage?: React.ReactNode;
  run: (row: DirectoryRow) => Promise<unknown>;
};

/** Whatever single-decision dialog the active verb needs. */
type AskState = {
  kind: "confirm" | "prompt";
  title: string;
  message: React.ReactNode;
  label?: string;
  initialValue?: string;
  confirmLabel?: string;
  danger?: boolean;
  onConfirm: (value: string) => void;
};

const FILTERS: Array<[ContentFilter, string]> = [
  ["all", "All objects"],
  ["user", "Users"],
  ["group", "Groups"],
  ["computer", "Computers"],
  ["ou", "Organizational Units"],
];

export function DirectoryBrowser({ session }: Props) {
  const rootDn = session.defaultNamingContext;
  const menu = useContextMenu();

  const [tree, setTree] = useState<TreeNode[]>([]);
  /* Back/Forward need the stack and the cursor to move together, so they are
     one piece of state - updating them separately races. */
  const [nav, setNav] = useState<{ stack: string[]; at: number }>({
    stack: [rootDn],
    at: 0,
  });
  const container = nav.stack[nav.at]!;

  const [filter, setFilter] = useState<ContentFilter>("all");
  const [rows, setRows] = useState<DirectoryRow[]>([]);
  const [searchRows, setSearchRows] = useState<DirectoryRow[] | null>(null);
  const [searchTerm, setSearchTerm] = useState("");
  /* Multi-selection, Explorer rules. `anchor` is the last plain click, which
     is what a Shift+click ranges from. */
  const [sel, setSel] = useState<{ dns: string[]; anchor: string | null }>({
    dns: [],
    anchor: null,
  });
  const clearSelection = useCallback(() => setSel({ dns: [], anchor: null }), []);

  /* Columns are remembered per list, because the two lists answer different
     questions - see DELETED_COLUMNS. */
  const [containerCols, setContainerCols] = useState<ColumnKey[]>(() =>
    loadColumns("container", DEFAULT_COLUMNS),
  );
  const [deletedCols, setDeletedCols] = useState<ColumnKey[]>(() =>
    loadColumns("deleted", DELETED_COLUMNS),
  );
  const [columnsOpen, setColumnsOpen] = useState(false);

  const [sortKey, setSortKey] = useState<SortKey>("name");
  const [sortAsc, setSortAsc] = useState(true);

  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [findOpen, setFindOpen] = useState(false);
  /* ADUC's View > Filter Options: a raw LDAP filter beats a fixed class list. */
  const [ldapFilter, setLdapFilter] = useState("");
  const [filterOpen, setFilterOpen] = useState(false);
  const [logOpen, setLogOpen] = useState(false);
  /* MMC panes are draggable, and the console tree needs it: a deep OU path
     runs out of room fast at a fixed width. */
  const [treeW, setTreeW] = useState(268);

  /* One slot for whichever single-decision dialog a verb needs. */
  const [ask, setAsk] = useState<AskState | null>(null);
  const [newIn, setNewIn] = useState<{ path: string; type: NewKind } | null>(null);
  const [addToGroupFor, setAddToGroupFor] = useState<DirectoryRow | null>(null);
  const [bulk, setBulk] = useState<BulkJob | null>(null);
  const [bulkPickGroups, setBulkPickGroups] = useState<DirectoryRow[] | null>(null);
  /* Move now browses for its destination instead of demanding a typed DN. */
  const [moveTargets, setMoveTargets] = useState<DirectoryRow[] | null>(null);
  /* Its own slot rather than reusing Move's: the destination means something
     different here, and the confirm wording and validation differ with it. */
  const [restoreTo, setRestoreTo] = useState<DirectoryRow | null>(null);
  const [copyFrom, setCopyFrom] = useState<DirectoryRow | null>(null);
  /* ADUC's multi-select property sheet: collect the changes, then hand them
     to the same runner every other bulk verb uses. */
  const [bulkProps, setBulkProps] = useState<DirectoryRow[] | null>(null);
  const [fsmo, setFsmo] = useState<
    Array<{ role: string; holder: string | null }> | null
  >(null);
  const [working, setWorking] = useState(false);
  const [askError, setAskError] = useState<string | null>(null);
  const [propsFor, setPropsFor] = useState<{
    row: DirectoryRow;
    tab: "general" | "account";
  } | null>(null);

  /* The Recycle Bin is a forest feature that may simply be off, so the node is
     not offered until the directory says it is on. null = not asked yet. */
  const [recycleBin, setRecycleBin] = useState<RecycleBinState | null>(null);
  const [deletedRows, setDeletedRows] = useState<DirectoryRow[]>([]);
  /* Non-null when the directory had more to give than the cap allowed. */
  const [truncated, setTruncated] = useState<number | null>(null);

  const showingSearch = container === SAVED_QUERIES;
  const showingDeleted = container === DELETED_OBJECTS;
  /* Neither pseudo-node is a place in the directory, so verbs that act on a
     container are meaningless while one is open. */
  const showingPseudo = showingSearch || showingDeleted;
  const listRows = showingSearch
    ? (searchRows ?? [])
    : showingDeleted
      ? deletedRows
      : rows;

  const activeCols = showingDeleted ? deletedCols : containerCols;

  const applyColumns = useCallback(
    (cols: ColumnKey[]) => {
      const view = showingDeleted ? "deleted" : "container";
      if (showingDeleted) setDeletedCols(cols);
      else setContainerCols(cols);
      saveColumns(view, cols);
      setColumnsOpen(false);
      // A sort on a column that is no longer shown has no visible handle to
      // undo it, so fall back to Name rather than leaving it stuck.
      setSortKey((k) => (cols.includes(k) ? k : "name"));
    },
    [showingDeleted],
  );

  /* -- navigation -------------------------------------------------------- */

  const navigate = useCallback((dn: string) => {
    setNav(({ stack, at }) => {
      if (stack[at] === dn) return { stack, at };
      // A new destination truncates anything Forward would have gone to.
      const trimmed = stack.slice(0, at + 1);
      return { stack: [...trimmed, dn], at: trimmed.length };
    });
  }, []);

  const goBack = useCallback(
    () => setNav((n) => (n.at > 0 ? { ...n, at: n.at - 1 } : n)),
    [],
  );

  const goForward = useCallback(
    () => setNav((n) => (n.at < n.stack.length - 1 ? { ...n, at: n.at + 1 } : n)),
    [],
  );

  // Selection belongs to a container, never survives leaving it.
  useEffect(() => {
    clearSelection();
    setTruncated(null);
  }, [container, clearSelection]);

  const parentDn = useMemo(() => {
    if (showingPseudo || container === rootDn) return null;
    const parent = container.split(",").slice(1).join(",");
    return parent.length >= rootDn.length ? parent : rootDn;
  }, [container, rootDn, showingPseudo]);

  /* -- loading ----------------------------------------------------------- */

  const loadRoot = useCallback(async () => {
    try {
      const kids = await getChildren(session.domainKey, rootDn);
      setTree(toNodes(kids));
    } catch (err) {
      setError(msg(err));
    }
  }, [session.domainKey, rootDn]);

  const loadContents = useCallback(
    async (base: string, f: ContentFilter) => {
      if (base === SAVED_QUERIES || base === DELETED_OBJECTS) return;
      setBusy(true);
      setError(null);
      try {
        const result = await listContents({
          domainKey: session.domainKey,
          searchBase: base,
          filter: f,
          limit: 500,
          ...(ldapFilter.trim() ? { ldapFilter: ldapFilter.trim() } : {}),
        });
        setRows(result.rows);
        setTruncated(result.truncated ? result.limit ?? result.rows.length : null);
        clearSelection();
      } catch (err) {
        setError(msg(err));
        setRows([]);
      } finally {
        setBusy(false);
      }
    },
    [session.domainKey, clearSelection, ldapFilter],
  );

  useEffect(() => {
    void loadRoot();
  }, [loadRoot]);

  useEffect(() => {
    void loadContents(container, filter);
  }, [container, filter, loadContents]);

  /* React runs a state updater during render, not inside the event handler, so
     the decision to fetch has to be made from the current tree up front - a
     flag set inside the updater is still false when the handler reads it. */
  const treeRef = useRef<TreeNode[]>([]);
  useEffect(() => {
    treeRef.current = tree;
  }, [tree]);

  const toggleNode = useCallback(
    async (dn: string) => {
      const node = findNode(treeRef.current, dn);
      if (!node) return;
      const willExpand = !node.expanded;
      const needsLoad = willExpand && !node.loaded;

      setTree((prev) => {
        const next = structuredClone(prev);
        const target = findNode(next, dn);
        if (!target) return prev;
        target.expanded = willExpand;
        return next;
      });
      if (!needsLoad) return;

      try {
        const kids = await getChildren(session.domainKey, dn);
        setTree((prev) => {
          const next = structuredClone(prev);
          const node = findNode(next, dn);
          if (!node) return prev;
          node.loaded = true;
          node.children = toNodes(kids);
          return next;
        });
      } catch (err) {
        setError(msg(err));
      }
    },
    [session.domainKey],
  );

  const loadDeleted = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      setDeletedRows(await listDeletedObjects(session.domainKey, { limit: 500 }));
      clearSelection();
    } catch (err) {
      setError(msg(err));
    } finally {
      setBusy(false);
    }
  }, [session.domainKey, clearSelection]);

  /* Asked once per session. A reader without rights on the configuration NC
     gets `enabled: false` and an explanation rather than a failure. */
  useEffect(() => {
    void (async () => {
      try {
        setRecycleBin(await getRecycleBinState(session.domainKey));
      } catch {
        setRecycleBin(null);
      }
    })();
  }, [session.domainKey]);

  useEffect(() => {
    if (container === DELETED_OBJECTS) void loadDeleted();
  }, [container, loadDeleted]);

  const refresh = useCallback(() => {
    void loadRoot();
    if (container === DELETED_OBJECTS) void loadDeleted();
    else void loadContents(container, filter);
  }, [loadRoot, loadContents, loadDeleted, container, filter]);

  const runSearch = useCallback(
    async (q: string) => {
      const term = q.trim();
      setSearchTerm(term);
      if (!term) return;
      setBusy(true);
      setError(null);
      navigate(SAVED_QUERIES);
      try {
        const kind =
          filter === "user" || filter === "group" || filter === "computer"
            ? filter
            : "object";
        const result = await searchDirectory({
          domainKey: session.domainKey,
          kind,
          query: term,
          searchBase: rootDn,
          limit: 200,
        });
        setSearchRows(result);
        clearSelection();
      } catch (err) {
        setError(msg(err));
        setSearchRows([]);
      } finally {
        setBusy(false);
      }
    },
    [session.domainKey, rootDn, filter, navigate, clearSelection],
  );

  /* -- sorting ----------------------------------------------------------- */

  const sorted = useMemo(() => {
    const dir = sortAsc ? 1 : -1;
    // One definition of a column's text serves both the cell and the sort, so
    // the two can never drift apart.
    const key = (r: DirectoryRow) => COLUMNS[sortKey]?.value(r) ?? "";
    return [...listRows].sort(
      (a, b) =>
        dir * key(a).localeCompare(key(b)) ||
        (a.displayName || a.name).localeCompare(b.displayName || b.name),
    );
  }, [listRows, sortKey, sortAsc]);

  const selectedDns = useMemo(() => new Set(sel.dns), [sel.dns]);

  /* Rows in list order, so bulk work follows what is on screen. */
  const selectedRows = useMemo(
    () => sorted.filter((r) => selectedDns.has(r.distinguishedName)),
    [sorted, selectedDns],
  );

  /* Verbs that only make sense on one object read this. */
  const selected = selectedRows.length === 1 ? selectedRows[0]! : null;

  const onSelectRow = useCallback(
    (row: DirectoryRow, mode: SelectMode) => {
      const dn = row.distinguishedName;
      setSel((prev) => {
        if (mode === "toggle") {
          const has = prev.dns.includes(dn);
          return {
            dns: has ? prev.dns.filter((d) => d !== dn) : [...prev.dns, dn],
            anchor: has ? prev.anchor : dn,
          };
        }
        if (mode === "range" && prev.anchor) {
          const order = sorted.map((r) => r.distinguishedName);
          const a = order.indexOf(prev.anchor);
          const b = order.indexOf(dn);
          if (a >= 0 && b >= 0) {
            const [lo, hi] = a <= b ? [a, b] : [b, a];
            return { dns: order.slice(lo, hi + 1), anchor: prev.anchor };
          }
        }
        return { dns: [dn], anchor: dn };
      });
    },
    [sorted],
  );

  const selectAll = useCallback(
    () =>
      setSel({
        dns: sorted.map((r) => r.distinguishedName),
        anchor: sorted[0]?.distinguishedName ?? null,
      }),
    [sorted],
  );

  function onSort(k: SortKey) {
    if (k === sortKey) setSortAsc((v) => !v);
    else {
      setSortKey(k);
      setSortAsc(true);
    }
  }

  /* -- verbs ------------------------------------------------------------- */

  const openProperties = useCallback(
    (row: DirectoryRow, tab: "general" | "account" = "general") =>
      setPropsFor({ row, tab }),
    [],
  );

  /* Restore puts the object back under its lastKnownParent by default. The
     "Restore To..." variant exists because AD refuses the default when the
     original parent was itself deleted, which is common: an OU is emptied and
     removed in one go, so everything inside it needs somewhere else to land. */
  const doRestore = useCallback(
    async (row: DirectoryRow, targetPath?: string) => {
      setWorking(true);
      setAskError(null);
      try {
        const back = await restoreObject(session.domainKey, row.distinguishedName, {
          ...(targetPath ? { targetPath } : {}),
        });
        setStatus(`Restored ${row.name} to ${back.distinguishedName}`);
        setAsk(null);
        setRestoreTo(null);
        await loadDeleted();
        await loadRoot();
      } catch (err) {
        setAskError(msg(err));
      } finally {
        setWorking(false);
      }
    },
    [session.domainKey, loadDeleted, loadRoot],
  );

  const deletedVerbs = useCallback(
    (row: DirectoryRow): MenuItem[] => {
      // A recycled object has had its attributes stripped; nothing to restore.
      const recycled = row.isRecycled === true;
      const parent = row.lastKnownParent || "";
      return [
        menuLabel(row.name || "Deleted object"),
        SEP,
        {
          label: VERB.restore,
          isDefault: true,
          disabled: recycled || !parent,
          onSelect: () => void doRestore(row),
        },
        {
          label: VERB.restoreTo,
          disabled: recycled,
          onSelect: () => setRestoreTo(row),
        },
        SEP,
        { label: VERB.refresh, accel: "F5", onSelect: refresh },
        SEP,
        {
          label: VERB.copyDn,
          onSelect: () => void navigator.clipboard?.writeText(row.distinguishedName),
        },
      ];
    },
    [doRestore, refresh],
  );

  const activate = useCallback(
    (row: DirectoryRow) => {
      // In the Deleted Objects list the bold default is Restore, so that is
      // what a double-click does. A property sheet for a deleted object would
      // show a stripped husk and offer edits the directory will refuse.
      if (row.isDeleted === true) {
        if (row.isRecycled !== true && row.lastKnownParent) void doRestore(row);
        return;
      }
      const kind = objectKind(row);
      // ADUC: double-clicking a container opens it; anything else opens
      // Properties. Both are the bold default in the context menu.
      if (kind === "ou" || kind === "container") navigate(row.distinguishedName);
      else openProperties(row);
    },
    [navigate, openProperties, doRestore],
  );

  /* -- write verbs ------------------------------------------------------- */

  const runWrite = useCallback(
    async (fn: () => Promise<unknown>, after?: () => void) => {
      setWorking(true);
      setAskError(null);
      try {
        await fn();
        setAsk(null);
        after?.();
        refresh();
      } catch (err) {
        // Keep the dialog open holding the error - retyping the value after a
        // transient failure is pure friction.
        setAskError(msg(err));
      } finally {
        setWorking(false);
      }
    },
    [refresh],
  );

  const askRename = useCallback(
    (row: DirectoryRow) => {
      setAskError(null);
      setAsk({
        kind: "prompt",
        title: "Rename",
        message: <>Rename <strong>{row.name}</strong>.</>,
        label: "New name",
        initialValue: row.name,
        confirmLabel: "OK",
        onConfirm: (value) =>
          void runWrite(() => renameObject(session.domainKey, row.distinguishedName, value)),
      });
    },
    [runWrite, session.domainKey],
  );

  const askDelete = useCallback(
    (row: DirectoryRow) => {
      const kind = objectKind(row);
      setAskError(null);
      setAsk({
        kind: "confirm",
        title: "Active Directory Domain Services",
        message: (
          <>
            Are you sure you want to delete the {kindLabel(kind).toLowerCase()}{" "}
            named <strong>{row.displayName || row.name}</strong>?
            {(kind === "ou" || kind === "container") && (
              <> This container must be empty, or the directory will refuse.</>
            )}
          </>
        ),
        confirmLabel: "Yes",
        danger: true,
        onConfirm: () =>
          void runWrite(
            () => removeObject(session.domainKey, row.distinguishedName),
            () => clearSelection(),
          ),
      });
    },
    [runWrite, session.domainKey],
  );

  const askMove = useCallback((row: DirectoryRow) => {
    setAskError(null);
    setMoveTargets([row]);
  }, []);

  const toggleEnabled = useCallback(
    (row: DirectoryRow) =>
      void runWrite(() =>
        setAccountEnabled(session.domainKey, row.distinguishedName, row.enabled === false),
      ),
    [runWrite, session.domainKey],
  );

  const newSubmenu = useCallback(
    (path: string): MenuItem => ({
      label: "New",
      children: (
        [
          [VERB.newUser, "user"],
          [VERB.newGroup, "group"],
          [VERB.newComputer, "computer"],
          [VERB.newContact, "contact"],
        ] as Array<[string, NewKind]>
      )
        .map<MenuItem>(([label, kind]) => ({
          label,
          onSelect: () => setNewIn({ path, type: kind }),
        }))
        .concat([
          SEP,
          {
            label: VERB.newOu,
            onSelect: () => setNewIn({ path, type: "organizationalUnit" }),
          },
        ]),
    }),
    [],
  );

  /**
   * The menu for a multi-selection. Only verbs meaningful applied N times
   * appear; Rename and Properties are single-object by nature and are simply
   * absent rather than greyed, because a greyed verb invites you to wonder
   * what is wrong with the selection.
   */
  const bulkVerbs = useCallback(
    (targets: DirectoryRow[]): MenuItem[] => {
      const accounts = targets.filter((r) => {
        const k = objectKind(r);
        return k === "user" || k === "computer";
      });
      const principals = targets.filter((r) => {
        const k = objectKind(r);
        return k === "user" || k === "group" || k === "computer";
      });
      const items: MenuItem[] = [
        menuLabel(`${targets.length} objects selected`),
        SEP,
      ];

      if (accounts.length > 0) {
        items.push({
          label: VERB.enableAccount,
          onSelect: () =>
            setBulk({
              title: VERB.enableAccount,
              verb: "Enabling",
              targets: accounts,
              run: (row) =>
                setAccountEnabled(session.domainKey, row.distinguishedName, true),
            }),
        });
        items.push({
          label: VERB.disableAccount,
          onSelect: () =>
            setBulk({
              title: VERB.disableAccount,
              verb: "Disabling",
              targets: accounts,
              run: (row) =>
                setAccountEnabled(session.domainKey, row.distinguishedName, false),
            }),
        });
        items.push(SEP);
      }

      if (principals.length > 0) {
        items.push({
          label: VERB.addToGroup,
          onSelect: () => setBulkPickGroups(principals),
        });
        items.push(SEP);
      }

      items.push({
        label: VERB.move,
        onSelect: () => {
          setAskError(null);
          setMoveTargets(targets);
        },
      });

      items.push({
        label: VERB.delete,
        isDanger: true,
        onSelect: () =>
          setBulk({
            title: "Active Directory Domain Services",
            verb: "Deleting",
            targets,
            danger: true,
            confirmMessage: (
              <>
                Are you sure you want to delete these{" "}
                <strong>{targets.length} objects</strong>?
              </>
            ),
            run: (row) => removeObject(session.domainKey, row.distinguishedName),
          }),
      });

      items.push(SEP);
      /* ADUC offers the multi-select sheet only for one class at a time, and
         the fields on it are user attributes - writing `department` to an OU is
         not a thing the directory will accept. Offer it when the selection is
         all users, and say why when it is not, rather than hiding the verb and
         leaving the reader guessing. */
      const allUsers =
        targets.length > 0 && targets.every((r) => objectKind(r) === "user");
      items.push({
        label: allUsers
          ? VERB.properties
          : `${VERB.properties} (users only)`,
        accel: "Alt+Enter",
        disabled: !allUsers,
        onSelect: () => allUsers && setBulkProps(targets),
      });
      items.push({
        label: "Copy Distinguished Names",
        onSelect: () =>
          void navigator.clipboard?.writeText(
            targets.map((t) => t.distinguishedName).join("\n"),
          ),
      });
      return items;
    },
    [session.domainKey],
  );

  const objectVerbs = useCallback(
    (row: DirectoryRow): MenuItem[] => {
      const kind = objectKind(row);
      const isContainer = kind === "ou" || kind === "container";
      const isAccount = kind === "user" || kind === "computer";
      const items: MenuItem[] = [
        menuLabel(row.displayName || row.name || kindLabel(kind)),
        SEP,
      ];

      if (isContainer) {
        items.push({
          label: VERB.open,
          isDefault: true,
          onSelect: () => navigate(row.distinguishedName),
        });
        items.push(newSubmenu(row.distinguishedName));
        items.push({ label: VERB.delegateControl, disabled: true });
        items.push(SEP);
      }

      if (isAccount) {
        items.push({
          /* ADUC's Reset Password is its own dialog; here it lands on the
             Account tab of the property sheet, which is where the form is. */
          label: VERB.resetPassword,
          onSelect: () => openProperties(row, "account"),
        });
        items.push({
          label: row.enabled === false ? VERB.enableAccount : VERB.disableAccount,
          onSelect: () => toggleEnabled(row),
        });
        items.push(SEP);
      }

      if (kind === "user") {
        items.push({
          label: "Copy...",
          onSelect: () => setCopyFrom(row),
        });
        items.push(SEP);
      }

      if (kind === "computer") {
        items.push({
          label: "Reset Account",
          onSelect: () => {
            setAskError(null);
            setAsk({
              kind: "confirm",
              title: "Reset Account",
              message: (
                <>
                  Reset the computer account for <strong>{row.name}</strong>?
                  Its password returns to the machine default so it can rejoin
                  the domain. The computer must then actually be rejoined - it
                  will not work until it is.
                </>
              ),
              confirmLabel: "Yes",
              onConfirm: () =>
                void runWrite(() =>
                  resetComputerAccount(session.domainKey, row.distinguishedName),
                ),
            });
          },
        });
        items.push(SEP);
      }

      if (kind === "user" || kind === "group" || kind === "computer") {
        items.push({
          label: VERB.addToGroup,
          onSelect: () => setAddToGroupFor(row),
        });
        items.push(SEP);
      }

      items.push({ label: VERB.move, onSelect: () => askMove(row) });
      items.push({ label: VERB.rename, accel: "F2", onSelect: () => askRename(row) });
      items.push({
        label: VERB.delete,
        isDanger: true,
        accel: "Del",
        onSelect: () => askDelete(row),
      });
      items.push(SEP);
      items.push({
        label: VERB.copyDn,
        onSelect: () => void navigator.clipboard?.writeText(row.distinguishedName),
      });
      items.push({
        label: VERB.properties,
        isDefault: !isContainer,
        accel: "Alt+Enter",
        onSelect: () => openProperties(row),
      });
      return items;
    },
    [
      navigate,
      newSubmenu,
      openProperties,
      askMove,
      askRename,
      askDelete,
      toggleEnabled,
      runWrite,
      session.domainKey,
    ],
  );

  const containerVerbs = useCallback(
    (dn: string, name: string): MenuItem[] => {
      if (dn === DELETED_OBJECTS) {
        return [
          menuLabel("Deleted Objects"),
          SEP,
          { label: VERB.refresh, accel: "F5", onSelect: refresh },
        ];
      }
      if (dn === SAVED_QUERIES) {
        return [
          menuLabel("Saved Queries"),
          SEP,
          { label: VERB.find, accel: "Ctrl+F", onSelect: () => setFindOpen(true) },
          { label: VERB.refresh, accel: "F5", onSelect: refresh },
        ];
      }
      /* The naming context itself has no parent, so Move/Rename/Delete are
         meaningless on it - ADUC does not offer them either. */
      const isDomainRoot = dn === rootDn;

      return [
        menuLabel(name),
        SEP,
        { label: VERB.open, isDefault: true, onSelect: () => navigate(dn) },
        newSubmenu(dn),
        { label: VERB.delegateControl, disabled: true },
        SEP,
        { label: VERB.find, accel: "Ctrl+F", onSelect: () => setFindOpen(true) },
        { label: VERB.refresh, accel: "F5", onSelect: refresh },
        SEP,
        {
          label: VERB.move,
          disabled: isDomainRoot,
          onSelect: () => askMove({ distinguishedName: dn, name } as DirectoryRow),
        },
        {
          label: VERB.rename,
          disabled: isDomainRoot,
          onSelect: () => askRename({ distinguishedName: dn, name } as DirectoryRow),
        },
        {
          label: VERB.delete,
          isDanger: true,
          disabled: isDomainRoot,
          onSelect: () =>
            askDelete({
              distinguishedName: dn,
              name,
              objectClass: "organizationalUnit",
            } as DirectoryRow),
        },
        SEP,
        {
          label: VERB.copyDn,
          onSelect: () => void navigator.clipboard?.writeText(dn),
        },
        {
          label: VERB.properties,
          accel: "Alt+Enter",
          onSelect: () =>
            openProperties({
              distinguishedName: dn,
              name,
              objectClass: isDomainRoot ? "domainDNS" : "organizationalUnit",
            } as DirectoryRow),
        },
      ];
    },
    [
      navigate,
      newSubmenu,
      refresh,
      askMove,
      askRename,
      askDelete,
      rootDn,
      openProperties,
    ],
  );

  /* The Action menu is literally the selection's own menu - that is what MMC
     does, and it is why an admin can use either without learning twice. */
  const actionItems = useMemo<MenuItem[]>(() => {
    if (showingDeleted) {
      return selected
        ? deletedVerbs(selected)
        : containerVerbs(DELETED_OBJECTS, "Deleted Objects");
    }
    if (selectedRows.length > 1) return bulkVerbs(selectedRows);
    if (selected) return objectVerbs(selected);
    return containerVerbs(container, containerName(container, rootDn));
  }, [
    selected,
    selectedRows,
    container,
    rootDn,
    objectVerbs,
    containerVerbs,
    bulkVerbs,
    deletedVerbs,
    showingDeleted,
  ]);

  const menus = useMemo<Menu[]>(
    () => [
      {
        title: "File",
        mnemonic: "f",
        items: [
          {
            label: VERB.exportList,
            onSelect: () => exportList(sorted, containerName(container, rootDn)),
          },
          SEP,
          { label: VERB.properties, disabled: !selected, onSelect: () => selected && openProperties(selected) },
          SEP,
          { label: "Close", onSelect: () => window.close?.() },
        ],
      },
      { title: "Action", mnemonic: "a", items: actionItems },
      {
        title: "View",
        mnemonic: "v",
        items: [
          ...FILTERS.map<MenuItem>(([id, label]) => ({
            label: filter === id ? `* ${label}` : `   ${label}`,
            onSelect: () => setFilter(id),
          })),
          SEP,
          { label: VERB.refresh, accel: "F5", onSelect: refresh },
          SEP,
          {
            label: ldapFilter ? "Filter Options... (active)" : "Filter Options...",
            onSelect: () => setFilterOpen(true),
          },
          {
            label: "Add/Remove Columns...",
            onSelect: () => setColumnsOpen(true),
          },
          SEP,
          {
            label: "Sidecar Log...",
            onSelect: () => setLogOpen(true),
          },
        ],
      },
      {
        title: "Help",
        mnemonic: "h",
        items: [
          {
            label: "Operations Masters...",
            onSelect: () =>
              void getOperationsMasters(session.domainKey)
                .then(setFsmo)
                .catch((err) =>
                  setError(err instanceof Error ? err.message : String(err)),
                ),
          },
          SEP,
          {
            label: "About PSOpenAD-FE",
            onSelect: () =>
              setStatus(
                "PSOpenAD-FE - ADUC-style front end for PSOpenAD (jborean93). Not a Microsoft product.",
              ),
          },
          {
            label: "PSOpenAD documentation",
            onSelect: () =>
              void window.open?.(
                "https://github.com/jborean93/PSOpenAD/blob/main/docs/en-US/PSOpenAD.md",
                "_blank",
              ),
          },
        ],
      },
    ],
    [actionItems, filter, openProperties, refresh, selected, ldapFilter, sorted, container, rootDn],
  );

  /* -- keyboard ---------------------------------------------------------- */

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "F5") {
        e.preventDefault();
        refresh();
      } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "f") {
        e.preventDefault();
        setFindOpen(true);
      } else if (e.altKey && e.key === "Enter" && selected) {
        e.preventDefault();
        openProperties(selected);
      } else if (e.altKey && e.key === "ArrowLeft") {
        e.preventDefault();
        goBack();
      } else if (e.altKey && e.key === "ArrowRight") {
        e.preventDefault();
        goForward();
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [refresh, selected, openProperties, goBack, goForward]);

  const startResize = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    const startX = e.clientX;
    const startW = treeW;
    const onMove = (ev: MouseEvent) =>
      setTreeW(Math.min(560, Math.max(160, startW + ev.clientX - startX)));
    const onUp = () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
      document.body.classList.remove("is-resizing");
    };
    document.body.classList.add("is-resizing");
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  }, [treeW]);

  /* -- render ------------------------------------------------------------ */

  const count = sorted.length;
  const statusLeft = error
    ? error
    : (status ??
      (showingSearch
        ? searchTerm
          ? `${count} object(s) matching "${searchTerm}"`
          : "No search run yet - use Find."
        : selectedRows.length > 1
        ? `${selectedRows.length} of ${count} object(s) selected`
        : truncated !== null && !showingDeleted
          ? `First ${truncated} object(s) - this container holds more. Use Find, or View > Filter Options, to narrow it.`
          : `${count} object(s)`));

  return (
    <ErrorBoundary label="the console">
      <div className="console">
        <MenuBar menus={menus} />

        <div className="toolbar" role="toolbar" aria-label="Console actions">
          <TB glyph="back" label="Back" disabled={nav.at <= 0} onClick={goBack} />
          <TB
            glyph="forward"
            label="Forward"
            disabled={nav.at >= nav.stack.length - 1}
            onClick={goForward}
          />
          <TB
            glyph="up"
            label="Up One Level"
            disabled={!parentDn}
            onClick={() => parentDn && navigate(parentDn)}
          />
          <span className="tb-sep" />
          <TB glyph="refresh" label="Refresh (F5)" onClick={refresh} />
          <TB glyph="find" label="Find... (Ctrl+F)" onClick={() => setFindOpen(true)} />
          <span className="tb-sep" />
          {/* These create in the container currently shown, which is why they
              are dead on Saved Queries: a search result is not a place. */}
          <TB
            glyph="newUser"
            label={`New ${VERB.newUser} in ${containerName(container, rootDn)}`}
            disabled={showingPseudo}
            hint="Select a container in the tree first"
            onClick={() => setNewIn({ path: container, type: "user" })}
          />
          <TB
            glyph="newGroup"
            label={`New ${VERB.newGroup} in ${containerName(container, rootDn)}`}
            disabled={showingPseudo}
            hint="Select a container in the tree first"
            onClick={() => setNewIn({ path: container, type: "group" })}
          />
          <TB
            glyph="newOu"
            label={`New ${VERB.newOu} in ${containerName(container, rootDn)}`}
            disabled={showingPseudo}
            hint="Select a container in the tree first"
            onClick={() => setNewIn({ path: container, type: "organizationalUnit" })}
          />
          <span className="tb-sep" />
          {/* ADUC's toolbar Properties acts on whatever has focus: the selected
              row if there is one, otherwise the container open in the tree.
              Greying it out until a row is picked made it look broken. */}
          <TB
            glyph="properties"
            label="Properties (Alt+Enter)"
            disabled={showingPseudo}
            onClick={() =>
              selected
                ? openProperties(selected)
                : openProperties({
                    distinguishedName: container,
                    name: containerName(container, rootDn),
                    objectClass: container === rootDn ? "domainDNS" : "organizationalUnit",
                  } as DirectoryRow)
            }
          />

          <div className="toolbar-filter">
            <label htmlFor="obj-filter">View</label>
            <select
              id="obj-filter"
              value={filter}
              onChange={(e) => setFilter(e.target.value as ContentFilter)}
            >
              {FILTERS.map(([id, label]) => (
                <option key={id} value={id}>
                  {label}
                </option>
              ))}
            </select>
          </div>
        </div>

        <div
          className="console-body"
          style={{ gridTemplateColumns: `${treeW}px 5px minmax(0, 1fr)` }}
        >
          <aside className="tree-pane">
            <ConsoleTree
              serverLabel={session.dnsHostName || session.server}
              domainName={domainShortName(rootDn)}
              domainDn={rootDn}
              nodes={tree}
              selectedDn={container}
              showDeletedObjects={recycleBin?.enabled === true}
              onSelect={navigate}
              onToggle={(dn) => void toggleNode(dn)}
              onContextMenu={(e, dn, name) => menu.open(e, containerVerbs(dn, name))}
            />
          </aside>

          <div
            className="splitter"
            role="separator"
            aria-orientation="vertical"
            aria-label="Resize console tree"
            onMouseDown={startResize}
            /* Double-click restores the default, as MMC's splitters do. */
            onDoubleClick={() => setTreeW(268)}
          />

          <section
            className="results-pane"
            onContextMenu={(e) => {
              /* Rows stop propagation, so reaching here means blank space. */
              if (showingSearch) return;
              menu.open(e, containerVerbs(container, containerName(container, rootDn)));
            }}
          >
            <div className="results-head" title={showingPseudo ? undefined : container}>
              <span className="results-title">
                {showingSearch
                  ? "Saved Queries"
                  : showingDeleted
                    ? "Deleted Objects"
                    : containerName(container, rootDn)}
              </span>
              <span className="results-path">
                {showingSearch
                  ? searchTerm
                    ? `Find: ${searchTerm}`
                    : "no query"
                  : showingDeleted
                    ? (recycleBin?.deletedObjectsDn ?? "")
                    : container}
              </span>
            </div>

            <ObjectList
              rows={sorted}
              columns={activeCols}
              selectedDns={selectedDns}
              busy={busy}
              emptyMessage={
                showingSearch
                  ? "No objects matched. Try a different name or widen the View filter."
                  : showingDeleted
                    ? "Nothing has been deleted, or everything deleted has since been purged."
                    : "There are no items to show in this container for the current View filter."
              }
              sortKey={sortKey}
              sortAsc={sortAsc}
              onSort={onSort}
              onSelect={onSelectRow}
              onSelectAll={selectAll}
              onActivate={activate}
              onContextMenu={(e, row) =>
                menu.open(
                  e,
                  showingDeleted
                    ? deletedVerbs(row)
                    : selectedRows.length > 1 && selectedDns.has(row.distinguishedName)
                      ? bulkVerbs(selectedRows)
                      : objectVerbs(row),
                )
              }
            />

            <footer className="status-bar">
              <span className={error ? "status-error" : undefined}>{statusLeft}</span>
              <span className="status-right" title={`${session.username} - ${session.connectionStep}`}>
                {session.connectionStep} - {session.whoami || session.username}
              </span>
            </footer>
          </section>
        </div>

        <ContextMenu state={menu.state} onClose={menu.close} />

        {filterOpen && (
          <AskDialog
            kind="prompt"
            title="Filter Options"
            message={
              <>
                Show only objects matching an LDAP filter, for example{" "}
                <code>(&amp;(objectClass=user)(!(description=*)))</code>. Leave
                it empty to go back to the View dropdown.
              </>
            }
            label="LDAP filter"
            initialValue={ldapFilter}
            confirmLabel="OK"
            onCancel={() => setFilterOpen(false)}
            onConfirm={(value) => {
              setLdapFilter(value);
              setFilterOpen(false);
            }}
          />
        )}

        {findOpen && (
          <FindDialog
            initial={searchTerm}
            scope={domainShortName(rootDn)}
            onClose={() => setFindOpen(false)}
            onSearch={(q) => {
              setFindOpen(false);
              void runSearch(q);
            }}
          />
        )}

        {logOpen && <LogDialog onClose={() => setLogOpen(false)} />}

        {ask && (
          <AskDialog
            kind={ask.kind}
            title={ask.title}
            message={ask.message}
            label={ask.label}
            initialValue={ask.initialValue}
            confirmLabel={ask.confirmLabel}
            danger={ask.danger}
            busy={working}
            error={askError}
            onCancel={() => {
              setAsk(null);
              setAskError(null);
            }}
            onConfirm={ask.onConfirm}
          />
        )}

        {addToGroupFor && (
          <ObjectPicker
            domainKey={session.domainKey}
            searchBase={rootDn}
            allow={["group"]}
            title={`Add ${addToGroupFor.displayName || addToGroupFor.name} to groups`}
            busy={working}
            error={askError}
            onCancel={() => {
              setAddToGroupFor(null);
              setAskError(null);
            }}
            onPick={(groups) =>
              void runWrite(
                async () => {
                  for (const g of groups) {
                    await addGroupMember(session.domainKey, g, [
                      addToGroupFor.distinguishedName,
                    ]);
                  }
                },
                () => setAddToGroupFor(null),
              )
            }
          />
        )}

        {bulk && (
          <BulkDialog
            title={bulk.title}
            verb={bulk.verb}
            targets={bulk.targets}
            danger={bulk.danger}
            confirmMessage={bulk.confirmMessage}
            run={bulk.run}
            onFinished={refresh}
            onClose={() => setBulk(null)}
          />
        )}

        {fsmo && (
          <div className="modal-scrim" onMouseDown={() => setFsmo(null)}>
            <div
              className="dialog fsmo-dialog"
              role="dialog"
              aria-modal="true"
              aria-label="Operations Masters"
              onMouseDown={(e) => e.stopPropagation()}
            >
              <div className="dialog-title">
                <span>Operations Masters</span>
                <button
                  type="button"
                  className="dialog-close"
                  onClick={() => setFsmo(null)}
                  aria-label="Close"
                >
                  &#10005;
                </button>
              </div>
              <div className="dialog-body">
                <div className="list-frame">
                  <table className="sheet-table">
                    <thead>
                      <tr>
                        <th>Role</th>
                        <th>Holder</th>
                      </tr>
                    </thead>
                    <tbody>
                      {fsmo.map((f) => (
                        <tr key={f.role}>
                          <td>{f.role}</td>
                          <td className="mono">{f.holder ?? "unknown"}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                <p className="dialog-note">
                  Read-only. Moving or seizing a role is a domain-wide operation
                  with real consequences and belongs on a domain controller, not
                  in a browsing tool.
                </p>
              </div>
              <div className="dialog-footer">
                <button type="button" className="btn" onClick={() => setFsmo(null)}>
                  Close
                </button>
              </div>
            </div>
          </div>
        )}

        {copyFrom && (
          <AskDialog
            kind="prompt"
            title={`Copy ${copyFrom.displayName || copyFrom.name}`}
            message={
              <>
                Creates a new user in the same container as{" "}
                <strong>{copyFrom.displayName || copyFrom.name}</strong>,
                carrying its group memberships and role attributes. The copy is
                created disabled and without a password, like any new account.
              </>
            }
            label="Logon name"
            initialValue=""
            confirmLabel="Copy"
            busy={working}
            error={askError}
            onCancel={() => {
              setCopyFrom(null);
              setAskError(null);
            }}
            onConfirm={(sam) => {
              const src = copyFrom;
              void runWrite(
                async () => {
                  const res = await copyObject({
                    domainKey: session.domainKey,
                    source: src.distinguishedName,
                    name: sam,
                    sAMAccountName: sam,
                    namingContext: rootDn,
                  });
                  if (res.groupsFailed.length > 0) {
                    setStatus(
                      `Copied, but could not add the account to ${res.groupsFailed.length} group(s): ${res.groupsFailed.join(", ")}`,
                    );
                  } else {
                    setStatus(
                      `Copied to ${sam} with ${res.groupsCopied} group membership(s).`,
                    );
                  }
                },
                () => setCopyFrom(null),
              );
            }}
          />
        )}

        {bulkProps && (
          <BulkPropertiesDialog
            targets={bulkProps}
            domainKey={session.domainKey}
            searchBase={rootDn}
            onCancel={() => setBulkProps(null)}
            onApply={(changes: BulkPropertyChanges) => {
              const targets = bulkProps;
              setBulkProps(null);
              const fields =
                Object.keys(changes.set).length + changes.clear.length;
              setBulk({
                title: VERB.properties,
                verb: "Updating",
                targets,
                confirmMessage: null,
                run: (row) =>
                  setAttributes({
                    domainKey: session.domainKey,
                    identity: row.distinguishedName,
                    ...(Object.keys(changes.set).length
                      ? { set: changes.set }
                      : {}),
                    ...(changes.clear.length ? { clear: changes.clear } : {}),
                    ...(changes.expandTokens ? { expandTokens: true } : {}),
                  }),
              });
              setStatus(
                `Applying ${fields} field(s) to ${targets.length} object(s)`,
              );
            }}
          />
        )}

        {columnsOpen && (
          <ColumnsDialog
            columns={activeCols}
            defaults={showingDeleted ? DELETED_COLUMNS : DEFAULT_COLUMNS}
            onCancel={() => setColumnsOpen(false)}
            onApply={applyColumns}
          />
        )}

        {restoreTo && (
          <ContainerPicker
            domainKey={session.domainKey}
            rootDn={rootDn}
            rootLabel={domainShortName(rootDn)}
            title={`Restore ${restoreTo.name} to`}
            busy={working}
            error={askError}
            confirmLabel="Restore"
            onCancel={() => {
              setRestoreTo(null);
              setAskError(null);
            }}
            onPick={(target) => void doRestore(restoreTo, target)}
          />
        )}

        {moveTargets && (
          <ContainerPicker
            domainKey={session.domainKey}
            rootDn={rootDn}
            rootLabel={domainShortName(rootDn)}
            title={
              moveTargets.length === 1
                ? `Move ${moveTargets[0]!.displayName || moveTargets[0]!.name} to`
                : `Move ${moveTargets.length} objects to`
            }
            /* An object cannot be moved into itself, and a container cannot be
               moved into its own subtree - the directory refuses either way,
               but saying so up front beats a server error. */
            disallow={moveTargets.map((t) => t.distinguishedName)}
            busy={working}
            error={askError}
            confirmLabel="Move"
            onCancel={() => {
              setMoveTargets(null);
              setAskError(null);
            }}
            onPick={(target) => {
              const targets = moveTargets;
              if (targets.length === 1) {
                void runWrite(
                  () =>
                    moveObject(
                      session.domainKey,
                      targets[0]!.distinguishedName,
                      target,
                    ),
                  () => {
                    setMoveTargets(null);
                    clearSelection();
                  },
                );
              } else {
                setMoveTargets(null);
                setBulk({
                  title: VERB.move,
                  verb: "Moving",
                  targets,
                  run: (row) =>
                    moveObject(session.domainKey, row.distinguishedName, target),
                });
              }
            }}
          />
        )}

        {bulkPickGroups && (
          <ObjectPicker
            domainKey={session.domainKey}
            searchBase={rootDn}
            allow={["group"]}
            title={`Add ${bulkPickGroups.length} objects to groups`}
            onCancel={() => setBulkPickGroups(null)}
            onPick={(groups) => {
              const targets = bulkPickGroups;
              setBulkPickGroups(null);
              setBulk({
                title: VERB.addToGroup,
                verb: "Adding",
                targets,
                run: async (row) => {
                  for (const g of groups) {
                    await addGroupMember(session.domainKey, g, [
                      row.distinguishedName,
                    ]);
                  }
                },
              });
            }}
          />
        )}

        {newIn && (
          <NewObjectDialog
            domainKey={session.domainKey}
            path={newIn.path}
            type={newIn.type}
            realm={domainShortName(rootDn)}
            onClose={() => setNewIn(null)}
            onCreated={(row) => {
              setNewIn(null);
              refresh();
              if (row) setSel({ dns: [row.distinguishedName], anchor: row.distinguishedName });
            }}
          />
        )}

        {propsFor && (
          <PropertiesDialog
            key={propsFor.row.distinguishedName}
            domainKey={session.domainKey}
            row={propsFor.row}
            passwordCapable={session.passwordCapable}
            initialTab={propsFor.tab}
            onClose={() => setPropsFor(null)}
            onNavigate={(dn) => navigate(parentOfDn(dn))}
          />
        )}
      </div>
    </ErrorBoundary>
  );
}

/* -- toolbar button ------------------------------------------------------ */

function TB({
  glyph,
  label,
  disabled,
  hint,
  onClick,
}: {
  glyph: ToolbarGlyph;
  label: string;
  disabled?: boolean;
  hint?: string;
  onClick?: () => void;
}) {
  return (
    <button
      type="button"
      className="tb-btn"
      title={disabled && hint ? `${label} - ${hint}` : label}
      aria-label={label}
      disabled={disabled}
      onClick={onClick}
    >
      <ToolbarIcon glyph={glyph} />
    </button>
  );
}

/* -- Find dialog --------------------------------------------------------- */

function FindDialog({
  initial,
  scope,
  onClose,
  onSearch,
}: {
  initial: string;
  scope: string;
  onClose: () => void;
  onSearch: (q: string) => void;
}) {
  const [q, setQ] = useState(initial);
  return (
    <div className="modal-scrim" onMouseDown={onClose}>
      <form
        className="dialog find-dialog"
        role="dialog"
        aria-modal="true"
        aria-label="Find Users, Contacts, and Groups"
        onMouseDown={(e) => e.stopPropagation()}
        onSubmit={(e) => {
          e.preventDefault();
          onSearch(q);
        }}
      >
        <div className="dialog-title">
          <span>Find Users, Contacts, and Groups</span>
          <button type="button" className="dialog-close" onClick={onClose} aria-label="Close">
            &#10005;
          </button>
        </div>
        <div className="dialog-body">
          <div className="field-row">
            <label className="field-label" htmlFor="find-in">
              In
            </label>
            <input id="find-in" className="field-input mono" value={scope} readOnly />
          </div>
          <div className="field-row">
            <label className="field-label" htmlFor="find-name">
              Name
            </label>
            <input
              id="find-name"
              className="field-input"
              value={q}
              autoFocus
              placeholder="Name, logon name or description"
              onChange={(e) => setQ(e.target.value)}
            />
          </div>
          <p className="dialog-note">
            Searches the whole domain. Narrow the object class with the View
            filter on the toolbar before searching.
          </p>
        </div>
        <div className="dialog-footer">
          <button type="submit" className="btn btn-primary">
            Find Now
          </button>
          <button type="button" className="btn" onClick={onClose}>
            Cancel
          </button>
        </div>
      </form>
    </div>
  );
}

/* -- helpers ------------------------------------------------------------- */

/**
 * ADUC's Export List. Writes what is on screen, in screen order, as CSV.
 *
 * Exporting the visible rows rather than re-querying is deliberate: the point
 * is to hand someone the list you are looking at, filters and sort included.
 */
function exportList(rows: DirectoryRow[], containerLabel: string) {
  const header = ["Name", "Type", "Description", "Logon name", "Distinguished name"];
  const csv = (v: string | null | undefined) => {
    const t = v ?? "";
    return /[",\n]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t;
  };
  const body = rows.map((r) =>
    [
      csv(r.displayName || r.name),
      csv(objectKind(r) === "group" ? groupLabel(r.groupType) : kindLabel(objectKind(r))),
      csv(r.description),
      csv(r.samAccountName),
      csv(r.distinguishedName),
    ].join(","),
  );
  const text = [header.join(","), ...body].join("\n");

  const safe = containerLabel.replace(/[^A-Za-z0-9._-]+/g, "-");
  const url = URL.createObjectURL(new Blob([text], { type: "text/csv" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = `${safe || "export"}.csv`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

function toNodes(rows: DirectoryRow[]): TreeNode[] {
  return rows
    .filter((r) => r.distinguishedName)
    .map((r) => ({
      dn: r.distinguishedName,
      name: r.name || r.distinguishedName,
      objectClass: r.objectClass,
      loaded: false,
      expanded: false,
    }));
}

function findNode(nodes: TreeNode[], dn: string): TreeNode | null {
  for (const n of nodes) {
    if (n.dn === dn) return n;
    const hit = n.children ? findNode(n.children, dn) : null;
    if (hit) return hit;
  }
  return null;
}

function containerName(dn: string, rootDn: string) {
  if (dn === SAVED_QUERIES) return "Saved Queries";
  if (dn === rootDn) return domainShortName(rootDn);
  return dn.split(",")[0]?.replace(/^[^=]+=/, "") || dn;
}

function parentOfDn(dn: string) {
  return dn.split(",").slice(1).join(",");
}

function domainShortName(nc: string) {
  if (!nc) return "";
  const parts = nc
    .split(",")
    .map((p) => p.trim())
    .filter((p) => /^DC=/i.test(p))
    .map((p) => p.slice(3));
  return parts.join(".") || nc;
}

function msg(err: unknown) {
  return err instanceof Error ? err.message : String(err);
}
