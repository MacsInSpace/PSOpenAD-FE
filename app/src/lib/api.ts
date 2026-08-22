import { invoke as tauriInvoke } from "@tauri-apps/api/core";
import { demoInvoke, isDemo } from "./demo";
export { enableDemo, DEMO_SESSION } from "./demo";

/**
 * Every backend call goes through here. In the Tauri app this is a straight
 * pass-through to the sidecar; run outside Tauri (`vite dev`) there is no
 * backend, so it falls back to the demo forest in ./demo.
 */
function invoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  if (isDemo()) return demoInvoke<T>(cmd, args ?? {});
  return tauriInvoke<T>(cmd, args);
}

export { isDemo };

export type DomainSession = {
  domainKey: string;
  label: string;
  server: string;
  username: string;
  bindUserName?: string;
  connectionStep: string;
  port: number;
  authType: string;
  startTls: boolean;
  useTls: boolean;
  /** True when the browse session can already carry unicodePwd (TLS or Kerberos seal). */
  passwordCapable?: boolean;
  defaultNamingContext: string;
  dnsHostName?: string | null;
  whoami?: string | null;
  attempts?: Array<{ step: string; ok: boolean; error?: string | null }>;
};

export type DirectoryRow = {
  distinguishedName: string;
  name: string;
  objectClass?: string | null;
  samAccountName?: string | null;
  displayName?: string | null;
  description?: string | null;
  userPrincipalName?: string | null;
  mail?: string | null;
  objectGuid?: string | null;
  whenCreated?: string | null;
  whenChanged?: string | null;
  /** Bit field carrying a group's scope and security/distribution kind. */
  groupType?: string | null;
  enabled?: boolean | null;
  /* Only populated for rows from the Deleted Objects container. */
  isDeleted?: boolean | null;
  lastKnownParent?: string | null;
  lastKnownRdn?: string | null;
  isRecycled?: boolean | null;
};

export type ObjectDetail = {
  summary: DirectoryRow;
  attributes: Record<string, string | string[] | null>;
};

export type ConnectRequest = {
  server: string;
  username: string;
  password: string;
  domainKey?: string;
  label?: string;
  ldapPort?: number;
  ldapsPort?: number;
  forceStep?: string;
  /** standard = TLS/Simple ladder; kerberosSeal = sign+seal :389 for unicodePwd */
  channel?: "standard" | "kerberosSeal";
  dcFqdn?: string;
  realm?: string;
};

export type ContentFilter = "all" | "user" | "group" | "computer" | "ou";

export async function sidecarPing() {
  return invoke<Record<string, unknown>>("sidecar_ping");
}

export async function sidecarLadder() {
  return invoke<
    Array<{
      name: string;
      port: number;
      startTls: boolean;
      useTls: boolean;
      authType: string;
      skipCert: boolean;
    }>
  >("sidecar_ladder");
}

export async function connectDomain(request: ConnectRequest) {
  return invoke<DomainSession>("connect_domain", { request });
}

export async function disconnectDomain(domainKey: string) {
  return invoke<void>("disconnect_domain", { domainKey });
}

export async function listSessions() {
  return invoke<DomainSession[]>("list_sessions");
}

export async function getChildren(domainKey: string, searchBase?: string) {
  const raw = await invoke<unknown>("get_children", { domainKey, searchBase });
  return asDirectoryRows(raw);
}

export async function listContents(opts: {
  domainKey: string;
  searchBase?: string;
  filter?: ContentFilter;
  limit?: number;
  /** Raw LDAP filter. Overrides `filter` when set - ADUC's Filter Options. */
  ldapFilter?: string;
}) {
  const raw = await invoke<unknown>("list_contents", opts);
  // The sidecar answers with rows plus whether the cap was hit. An older shape
  // (a bare array) is still accepted so a mismatched pair degrades to "no idea
  // whether it was truncated" rather than to an empty pane.
  if (raw && typeof raw === "object" && !Array.isArray(raw) && "rows" in raw) {
    const page = raw as { rows: unknown; truncated?: boolean; limit?: number };
    return {
      rows: asDirectoryRows(page.rows),
      truncated: page.truncated === true,
      limit: typeof page.limit === "number" ? page.limit : undefined,
    };
  }
  return { rows: asDirectoryRows(raw), truncated: false, limit: undefined };
}

export async function getObject(domainKey: string, identity: string) {
  return invoke<ObjectDetail>("get_object", { domainKey, identity });
}

export async function searchDirectory(opts: {
  domainKey: string;
  kind: "user" | "group" | "computer" | "object";
  query?: string;
  searchBase?: string;
  limit?: number;
}) {
  const raw = await invoke<unknown>("search_directory", opts);
  return asDirectoryRows(raw);
}

export async function getGroupMembers(domainKey: string, identity: string) {
  const raw = await invoke<unknown>("get_group_members", {
    domainKey,
    identity,
  });
  return asDirectoryRows(raw);
}

/**
 * The groups a principal belongs to. Unlike reading `memberOf` this includes
 * the primary group, and with `recursive` it walks nested groups too.
 */
export async function getGroupMembership(
  domainKey: string,
  identity: string,
  recursive = false,
) {
  const raw = await invoke<unknown>("get_group_membership", {
    domainKey,
    identity,
    recursive,
  });
  return asDirectoryRows(raw);
}

export async function getRootDse(domainKey: string) {
  return invoke<Record<string, string | null>>("get_root_dse", { domainKey });
}

export async function probePasswordChannel(request: ConnectRequest) {
  return invoke<{
    channel: string;
    encrypted: boolean;
    port: number;
    auth: string;
    target: string;
    detail: string;
  }>("probe_password_channel", { request });
}

export async function setAccountPassword(
  domainKey: string,
  identity: string,
  password: string,
) {
  return invoke<{ ok: boolean; identity: string; channel?: string }>(
    "set_account_password",
    {
      domainKey,
      identity,
      password,
    },
  );
}

/* -- Write operations ------------------------------------------------------
 * Everything here changes the directory. Only setAccountPassword needs a
 * confidential channel; the rest are ordinary attribute writes over the
 * browse session.
 */

export async function setAccountEnabled(
  domainKey: string,
  identity: string,
  enabled: boolean,
) {
  return invoke<{ ok: boolean; changed: boolean; enabled: boolean }>(
    "set_account_enabled",
    { domainKey, identity, enabled },
  );
}

export async function moveObject(
  domainKey: string,
  identity: string,
  targetPath: string,
) {
  return invoke<{ ok: boolean; distinguishedName: string }>("move_object", {
    domainKey,
    identity,
    targetPath,
  });
}

export async function renameObject(
  domainKey: string,
  identity: string,
  newName: string,
) {
  return invoke<{ ok: boolean; distinguishedName: string }>("rename_object", {
    domainKey,
    identity,
    newName,
  });
}

export async function removeObject(domainKey: string, identity: string) {
  return invoke<{ ok: boolean; identity: string }>("remove_object", {
    domainKey,
    identity,
  });
}

export type NewObjectRequest = {
  domainKey: string;
  path: string;
  name: string;
  /** ADUC's New submenu maps onto these. */
  type: "user" | "group" | "computer" | "organizationalUnit" | "contact";
  description?: string;
  displayName?: string;
  attributes?: Record<string, string>;
};

export async function newObject(request: NewObjectRequest) {
  const raw = await invoke<unknown>("new_object", { request });
  return asDirectoryRows(raw)[0] ?? null;
}

export type FsmoRole = { role: string; holder: string | null; ownerDn: string | null };

/** FSMO role holders. Read-only - moving a role is not a job for this tool. */
export async function getOperationsMasters(domainKey: string) {
  return invoke<FsmoRole[]>("get_operations_masters", { domainKey });
}

export type RecycleBinState = {
  enabled: boolean;
  deletedObjectsDn: string | null;
  namingContext: string | null;
  error: string | null;
};

/**
 * Whether the forest has the AD Recycle Bin on. Without it a deleted object is
 * a tombstone with its attributes already stripped, so there is nothing to
 * restore and the node is not offered at all.
 */
export async function getRecycleBinState(domainKey: string) {
  return invoke<RecycleBinState>("get_recycle_bin_state", { domainKey });
}

/** Contents of the Deleted Objects container. */
export async function listDeletedObjects(
  domainKey: string,
  opts: { searchBase?: string; query?: string; limit?: number } = {},
) {
  const raw = await invoke<unknown>("list_deleted_objects", {
    domainKey,
    searchBase: opts.searchBase,
    query: opts.query,
    limit: opts.limit,
  });
  return asDirectoryRows(raw);
}

/** Restore one deleted object, optionally to a different place or name. */
export async function restoreObject(
  domainKey: string,
  identity: string,
  opts: { targetPath?: string; newName?: string } = {},
) {
  return invoke<DirectoryRow>("restore_object", {
    domainKey,
    identity,
    targetPath: opts.targetPath,
    newName: opts.newName,
  });
}

export type PwshStatus = { found: boolean; path: string | null; version: string | null };

/** Is PowerShell 7 installed? The one dependency the app cannot bundle. */
export async function getPwshStatus() {
  return invoke<PwshStatus>("pwsh_status");
}

/** Group managed service accounts (gMSA). */
export async function getServiceAccounts(domainKey: string, searchBase?: string) {
  const raw = await invoke<unknown>("get_service_accounts", { domainKey, searchBase });
  return asDirectoryRows(raw);
}

/**
 * ADUC's Reset Account. Sets a computer's password back to the machine default
 * so it can rejoin without being removed from the domain first.
 */
export async function resetComputerAccount(domainKey: string, identity: string) {
  return invoke<{ identity: string; reset: boolean }>("reset_computer_account", {
    domainKey,
    identity,
  });
}

/**
 * ADUC's Copy. Creates a user from a template in the template's own container,
 * carrying its group memberships and the attributes that describe a role
 * rather than a person. The copy is created disabled with no password, as any
 * new account is.
 */
export async function copyObject(request: {
  domainKey: string;
  source: string;
  name: string;
  sAMAccountName: string;
  path?: string;
  namingContext?: string;
}) {
  return invoke<{
    created: DirectoryRow;
    groupsCopied: number;
    groupsFailed: string[];
  }>("copy_object", { request });
}

export type TokenPreview =
  | { ok: true; values: Record<string, string> }
  | { ok: false; error: string };

/**
 * Resolve %token% values against one object. Used to show what a bulk write
 * will actually produce before it is applied; a preview that succeeds means
 * the write will not fail on an unresolvable token.
 */
export async function previewTokens(
  domainKey: string,
  identity: string,
  values: Record<string, string>,
) {
  return invoke<TokenPreview>("preview_tokens", { domainKey, identity, values });
}

export async function setAttributes(request: {
  domainKey: string;
  identity: string;
  set?: Record<string, string>;
  /** Expand %attributeName% in the values being set, per object. */
  expandTokens?: boolean;
  clear?: string[];
  /** Multi-valued: append these values, leaving existing ones alone. */
  add?: Record<string, string[]>;
  /** Multi-valued: remove exactly these values. */
  remove?: Record<string, string[]>;
}) {
  return invoke<{ ok: boolean }>("set_attributes", { request });
}

export async function addGroupMember(
  domainKey: string,
  group: string,
  members: string[],
) {
  return invoke<{ ok: boolean }>("add_group_member", { domainKey, group, members });
}

export async function removeGroupMember(
  domainKey: string,
  group: string,
  members: string[],
) {
  return invoke<{ ok: boolean }>("remove_group_member", {
    domainKey,
    group,
    members,
  });
}

/** Sidecar diagnostics, newest last - every ladder rung it tried, and why. */
export async function getSidecarLog() {
  return invoke<string[]>("get_sidecar_log");
}

/**
 * Diagnostic verbosity, applied to the running sidecar without a restart.
 * `verbose` surfaces PSOpenAD's own narration of each LDAP operation;
 * `includePwsh` adds PowerShell's debug/information/warning streams too, which
 * is genuinely noisy.
 */
/** The userAccountControl checkbox block on ADUC's Account tab. */
export type AccountFlags = {
  disabled: boolean;
  homeDirRequired: boolean;
  passwordNotRequired: boolean;
  passwordNeverExpires: boolean;
  smartcardRequired: boolean;
  trustedForDelegation: boolean;
  notDelegated: boolean;
  useDesKeyOnly: boolean;
  dontRequirePreauth: boolean;
};

export type AccountOptions = {
  identity: string;
  userAccountControl: number;
  flags: AccountFlags;
  /** Computed by the DC. lockoutTime alone stays set after a lockout expires. */
  locked: boolean;
  mustChangePassword: boolean;
  passwordLastSet: string | null;
  /** ISO-8601, or null for "never". */
  accountExpires: string | null;
};

export async function getAccountOptions(domainKey: string, identity: string) {
  return invoke<AccountOptions>("get_account_options", { domainKey, identity });
}

export async function setAccountOptions(request: {
  domainKey: string;
  identity: string;
  flags?: Partial<AccountFlags>;
  unlock?: boolean;
  mustChangePassword?: boolean;
  /** ISO-8601 to set an expiry, null to clear it. Omit to leave alone. */
  accountExpires?: string | null;
}) {
  return invoke<{ changed: boolean; applied?: string[] }>("set_account_options", {
    request,
  });
}

/**
 * ADUC's "Protect object from accidental deletion". Not an attribute: a Deny
 * ACE for Everyone on the object's own DACL, denying Delete, DeleteTree and
 * DeleteChild. Reading it costs an extra ACL fetch, so it is its own call
 * rather than part of getObject.
 */
export async function getProtection(domainKey: string, identity: string) {
  return invoke<{ identity: string; protected: boolean }>("get_protection", {
    domainKey,
    identity,
  });
}

export async function setProtection(
  domainKey: string,
  identity: string,
  protectedFromDeletion: boolean,
) {
  return invoke<{ protected: boolean; changed: boolean }>("set_protection", {
    domainKey,
    identity,
    protected: protectedFromDeletion,
  });
}

export async function getLogOptions() {
  return invoke<{ verbose: boolean; includePwsh: boolean }>("get_log_options");
}

export async function setLogOptions(verbose: boolean, includePwsh: boolean) {
  return invoke<{ verbose: boolean; includePwsh: boolean }>("set_log_options", {
    verbose,
    includePwsh,
  });
}

export async function clearSidecarLog() {
  return invoke<void>("clear_sidecar_log");
}

export type SavedConnection = {
  id: string;
  label: string;
  domainKey: string;
  server: string;
  username: string;
  channel?: string | null;
  forceStep?: string | null;
  dcFqdn?: string | null;
  realm?: string | null;
  savedAt?: string | null;
  /** A vault reference exists. Whether it still resolves is the sidecar's business. */
  hasPassword: boolean;
  /** A legacy keychain item is still waiting to be migrated. */
  needsMigration?: boolean;
  secretRef?: string | null;
};

export async function listSavedConnections() {
  return invoke<SavedConnection[]>("list_saved_connections");
}

export async function saveConnection(request: {
  id?: string;
  label: string;
  domainKey: string;
  server: string;
  username: string;
  password: string;
  channel?: string;
  forceStep?: string;
  dcFqdn?: string;
  realm?: string;
}) {
  return invoke<SavedConnection>("save_connection", { request });
}

export async function deleteSavedConnection(id: string) {
  return invoke<void>("delete_saved_connection", { id });
}

/**
 * Move any password still held in the OS keychain into the shared vault,
 * deleting the keychain item as it goes. Runs once at startup for one release;
 * after that there is nothing left to migrate and the keyring crate is removed.
 */
export async function migrateSavedConnectionSecrets() {
  return invoke<{ migrated: number; failed: string[] }>(
    "migrate_saved_connection_secrets",
  );
}

export async function connectSavedConnection(id: string) {
  return invoke<DomainSession>("connect_saved_connection", { id });
}

export function objectKind(
  row: Pick<DirectoryRow, "objectClass">,
): "user" | "group" | "computer" | "ou" | "container" | "other" {
  const c = String(row?.objectClass ?? "").toLowerCase();
  if (c.includes("computer")) return "computer";
  if (c.includes("group")) return "group";
  if (c.includes("user") || c.includes("person")) return "user";
  if (c.includes("organizationalunit")) return "ou";
  if (c.includes("container") || c.includes("builtin") || c.includes("domain"))
    return "container";
  return "other";
}

/** Normalize sidecar list payloads (guards against nested/single-object JSON). */
export function asDirectoryRows(value: unknown): DirectoryRow[] {
  if (value == null) return [];
  const flat: unknown[] = [];
  const push = (item: unknown) => {
    if (item == null) return;
    if (Array.isArray(item)) {
      for (const inner of item) push(inner);
      return;
    }
    if (typeof item === "object" && item !== null && "distinguishedName" in item) {
      flat.push(item);
    }
  };
  push(value);
  return flat.map(normalizeDirectoryRow);
}

function normalizeDirectoryRow(raw: unknown): DirectoryRow {
  const r = (raw ?? {}) as Record<string, unknown>;
  const str = (v: unknown): string | null => {
    if (v == null) return null;
    if (typeof v === "string") return v;
    if (typeof v === "number" || typeof v === "boolean") return String(v);
    if (Array.isArray(v)) {
      const parts = v.map((x) => str(x)).filter((x): x is string => Boolean(x));
      return parts.length ? parts[parts.length - 1]! : null;
    }
    return String(v);
  };
  return {
    distinguishedName: str(r.distinguishedName) ?? "",
    name: str(r.name) ?? str(r.displayName) ?? "",
    objectClass: str(r.objectClass),
    samAccountName: str(r.samAccountName),
    displayName: str(r.displayName),
    description: str(r.description),
    userPrincipalName: str(r.userPrincipalName),
    mail: str(r.mail),
    objectGuid: str(r.objectGuid),
    whenCreated: str(r.whenCreated),
    whenChanged: str(r.whenChanged),
    groupType: str(r.groupType),
    enabled: typeof r.enabled === "boolean" ? r.enabled : null,
  };
}
