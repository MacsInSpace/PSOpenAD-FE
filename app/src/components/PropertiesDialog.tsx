/**
 * The ADUC property sheet.
 *
 * In ADUC, double-clicking an object - or picking Properties - opens a modal
 * tabbed dialog with OK / Cancel / Apply along the bottom. That dialog *is*
 * how AD admins read and edit an object, so the app uses the same shape rather
 * than a docked inspector pane: the contract in the style guide (section 1) is
 * "double-click row -> Properties", and a side pane that is already showing the
 * selection makes double-click a no-op.
 *
 * Tabs mirror ADUC's, in ADUC's order, and only appear for classes that have
 * them (Account/Member Of for users, Members for groups).
 *
 * Editing is not wired to the sidecar yet - it exposes no write method beyond
 * setPassword - so fields render read-only and Apply is disabled. The sheet
 * still shows exactly what the object is, which is most of what Properties is
 * used for.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import {
  addGroupMember,
  getGroupMembers,
  getGroupMembership,
  getProtection,
  removeGroupMember,
  setAttributes,
  setProtection,
  getObject,
  objectKind,
  type DirectoryRow,
  type ObjectDetail,
} from "../lib/api";
import { AccountOptions } from "./AccountOptions";
import { ObjectIcon } from "./ObjectIcon";
import { ObjectPicker, type PickKind } from "./ObjectPicker";
import { ResetPasswordForm } from "./ResetPasswordForm";
import { kindLabel } from "../lib/adTerms";

/**
 * Attributes the directory maintains itself. AD rejects a write to these, so
 * offering a text box would only produce a confusing server error. Membership
 * is excluded because it has its own tabs, which do it properly.
 */
const SYSTEM_ATTRS = new Set([
  "distinguishedName", "objectClass", "objectCategory", "objectGuid", "objectSid",
  "whenCreated", "whenChanged", "uSNCreated", "uSNChanged", "instanceType",
  "cn", "name", "sAMAccountType", "primaryGroupID", "memberOf", "member",
  "dSCorePropagationData", "lastLogon", "lastLogoff", "lastLogonTimestamp",
  "logonCount", "badPwdCount", "badPasswordTime", "pwdLastSet", "lockoutTime",
  "userAccountControl", "nTSecurityDescriptor", "canonicalName", "DomainController",
]);

type Tab =
  | "general"
  | "address"
  | "account"
  | "telephones"
  | "organization"
  | "memberOf"
  | "members"
  | "managedBy"
  | "object"
  | "attributes";

export function PropertiesDialog({
  domainKey,
  row,
  passwordCapable,
  initialTab = "general",
  onClose,
  onNavigate,
}: {
  domainKey: string;
  row: DirectoryRow;
  passwordCapable?: boolean;
  initialTab?: Tab;
  onClose: () => void;
  onNavigate?: (dn: string) => void;
}) {
  const kind = objectKind(row);
  const isUser = kind === "user";
  const isGroup = kind === "group";

  const [tab, setTab] = useState<Tab>(initialTab);
  const [detail, setDetail] = useState<ObjectDetail | null>(null);
  const [members, setMembers] = useState<DirectoryRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const dialogRef = useRef<HTMLDivElement>(null);

  /* Membership editing. `picking` says which list the picker is feeding. */
  const [picking, setPicking] = useState<
    null | "members" | "memberOf" | "manager" | "managedBy"
  >(null);
  const [pickBusy, setPickBusy] = useState(false);
  const [pickError, setPickError] = useState<string | null>(null);
  const [memberOfDns, setMemberOfDns] = useState<string[] | null>(null);
  /* memberOf is direct-only and omits the primary group, so the tab asks the
     directory the real question instead of reading the attribute. */
  const [memberOfRows, setMemberOfRows] = useState<DirectoryRow[] | null>(null);
  const [recursive, setRecursive] = useState(false);

  /* Reading protection costs an extra ACL fetch, so only do it on demand. */
  /* Pending edits, keyed by LDAP attribute. Empty string means clear it. */
  const [edits, setEdits] = useState<Record<string, string>>({});
  /* Multi-valued edits are deltas, not replacements: sending a whole list back
     would clobber anything added elsewhere since the sheet opened. */
  const [multiAdd, setMultiAdd] = useState<Record<string, string[]>>({});
  const [multiRemove, setMultiRemove] = useState<Record<string, string[]>>({});
  const [applying, setApplying] = useState(false);
  const [applyError, setApplyError] = useState<string | null>(null);

  const [protectedFlag, setProtectedFlag] = useState<boolean | null>(null);
  const [protectBusy, setProtectBusy] = useState(false);
  const [protectError, setProtectError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setBusy(true);
    setError(null);
    void (async () => {
      try {
        const d = await getObject(domainKey, row.distinguishedName);
        if (!cancelled) setDetail(d);
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      } finally {
        if (!cancelled) setBusy(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [domainKey, row.distinguishedName]);

  useEffect(() => {
    if (!isGroup || tab !== "members" || members !== null) return;
    let cancelled = false;
    void (async () => {
      try {
        const m = await getGroupMembers(domainKey, row.distinguishedName);
        if (!cancelled) setMembers(m);
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [domainKey, row.distinguishedName, isGroup, tab, members]);

  // Escape closes, as it does in every MMC dialog.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
      }
    };
    window.addEventListener("keydown", onKey);
    dialogRef.current?.focus();
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const onEdit = useCallback((attr: string, value: string) => {
    setEdits((prev) => ({ ...prev, [attr]: value }));
    setApplyError(null);
  }, []);

  const reloadMemberOf = useCallback(async () => {
    const d = await getObject(domainKey, row.distinguishedName);
    setMemberOfDns(toList(d.attributes.memberOf));
    try {
      setMemberOfRows(
        await getGroupMembership(domainKey, row.distinguishedName, recursive),
      );
    } catch {
      /* Fall back to the memberOf attribute; direct-only beats nothing. */
      setMemberOfRows(null);
    }
  }, [domainKey, row.distinguishedName, recursive]);

  useEffect(() => {
    if (tab !== "memberOf") return;
    void reloadMemberOf();
  }, [tab, recursive, reloadMemberOf]);

  const reloadMembers = useCallback(async () => {
    setMembers(await getGroupMembers(domainKey, row.distinguishedName));
  }, [domainKey, row.distinguishedName]);

  /* Members adds them to THIS group; Member Of adds THIS object to each
     group picked. Same cmdlet either way, arguments swapped. */
  const applyPick = useCallback(
    async (dns: string[]) => {
      setPickBusy(true);
      setPickError(null);
      try {
        if (picking === "manager" || picking === "managedBy") {
          // A single DN, staged like any other field edit so Apply and Cancel
          // behave the same way here as everywhere else on the sheet.
          onEdit(picking, dns[0] ?? "");
          setPicking(null);
          return;
        }
        if (picking === "members") {
          await addGroupMember(domainKey, row.distinguishedName, dns);
          await reloadMembers();
        } else {
          for (const group of dns) {
            await addGroupMember(domainKey, group, [row.distinguishedName]);
          }
          await reloadMemberOf();
        }
        setPicking(null);
      } catch (err) {
        setPickError(err instanceof Error ? err.message : String(err));
      } finally {
        setPickBusy(false);
      }
    },
    [picking, domainKey, row.distinguishedName, reloadMembers, reloadMemberOf, onEdit],
  );

  const dropMember = useCallback(
    async (memberDn: string) => {
      setPickError(null);
      try {
        await removeGroupMember(domainKey, row.distinguishedName, [memberDn]);
        await reloadMembers();
      } catch (err) {
        setPickError(err instanceof Error ? err.message : String(err));
      }
    },
    [domainKey, row.distinguishedName, reloadMembers],
  );

  const leaveGroup = useCallback(
    async (groupDn: string) => {
      setPickError(null);
      try {
        await removeGroupMember(domainKey, groupDn, [row.distinguishedName]);
        await reloadMemberOf();
      } catch (err) {
        setPickError(err instanceof Error ? err.message : String(err));
      }
    },
    [domainKey, row.distinguishedName, reloadMemberOf],
  );

  useEffect(() => {
    if (tab !== "object" || protectedFlag !== null) return;
    let cancelled = false;
    void (async () => {
      try {
        const p = await getProtection(domainKey, row.distinguishedName);
        if (!cancelled) setProtectedFlag(Boolean(p.protected));
      } catch (err) {
        if (!cancelled) setProtectError(err instanceof Error ? err.message : String(err));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [tab, protectedFlag, domainKey, row.distinguishedName]);

  const toggleProtection = useCallback(
    async (next: boolean) => {
      setProtectBusy(true);
      setProtectError(null);
      try {
        const res = await setProtection(domainKey, row.distinguishedName, next);
        setProtectedFlag(Boolean(res.protected));
      } catch (err) {
        setProtectError(err instanceof Error ? err.message : String(err));
      } finally {
        setProtectBusy(false);
      }
    },
    [domainKey, row.distinguishedName],
  );

  /**
   * Write the pending edits. Returns true on success so OK can decide whether
   * to close - ADUC keeps the sheet open when Apply fails, and so do we,
   * because closing would throw away what the operator typed.
   */
  const applyEdits = useCallback(async (): Promise<boolean> => {
    const changed = Object.entries(edits);
    const adds = Object.fromEntries(
      Object.entries(multiAdd).filter(([, l]) => l.length > 0),
    );
    const removes = Object.fromEntries(
      Object.entries(multiRemove).filter(([, l]) => l.length > 0),
    );
    if (
      changed.length === 0 &&
      Object.keys(adds).length === 0 &&
      Object.keys(removes).length === 0
    ) {
      return true;
    }

    setApplying(true);
    setApplyError(null);
    try {
      const set: Record<string, string> = {};
      for (const [k, v] of changed) set[k] = v;
      await setAttributes({
        domainKey,
        identity: row.distinguishedName,
        ...(changed.length ? { set } : {}),
        ...(Object.keys(adds).length ? { add: adds } : {}),
        ...(Object.keys(removes).length ? { remove: removes } : {}),
      });
      const fresh = await getObject(domainKey, row.distinguishedName);
      setDetail(fresh);
      setEdits({});
      setMultiAdd({});
      setMultiRemove({});
      return true;
    } catch (err) {
      setApplyError(err instanceof Error ? err.message : String(err));
      return false;
    } finally {
      setApplying(false);
    }
  }, [edits, multiAdd, multiRemove, domainKey, row.distinguishedName]);

  const stageMulti = useCallback(
    (attr: string, op: "add" | "remove", value: string) => {
      const setter = op === "add" ? setMultiAdd : setMultiRemove;
      setter((prev) => {
        const list = prev[attr] ?? [];
        return {
          ...prev,
          [attr]: list.includes(value)
            ? list.filter((v) => v !== value)
            : [...list, value],
        };
      });
      setApplyError(null);
    },
    [],
  );

  const dirtyCount =
    Object.keys(edits).length +
    Object.values(multiAdd).reduce((n, l) => n + l.length, 0) +
    Object.values(multiRemove).reduce((n, l) => n + l.length, 0);

  const attrs = detail?.attributes ?? {};
  const memberOf = memberOfDns ?? toList(attrs.memberOf);

  const isPrincipal = isUser || kind === "computer" || isGroup;

  const tabs: Array<[Tab, string]> = [
    ["general", "General"],
    ...(isUser ? ([["address", "Address"]] as Array<[Tab, string]>) : []),
    ...(isUser ? ([["account", "Account"]] as Array<[Tab, string]>) : []),
    ...(isUser
      ? ([
          ["telephones", "Telephones"],
          ["organization", "Organization"],
        ] as Array<[Tab, string]>)
      : []),
    ...(isGroup ? ([["members", "Members"]] as Array<[Tab, string]>) : []),
    /* Groups nest, so a group has a Member Of tab as well - ADUC shows one. */
    ...(isUser || isGroup || kind === "computer"
      ? ([["memberOf", "Member Of"]] as Array<[Tab, string]>)
      : []),
    ...(isPrincipal || kind === "ou"
      ? ([["managedBy", "Managed By"]] as Array<[Tab, string]>)
      : []),
    ["object", "Object"],
    ["attributes", "Attribute Editor"],
  ];

  const title = row.displayName || row.name;

  return (
    <div className="modal-scrim" onMouseDown={onClose}>
      <div
        className="dialog props-dialog"
        role="dialog"
        aria-modal="true"
        aria-label={`${title} Properties`}
        tabIndex={-1}
        ref={dialogRef}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="dialog-title">
          <ObjectIcon row={row} size={14} />
          <span>{title} Properties</span>
          <button type="button" className="dialog-close" onClick={onClose} aria-label="Close">
            &#10005;
          </button>
        </div>

        <div className="tabstrip" role="tablist">
          {tabs.map(([id, label]) => (
            <button
              key={id}
              type="button"
              role="tab"
              aria-selected={tab === id}
              className={tab === id ? "tab is-active" : "tab"}
              onClick={() => setTab(id)}
            >
              {label}
            </button>
          ))}
        </div>

        <div className="dialog-body">
          {error && <pre className="error-block">{error}</pre>}
          {pickError && <pre className="error-block">{pickError}</pre>}

          {tab === "general" && (
            <div className="sheet">
              <div className="sheet-ident">
                <ObjectIcon row={row} size={32} />
                <div>
                  <div className="sheet-ident-name">{title}</div>
                  <div className="sheet-ident-kind">{kindLabel(kind)}</div>
                </div>
              </div>
              <Field label="Name" value={row.name} readOnlyReason="Use Rename to change the object's name" />
              <Field label="Display name" value={row.displayName} attr="displayName" edits={edits} onEdit={onEdit} />
              <Field label="Description" value={row.description} attr="description" edits={edits} onEdit={onEdit} />
              {isUser && <Field label="E-mail" value={row.mail} mono attr="mail" edits={edits} onEdit={onEdit} />}
              {typeof attrs.title === "string" && <Field label="Job title" value={asText(attrs.title)} attr="title" edits={edits} onEdit={onEdit} />}
              {typeof attrs.department === "string" && (
                <Field label="Department" value={asText(attrs.department)} attr="department" edits={edits} onEdit={onEdit} />
              )}
              {kind === "computer" && (
                <>
                  <Field label="DNS name" value={asText(attrs.dNSHostName)} mono />
                  <Field label="Operating system" value={asText(attrs.operatingSystem)} />
                </>
              )}
              <Field label="Distinguished name" value={row.distinguishedName} mono readOnlyReason="Use Move or Rename to change where the object lives" />
              <Field label="Created" value={fmtDate(attrs.whenCreated ?? row.whenCreated)} mono />
              <Field label="Modified" value={fmtDate(attrs.whenChanged ?? row.whenChanged)} mono />
            </div>
          )}

          {tab === "account" && isUser && (
            <div className="sheet">
              <Field label="User logon name" value={row.userPrincipalName} mono attr="userPrincipalName" edits={edits} onEdit={onEdit} />
              <Field label="Pre-Windows 2000 logon name" value={row.samAccountName} mono attr="sAMAccountName" edits={edits} onEdit={onEdit} />
              <AccountOptions
                domainKey={domainKey}
                identity={row.distinguishedName}
              />
              <div className="sheet-actions">
                <ResetPasswordForm
                  domainKey={domainKey}
                  identity={row.distinguishedName}
                  accountLabel={row.samAccountName || title}
                  passwordCapable={passwordCapable}
                />
              </div>
            </div>
          )}

          {tab === "memberOf" && (
            <MembershipList
              caption="Member of"
              rows={
                memberOfRows ??
                memberOf.map((dn) => ({
                  distinguishedName: dn,
                  name: rdnOf(dn),
                  objectClass: "group",
                }))
              }
              busy={busy}
              extra={
                <label className="checkbox-row" title="Walk nested groups: show groups this object belongs to through another group, not just directly.">
                  <input
                    type="checkbox"
                    checked={recursive}
                    onChange={(e) => setRecursive(e.target.checked)}
                  />
                  <span>Include nested groups</span>
                </label>
              }
              emptyText="This object is not a member of any group."
              onAdd={() => setPicking("memberOf")}
              onRemove={(dn) => void leaveGroup(dn)}
              removeTitle="Remove this object from that group"
              onNavigate={onNavigate}
              onClose={onClose}
            />
          )}

          {tab === "members" && (
            <MembershipList
              caption="Members"
              rows={members ?? []}
              busy={members === null}
              emptyText="This group has no members."
              onAdd={() => setPicking("members")}
              onRemove={(dn) => void dropMember(dn)}
              removeTitle="Remove from this group"
              onNavigate={onNavigate}
              onClose={onClose}
            />
          )}

          {tab === "address" && (
            <div className="sheet">
              <Field label="Street" value={asText(attrs.streetAddress)} attr="streetAddress" edits={edits} onEdit={onEdit} />
              <Field label="P.O. Box" value={asText(attrs.postOfficeBox)} attr="postOfficeBox" edits={edits} onEdit={onEdit} />
              <Field label="City" value={asText(attrs.l)} attr="l" edits={edits} onEdit={onEdit} />
              <Field label="State/province" value={asText(attrs.st)} attr="st" edits={edits} onEdit={onEdit} />
              <Field label="Zip/Postal Code" value={asText(attrs.postalCode)} attr="postalCode" edits={edits} onEdit={onEdit} />
              <Field label="Country/region" value={asText(attrs.co)} attr="co" edits={edits} onEdit={onEdit} />
            </div>
          )}

          {tab === "telephones" && (
            <div className="sheet">
              <Field label="Home" value={asText(attrs.homePhone)} attr="homePhone" edits={edits} onEdit={onEdit} />
              <Field label="Pager" value={asText(attrs.pager)} attr="pager" edits={edits} onEdit={onEdit} />
              <Field label="Mobile" value={asText(attrs.mobile)} attr="mobile" edits={edits} onEdit={onEdit} />
              <Field label="Fax" value={asText(attrs.facsimileTelephoneNumber)} attr="facsimileTelephoneNumber" edits={edits} onEdit={onEdit} />
              <Field label="IP phone" value={asText(attrs.ipPhone)} attr="ipPhone" edits={edits} onEdit={onEdit} />
              <Field label="Notes" value={asText(attrs.info)} attr="info" edits={edits} onEdit={onEdit} />
            </div>
          )}

          {tab === "organization" && (
            <div className="sheet">
              <Field label="Job title" value={asText(attrs.title)} attr="title" edits={edits} onEdit={onEdit} />
              <Field label="Department" value={asText(attrs.department)} attr="department" edits={edits} onEdit={onEdit} />
              <Field label="Company" value={asText(attrs.company)} attr="company" edits={edits} onEdit={onEdit} />
              <Field label="Employee ID" value={asText(attrs.employeeID)} attr="employeeID" edits={edits} onEdit={onEdit} />
              <DnField
                label="Manager"
                dn={asText(attrs.manager)}
                onBrowse={() => setPicking("manager")}
                onClear={() => onEdit("manager", "")}
                pending={edits.manager}
              />
            </div>
          )}

          {tab === "managedBy" && (
            <div className="sheet">
              <DnField
                label="Managed by"
                dn={asText(attrs.managedBy)}
                onBrowse={() => setPicking("managedBy")}
                onClear={() => onEdit("managedBy", "")}
                pending={edits.managedBy}
              />
              <p className="field-hint">
                A record of who owns this object. Purely informational - it
                grants no rights on its own.
              </p>
            </div>
          )}

          {tab === "object" && (
            <div className="sheet">
              <Field label="Canonical name of object" value={canonicalOf(row.distinguishedName)} mono />
              <Field label="Object class" value={row.objectClass} />
              <Field label="Created" value={fmtDate(attrs.whenCreated ?? row.whenCreated)} mono />
              <Field label="Modified" value={fmtDate(attrs.whenChanged ?? row.whenChanged)} mono />
              <Field label="Update Sequence Number (USN) - current" value={asText(attrs.uSNChanged)} mono />
              <Field label="Update Sequence Number (USN) - original" value={asText(attrs.uSNCreated)} mono />

              <div className="sheet-actions">
                <label className="checkbox-row">
                  <input
                    type="checkbox"
                    checked={protectedFlag === true}
                    disabled={protectedFlag === null || protectBusy}
                    onChange={(e) => void toggleProtection(e.target.checked)}
                  />
                  <span>
                    Protect object from accidental deletion
                    {protectedFlag === null && !protectError ? " (reading...)" : ""}
                    {protectBusy ? " (applying...)" : ""}
                  </span>
                </label>
                <p className="field-hint">
                  Denies Everyone the Delete, Delete Subtree and Delete Child
                  rights on this object. It is an entry on the object's own
                  security descriptor, not an attribute, so it will not appear
                  in the Attribute Editor.
                </p>
                {protectError && <pre className="error-block">{protectError}</pre>}
              </div>
            </div>
          )}

          {tab === "attributes" && (
            <div className="list-frame">
              <table className="sheet-table attr-table">
                <thead>
                  <tr>
                    <th>Attribute</th>
                    <th>Value</th>
                  </tr>
                </thead>
                <tbody>
                  {Object.entries(attrs)
                    .sort(([a], [b]) => a.localeCompare(b))
                    .map(([k, v]) => {
                      const multi = Array.isArray(v) && v.length > 1;
                      const writable = !multi && !SYSTEM_ATTRS.has(k);
                      const multiEditable = multi && !SYSTEM_ATTRS.has(k);
                      const current =
                        v == null
                          ? ""
                          : Array.isArray(v)
                            ? v.join("; ")
                            : String(v);
                      const dirty = k in edits;
                      return (
                        <tr key={k}>
                          <td className="mono">{k}</td>
                          <td>
                            {writable ? (
                              <input
                                className={`attr-input mono${dirty ? " is-dirty" : ""}`}
                                value={dirty ? edits[k]! : current}
                                placeholder="<not set>"
                                title={
                                  dirty
                                    ? "Changed, not yet applied"
                                    : "Editable - clear the box to remove the attribute"
                                }
                                onChange={(e) => onEdit(k, e.target.value)}
                              />
                            ) : multiEditable ? (
                              <MultiValueEditor
                                values={(v as string[]) ?? []}
                                onAdd={(value) => stageMulti(k, "add", value)}
                                onRemove={(value) => stageMulti(k, "remove", value)}
                                pendingAdd={multiAdd[k] ?? []}
                                pendingRemove={multiRemove[k] ?? []}
                              />
                            ) : (
                              <span
                                className="mono attr-readonly"
                                title={
                                  multi
                                    ? "Multi-valued and maintained by the directory - use the tab that owns it (Members, Member Of)"
                                    : "The directory maintains this value"
                                }
                              >
                                {current || <span className="not-set">&lt;not set&gt;</span>}
                              </span>
                            )}
                          </td>
                        </tr>
                      );
                    })}
                  {busy && (
                    <tr>
                      <td colSpan={2} className="empty">
                        Loading...
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          )}
        </div>

        {picking && (
          <ObjectPicker
            domainKey={domainKey}
            searchBase={domainRoot(row.distinguishedName)}
            allow={
              (picking === "members"
                ? ["object", "user", "group", "computer"]
                : picking === "memberOf"
                  ? ["group"]
                  : ["object", "user", "group"]) as PickKind[]
            }
            title={
              picking === "members"
                ? `Select members to add to ${title}`
                : picking === "memberOf"
                  ? `Select groups for ${title}`
                  : picking === "manager"
                    ? "Select a manager"
                    : "Select who manages this object"
            }
            exclude={
              picking === "members"
                ? (members ?? []).map((m) => m.distinguishedName)
                : picking === "memberOf"
                  ? memberOf
                  : []
            }
            busy={pickBusy}
            error={pickError}
            onCancel={() => {
              setPicking(null);
              setPickError(null);
            }}
            onPick={(dns) => void applyPick(dns)}
          />
        )}

        <div className="dialog-footer">
          {applyError && <pre className="error-block footer-error">{applyError}</pre>}
          {dirtyCount > 0 && !applyError && (
            <span className="footer-note">
              {dirtyCount} unapplied change{dirtyCount === 1 ? "" : "s"}
            </span>
          )}
          <button
            type="button"
            className="btn btn-primary"
            disabled={applying}
            onClick={() => {
              /* OK applies then closes, but only closes if the write worked -
                 otherwise the operator loses what they typed. */
              void applyEdits().then((ok) => {
                if (ok) onClose();
              });
            }}
          >
            {applying ? "Applying..." : "OK"}
          </button>
          <button type="button" className="btn" onClick={onClose} disabled={applying}>
            Cancel
          </button>
          <button
            type="button"
            className="btn"
            disabled={applying || dirtyCount === 0}
            onClick={() => void applyEdits()}
          >
            Apply
          </button>
        </div>
      </div>
    </div>
  );
}

/**
 * The list body shared by Members and Member Of. ADUC gives both tabs the same
 * shape - a list, an Add... and a Remove - and the only difference here is
 * which side of the relationship the buttons act on.
 *
 * Remove asks for a second click rather than throwing a modal: it is reversible
 * (you can add them straight back) and a modal per row would be intolerable
 * when trimming a group.
 */
function MembershipList({
  caption,
  rows,
  busy,
  emptyText,
  onAdd,
  onRemove,
  removeTitle,
  onNavigate,
  onClose,
  extra,
}: {
  caption: string;
  rows: DirectoryRow[];
  busy: boolean;
  emptyText: string;
  onAdd: () => void;
  onRemove: (dn: string) => void;
  removeTitle: string;
  onNavigate?: (dn: string) => void;
  onClose: () => void;
  extra?: React.ReactNode;
}) {
  const [confirmDn, setConfirmDn] = useState<string | null>(null);

  return (
    <div className="membership">
      <div className="list-frame">
        <table className="sheet-table">
          <thead>
            <tr>
              <th>{caption}</th>
              <th>Active Directory Domain Services Folder</th>
              <th className="col-actions" />
            </tr>
          </thead>
          <tbody>
            {rows.map((m) => (
              <tr key={m.distinguishedName}>
                <td>
                  <span className="name-cell">
                    <ObjectIcon row={m} />
                    <button
                      type="button"
                      className="linkish"
                      onClick={() => {
                        onNavigate?.(m.distinguishedName);
                        onClose();
                      }}
                    >
                      {m.displayName || m.name}
                    </button>
                  </span>
                </td>
                <td className="mono">{parentOf(m.distinguishedName)}</td>
                <td className="col-actions">
                  {confirmDn === m.distinguishedName ? (
                    <span className="row-confirm">
                      <button
                        type="button"
                        className="linkish is-danger"
                        onClick={() => {
                          setConfirmDn(null);
                          onRemove(m.distinguishedName);
                        }}
                      >
                        Remove
                      </button>
                      <button
                        type="button"
                        className="linkish"
                        onClick={() => setConfirmDn(null)}
                      >
                        Cancel
                      </button>
                    </span>
                  ) : (
                    <button
                      type="button"
                      className="row-remove"
                      title={removeTitle}
                      aria-label={removeTitle}
                      onClick={() => setConfirmDn(m.distinguishedName)}
                    >
                      &#10005;
                    </button>
                  )}
                </td>
              </tr>
            ))}

            {rows.length === 0 && (
              <tr className="no-hover">
                <td colSpan={3} className="empty">
                  {busy ? "Loading..." : emptyText}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      <div className="membership-actions">
        <button type="button" className="btn" onClick={onAdd}>
          Add...
        </button>
        {extra}
      </div>
    </div>
  );
}

/**
 * One row of the property sheet.
 *
 * Pass `attr` to make it editable - it is the LDAP attribute the value is
 * written back to. Without it the field is read-only, which is correct for
 * anything the directory owns (created/modified, USNs) or that has its own
 * verb (the DN is Move and Rename, not a text box).
 *
 * A field cleared to empty is a request to remove the attribute, which is what
 * ADUC's blank box means too.
 */
/**
 * A multi-valued attribute. Values are staged as add/remove deltas rather than
 * edited as one joined string: sending a whole new list back would silently
 * discard anything added by another admin since the sheet was opened, and a
 * semicolon-joined text box makes that trivially easy to do by accident.
 */
function MultiValueEditor({
  values,
  pendingAdd,
  pendingRemove,
  onAdd,
  onRemove,
}: {
  values: string[];
  pendingAdd: string[];
  pendingRemove: string[];
  onAdd: (value: string) => void;
  onRemove: (value: string) => void;
}) {
  const [draft, setDraft] = useState("");
  return (
    <div className="multi-value">
      <ul className="multi-list">
        {values.map((v) => {
          const going = pendingRemove.includes(v);
          return (
            <li key={v} className={going ? "is-removing" : undefined}>
              <span className="mono">{v}</span>
              <button
                type="button"
                className="linkish"
                title={going ? "Keep this value after all" : "Remove this value"}
                onClick={() => onRemove(v)}
              >
                {going ? "undo" : "remove"}
              </button>
            </li>
          );
        })}
        {pendingAdd.map((v) => (
          <li key={`add-${v}`} className="is-adding">
            <span className="mono">{v}</span>
            <button type="button" className="linkish" onClick={() => onAdd(v)}>
              undo
            </button>
          </li>
        ))}
        {values.length === 0 && pendingAdd.length === 0 && (
          <li className="not-set">&lt;not set&gt;</li>
        )}
      </ul>
      <div className="multi-add">
        <input
          className="field-input mono"
          value={draft}
          placeholder="Add a value"
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && draft.trim()) {
              e.preventDefault();
              onAdd(draft.trim());
              setDraft("");
            }
          }}
        />
        <button
          type="button"
          className="btn"
          disabled={!draft.trim()}
          onClick={() => {
            onAdd(draft.trim());
            setDraft("");
          }}
        >
          Add
        </button>
      </div>
    </div>
  );
}

/**
 * A DN-valued attribute (manager, managedBy). Shown as a readable name with a
 * Browse button rather than a text box - nobody should be typing a DN, and a
 * mistyped one is accepted by the schema and then means nothing.
 */
function DnField({
  label,
  dn,
  pending,
  onBrowse,
  onClear,
}: {
  label: string;
  dn: string | null;
  pending?: string;
  onBrowse: () => void;
  onClear: () => void;
}) {
  const effective = pending !== undefined ? pending : (dn ?? "");
  const dirty = pending !== undefined;
  return (
    <div className="field-row">
      <label className="field-label">{label}</label>
      <div className="dn-field">
        <input
          className={`field-input mono${dirty ? " is-dirty" : ""}`}
          value={effective ? rdnOf(effective) : ""}
          placeholder="<not set>"
          title={effective || "Not set"}
          readOnly
        />
        <button type="button" className="btn" onClick={onBrowse}>
          Browse...
        </button>
        <button type="button" className="btn" disabled={!effective} onClick={onClear}>
          Clear
        </button>
      </div>
    </div>
  );
}

function Field({
  label,
  value,
  mono,
  attr,
  edits,
  onEdit,
  readOnlyReason,
}: {
  label: string;
  value?: string | null;
  mono?: boolean;
  attr?: string;
  edits?: Record<string, string>;
  onEdit?: (attr: string, value: string) => void;
  readOnlyReason?: string;
}) {
  const editable = Boolean(attr && onEdit);
  const dirty = Boolean(attr && edits && attr in edits);
  const shown = dirty ? edits![attr!]! : (value ?? "");

  return (
    <div className="field-row">
      <label className="field-label">{label}</label>
      <input
        className={[
          "field-input",
          mono ? "mono" : "",
          dirty ? "is-dirty" : "",
        ]
          .filter(Boolean)
          .join(" ")}
        value={shown}
        readOnly={!editable}
        title={
          editable
            ? `${attr}${dirty ? " (changed, not yet applied)" : ""}`
            : (readOnlyReason ?? "Read-only - the directory maintains this value")
        }
        onChange={(e) => attr && onEdit?.(attr, e.target.value)}
      />
    </div>
  );
}

function toList(v: string | string[] | null | undefined): string[] {
  if (!v) return [];
  return Array.isArray(v) ? v : [v];
}

function asText(v: string | string[] | null | undefined): string | null {
  if (v == null) return null;
  return Array.isArray(v) ? v.join("; ") : v;
}

/** The naming context a DN sits in, so the picker searches the whole domain. */
function domainRoot(dn: string) {
  return dn
    .split(",")
    .filter((p) => /^DC=/i.test(p.trim()))
    .join(",");
}

/** ADUC's canonical name: domain/OU/OU/CN rather than a reversed DN. */
function canonicalOf(dn: string) {
  const parts = dn.split(",");
  const dcs = parts.filter((p) => /^DC=/i.test(p.trim())).map((p) => p.trim().slice(3));
  const rest = parts
    .filter((p) => !/^DC=/i.test(p.trim()))
    .map((p) => p.trim().replace(/^[^=]+=/, ""))
    .reverse();
  return [dcs.join("."), ...rest].filter(Boolean).join("/");
}

function rdnOf(dn: string) {
  return dn.split(",")[0]?.replace(/^[^=]+=/, "") || dn;
}

function parentOf(dn: string) {
  const rest = dn.split(",").slice(1);
  const dcs = rest.filter((p) => /^DC=/i.test(p.trim())).map((p) => p.trim().slice(3));
  const path = rest.filter((p) => !/^DC=/i.test(p.trim())).map((p) => p.trim().replace(/^[^=]+=/, ""));
  return [dcs.join("."), ...path.reverse()].filter(Boolean).join("/");
}

function fmtDate(v: string | string[] | null | undefined) {
  const s = asText(v);
  if (!s) return null;
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? s : d.toLocaleString();
}
