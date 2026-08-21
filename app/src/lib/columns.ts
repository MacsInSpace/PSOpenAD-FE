/**
 * The result pane's column registry - ADUC's View > Add/Remove Columns.
 *
 * One place defines what a column is called, how its cell reads and how it
 * sorts, so adding a column is a single entry rather than three edits that can
 * disagree with each other.
 *
 * Name and Type are rendered specially by ObjectList (an icon, and the group
 * scope wording), but they still declare a `value` here because that is what
 * sorting uses. Keeping every column sortable the same way is the point.
 */
import { objectKind, type DirectoryRow } from "./api";
import { groupLabel, kindLabel } from "./adTerms";

export type ColumnKey =
  | "name"
  | "type"
  | "description"
  | "sam"
  | "upn"
  | "mail"
  | "dn"
  | "whenCreated"
  | "whenChanged"
  | "lastKnownParent";

type ColumnDef = {
  label: string;
  value: (row: DirectoryRow) => string;
  /** Fixed-width, for anything read character by character. */
  mono?: boolean;
};

/**
 * A directory timestamp is only useful if it reads at a glance. The raw value
 * is kept in the cell's title so the exact value is still recoverable.
 */
function stamp(v: string | null | undefined): string {
  if (!v) return "";
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) return v;
  return d.toLocaleString(undefined, {
    year: "numeric",
    month: "short",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export const COLUMNS: Record<ColumnKey, ColumnDef> = {
  name: { label: "Name", value: (r) => r.displayName || r.name || "" },
  type: {
    label: "Type",
    value: (r) => {
      const kind = objectKind(r);
      return kind === "group" ? groupLabel(r.groupType) : kindLabel(kind);
    },
  },
  description: { label: "Description", value: (r) => r.description ?? "" },
  sam: { label: "Logon name", value: (r) => r.samAccountName ?? "", mono: true },
  upn: {
    label: "User logon name",
    value: (r) => r.userPrincipalName ?? "",
    mono: true,
  },
  mail: { label: "E-Mail Address", value: (r) => r.mail ?? "", mono: true },
  dn: {
    label: "Distinguished name",
    value: (r) => r.distinguishedName,
    mono: true,
  },
  whenCreated: { label: "Created", value: (r) => stamp(r.whenCreated) },
  whenChanged: { label: "Modified", value: (r) => stamp(r.whenChanged) },
  lastKnownParent: {
    label: "Last known parent",
    value: (r) => r.lastKnownParent ?? "",
    mono: true,
  },
};

/**
 * ADUC's own leading three, plus the logon name this app always has to hand.
 * Order is deliberate and is what "Restore Defaults" returns to.
 */
export const DEFAULT_COLUMNS: ColumnKey[] = ["name", "type", "description", "sam"];

/**
 * The Deleted Objects list answers different questions: what was it called,
 * where did it live, and when did it go. Description is nearly always empty on
 * a deleted object, so it does not earn a column here.
 */
export const DELETED_COLUMNS: ColumnKey[] = [
  "name",
  "type",
  "whenChanged",
  "lastKnownParent",
];

/** Columns offered in the picker, in the order they are listed there. */
export const ALL_COLUMNS: ColumnKey[] = [
  "name",
  "type",
  "description",
  "sam",
  "upn",
  "mail",
  "whenCreated",
  "whenChanged",
  "dn",
  "lastKnownParent",
];

/**
 * Name is not removable. ADUC does the same, and for the same reason: a row
 * with nothing identifying in it is not a row anyone can act on.
 */
export const REQUIRED_COLUMN: ColumnKey = "name";

const STORE_PREFIX = "psopenad-fe.columns.";

export function loadColumns(view: string, fallback: ColumnKey[]): ColumnKey[] {
  try {
    const raw = localStorage.getItem(STORE_PREFIX + view);
    if (!raw) return fallback;
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return fallback;
    // Drop anything unrecognised rather than trusting stored state: a column
    // removed in a later version must not break the pane for whoever saved it.
    const clean = parsed.filter(
      (k): k is ColumnKey => typeof k === "string" && k in COLUMNS,
    );
    if (clean.length === 0) return fallback;
    return clean.includes(REQUIRED_COLUMN) ? clean : [REQUIRED_COLUMN, ...clean];
  } catch {
    return fallback;
  }
}

export function saveColumns(view: string, cols: ColumnKey[]): void {
  try {
    localStorage.setItem(STORE_PREFIX + view, JSON.stringify(cols));
  } catch {
    /* A browser with storage disabled still gets a working pane, just one
       that forgets the choice. Not worth an error in front of the user. */
  }
}
