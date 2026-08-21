/**
 * ADUC's vocabulary, in one place.
 *
 * The style guide is explicit: use ADUC's exact verb names - "Reset Password..."
 * not "Change credentials", "Disable Account" not "Deactivate". Familiarity is
 * the feature and creativity in labelling is a defect. Keeping the strings here
 * means the Action menu, the right-click menu and the object list cannot drift
 * apart, and there is one obvious file to check a wording against.
 */

/** Object-class names exactly as ADUC's Type column prints them. */
export function kindLabel(kind: string): string {
  switch (kind) {
    case "user":
      return "User";
    case "group":
      return "Group";
    case "computer":
      return "Computer";
    case "ou":
      return "Organizational Unit";
    case "container":
      return "Container";
    default:
      return "Object";
  }
}

/**
 * ADUC's Type column for a group spells out scope and kind, e.g.
 * "Security Group - Global". That needs groupType, a bit field:
 *
 *   0x00000002  Global      0x80000000  Security (absent means Distribution)
 *   0x00000004  Domain local
 *   0x00000008  Universal
 *
 * groupType is a signed 32-bit value on the wire, so the security bit arrives
 * as a negative number. Test it with a mask, never with `> 0`.
 */
export function groupLabel(groupType: number | string | null | undefined): string {
  if (groupType === null || groupType === undefined || groupType === "") return "Group";

  const raw = String(groupType);

  // PSOpenAD decodes groupType into its flag names on read - "Global,
  // IsSecurity" - exactly as it does for userAccountControl. Only the raw
  // integer form needs bit maths, and assuming a number here silently yields
  // NaN and a wrong label.
  if (!/^-?\d+$/.test(raw)) {
    const flags = raw.toLowerCase();
    const scope = flags.includes("universal")
      ? "Universal"
      : flags.includes("domainlocal") || flags.includes("domain local")
        ? "Domain local"
        : flags.includes("global")
          ? "Global"
          : null;
    const kind = flags.includes("issecurity") || flags.includes("security")
      ? "Security Group"
      : "Distribution Group";
    return scope ? `${kind} - ${scope}` : kind;
  }

  const n = Number(raw);
  if (!Number.isFinite(n)) return "Group";
  const scope =
    n & 0x8 ? "Universal" : n & 0x4 ? "Domain local" : n & 0x2 ? "Global" : null;
  // Signed 32-bit on the wire, so the security bit arrives negative. Mask it.
  const kind = (n & 0x80000000) !== 0 ? "Security Group" : "Distribution Group";
  return scope ? `${kind} - ${scope}` : kind;
}

/** Verb labels. Every menu pulls from here - never a literal at the call site. */
export const VERB = {
  open: "Open",
  delegateControl: "Delegate Control...",
  find: "Find...",
  newUser: "User",
  newGroup: "Group",
  newComputer: "Computer",
  newOu: "Organizational Unit",
  newContact: "Contact",
  addToGroup: "Add to a group...",
  disableAccount: "Disable Account",
  enableAccount: "Enable Account",
  resetPassword: "Reset Password...",
  move: "Move...",
  rename: "Rename",
  delete: "Delete",
  refresh: "Refresh",
  restore: "Restore",
  restoreTo: "Restore To...",
  exportList: "Export List...",
  properties: "Properties",
  help: "Help",
  copyDn: "Copy Distinguished Name",
} as const;
