/**
 * ADUC's multi-select property sheet.
 *
 * Selecting several users and opening Properties in ADUC gives a reduced sheet
 * where every field has a checkbox: only ticked fields are written, and each
 * one is written to every selected object. That is how a department or an
 * office gets stamped across thirty accounts, and it is the shape people
 * already know, so it is the shape here.
 *
 * Two deliberate differences, both because this writes to a real directory:
 *
 *   - Ticking a field and leaving it empty CLEARS that attribute. ADUC does the
 *     same, quietly. Here it is spelled out on the row and counted separately
 *     in the summary, because clearing thirty attributes by accident is not
 *     recoverable - the Recycle Bin restores deleted objects, not overwritten
 *     values.
 *   - Nothing is written until a summary of exactly what will change, on how
 *     many objects, has been shown and confirmed.
 *
 * Account options are not here. They are tri-state across a mixed selection
 * (some on, some off, some indeterminate) and deserve their own pass rather
 * than a checkbox that silently means "no opinion".
 */
import { useEffect, useMemo, useState } from "react";
import { previewTokens, type DirectoryRow } from "../lib/api";
import { ObjectPicker } from "./ObjectPicker";

type BulkTab = "general" | "address" | "organization" | "attributes";

type BulkField = {
  tab: BulkTab;
  /** The LDAP attribute written. */
  attr: string;
  label: string;
  /** DN-valued: browsed for rather than typed. */
  pick?: boolean;
};

/** ADUC's multi-select field set, in ADUC's order. */
const FIELDS: BulkField[] = [
  { tab: "general", attr: "description", label: "Description" },
  { tab: "general", attr: "physicalDeliveryOfficeName", label: "Office" },
  { tab: "general", attr: "telephoneNumber", label: "Telephone number" },
  { tab: "general", attr: "facsimileTelephoneNumber", label: "Fax" },
  { tab: "general", attr: "wWWHomePage", label: "Web page" },

  { tab: "address", attr: "streetAddress", label: "Street" },
  { tab: "address", attr: "postOfficeBox", label: "P.O. Box" },
  { tab: "address", attr: "l", label: "City" },
  { tab: "address", attr: "st", label: "State/province" },
  { tab: "address", attr: "postalCode", label: "Zip/Postal Code" },
  { tab: "address", attr: "co", label: "Country/region" },

  { tab: "organization", attr: "title", label: "Job title" },
  { tab: "organization", attr: "department", label: "Department" },
  { tab: "organization", attr: "company", label: "Company" },
  { tab: "organization", attr: "manager", label: "Manager", pick: true },
];

const TABS: Array<[BulkTab, string]> = [
  ["general", "General"],
  ["address", "Address"],
  ["organization", "Organization"],
  ["attributes", "Attributes"],
];

/** A raw attribute row on the Attributes tab. */
type RawRow = { id: number; attr: string; value: string };

/** An LDAP attribute name: letters, digits and hyphens, starting with a letter. */
const ATTR_NAME = /^[A-Za-z][A-Za-z0-9-]*$/;

const TOKEN = /%([A-Za-z][A-Za-z0-9-]*)%/g;

export function hasTokens(values: Record<string, string>): boolean {
  return Object.values(values).some((v) => {
    TOKEN.lastIndex = 0;
    return TOKEN.test(v);
  });
}

export type BulkPropertyChanges = {
  /** Attributes to write, with their new value. */
  set: Record<string, string>;
  /** Attributes to remove entirely - ticked with an empty value. */
  clear: string[];
  /** Any value contains a %token% that must be resolved per object. */
  expandTokens: boolean;
};

export function BulkPropertiesDialog({
  targets,
  domainKey,
  searchBase,
  onCancel,
  onApply,
}: {
  targets: DirectoryRow[];
  domainKey: string;
  searchBase: string;
  onCancel: () => void;
  onApply: (changes: BulkPropertyChanges) => void;
}) {
  const [tab, setTab] = useState<BulkTab>("general");
  const [ticked, setTicked] = useState<Record<string, boolean>>({});
  const [values, setValues] = useState<Record<string, string>>({});
  const [picking, setPicking] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [rawRows, setRawRows] = useState<RawRow[]>([]);
  const [nextRowId, setNextRowId] = useState(1);
  /* What the tokens actually resolve to for the first selected object. */
  const [preview, setPreview] = useState<
    { state: "off" } | { state: "loading" } | { state: "ok"; values: Record<string, string> } | { state: "error"; message: string }
  >({ state: "off" });

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        if (picking) setPicking(null);
        else if (confirming) setConfirming(false);
        else onCancel();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onCancel, picking, confirming]);

  const changes = useMemo<BulkPropertyChanges>(() => {
    const set: Record<string, string> = {};
    const clear: string[] = [];
    for (const f of FIELDS) {
      if (!ticked[f.attr]) continue;
      const v = (values[f.attr] ?? "").trim();
      if (v) set[f.attr] = v;
      else clear.push(f.attr);
    }
    /* Raw rows last, so a named field and a hand-typed row naming the same
       attribute resolve to the raw one - the more specific intent. */
    for (const r of rawRows) {
      const attr = r.attr.trim();
      if (!ATTR_NAME.test(attr)) continue;
      const v = r.value.trim();
      if (v) {
        set[attr] = v;
        delete clear[clear.indexOf(attr)];
      } else if (!clear.includes(attr)) {
        clear.push(attr);
        delete set[attr];
      }
    }
    return { set, clear: clear.filter(Boolean), expandTokens: hasTokens(set) };
  }, [ticked, values, rawRows]);

  useEffect(() => {
    if (!confirming || !changes.expandTokens) {
      setPreview({ state: "off" });
      return;
    }
    const first = targets[0];
    if (!first) return;
    let live = true;
    setPreview({ state: "loading" });
    void previewTokens(domainKey, first.distinguishedName, changes.set)
      .then((res) => {
        if (!live) return;
        setPreview(
          res.ok
            ? { state: "ok", values: res.values }
            : { state: "error", message: res.error },
        );
      })
      .catch((err) => {
        if (live) {
          setPreview({
            state: "error",
            message: err instanceof Error ? err.message : String(err),
          });
        }
      });
    return () => {
      live = false;
    };
  }, [confirming, changes, domainKey, targets]);

  const setCount = Object.keys(changes.set).length;
  const clearCount = changes.clear.length;
  const nothingToDo = setCount + clearCount === 0;
  const labelFor = (attr: string) => FIELDS.find((f) => f.attr === attr)?.label ?? attr;

  return (
    <div className="modal-scrim" onMouseDown={onCancel}>
      <div
        className="dialog props-dialog"
        role="dialog"
        aria-modal="true"
        aria-label={`Properties for ${targets.length} objects`}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="dialog-title">
          <span>{targets.length} Objects Properties</span>
          <button type="button" className="dialog-close" onClick={onCancel} aria-label="Close">
            &#10005;
          </button>
        </div>

        {confirming ? (
          <div className="dialog-body">
            <p className="bulk-confirm-lead">
              Apply to <strong>{targets.length}</strong> object
              {targets.length === 1 ? "" : "s"}:
            </p>
            <div className="list-frame bulk-preview">
              <table className="sheet-table">
                <tbody>
                  {Object.entries(changes.set).map(([attr, v]) => {
                    const resolved =
                      preview.state === "ok" ? preview.values[attr] : undefined;
                    return (
                      <tr key={attr}>
                        <td>{labelFor(attr)}</td>
                        <td className="mono">
                          {v}
                          {/* A template is not what gets written, so show what
                              does - resolved against the first object, since
                              every object resolves to something different. */}
                          {resolved !== undefined && resolved !== v && (
                            <span className="token-resolved">
                              {" -> "}
                              {resolved}
                            </span>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                  {changes.clear.map((attr) => (
                    <tr key={attr}>
                      <td>{labelFor(attr)}</td>
                      <td className="bulk-clear-cell">will be cleared</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {changes.expandTokens && preview.state === "loading" && (
              <p className="field-help">Resolving tokens...</p>
            )}
            {changes.expandTokens && preview.state === "ok" && (
              <p className="field-help">
                Values shown after the arrow are resolved for{" "}
                <strong>{targets[0]?.name}</strong>. Every object gets its own.
              </p>
            )}
            {preview.state === "error" && (
              <p className="field-help bulk-clear-warning">
                {preview.message} Fix the token before applying, or this object
                will fail.
              </p>
            )}
            {clearCount > 0 && (
              <p className="field-help bulk-clear-warning">
                Clearing cannot be undone. The Recycle Bin restores deleted
                objects, not overwritten values.
              </p>
            )}
          </div>
        ) : (
          <>
            <div className="tabstrip">
              {TABS.map(([id, label]) => (
                <button
                  key={id}
                  type="button"
                  className={tab === id ? "tab is-active" : "tab"}
                  onClick={() => setTab(id)}
                >
                  {label}
                </button>
              ))}
            </div>

            <div className="dialog-body">
              <p className="field-help bulk-props-lead">
                Tick a field to write it to all {targets.length} selected
                objects. Unticked fields are left alone. A ticked field left
                empty clears that attribute.
              </p>
              {tab === "attributes" ? (
                <div className="sheet">
                  <div className="raw-attr-head">
                    <span>Attribute</span>
                    <span>Value</span>
                    <span />
                  </div>
                  {rawRows.map((r) => {
                    const named = r.attr.trim();
                    const bad = named !== "" && !ATTR_NAME.test(named);
                    return (
                      <div className="raw-attr-row" key={r.id}>
                        <input
                          className={bad ? "field-input mono is-invalid" : "field-input mono"}
                          value={r.attr}
                          placeholder="e.g. extensionAttribute1"
                          aria-label="Attribute name"
                          onChange={(e) =>
                            setRawRows((p) =>
                              p.map((x) => (x.id === r.id ? { ...x, attr: e.target.value } : x)),
                            )
                          }
                        />
                        <input
                          className="field-input mono"
                          value={r.value}
                          placeholder="value, or %sAMAccountName% - empty clears"
                          aria-label="Attribute value"
                          onChange={(e) =>
                            setRawRows((p) =>
                              p.map((x) => (x.id === r.id ? { ...x, value: e.target.value } : x)),
                            )
                          }
                        />
                        <button
                          type="button"
                          className="btn"
                          aria-label="Remove row"
                          onClick={() => setRawRows((p) => p.filter((x) => x.id !== r.id))}
                        >
                          &#10005;
                        </button>
                      </div>
                    );
                  })}
                  <button
                    type="button"
                    className="btn"
                    onClick={() => {
                      setRawRows((p) => [...p, { id: nextRowId, attr: "", value: "" }]);
                      setNextRowId((n) => n + 1);
                    }}
                  >
                    Add attribute
                  </button>
                  <p className="field-help raw-attr-help">
                    Any attribute the schema allows, written to all{" "}
                    {targets.length} objects. An empty value clears it.
                  </p>
                  <p className="field-help raw-attr-help">
                    <strong>%attributeName%</strong> is replaced per object with
                    that object&apos;s own value - so{" "}
                    <code>%givenName%.%sn%@example.com</code> gives each user
                    their own. A token that cannot be resolved fails that object
                    rather than writing the literal text or an empty value.
                  </p>
                </div>
              ) : (
              <div className="sheet">
                {FIELDS.filter((f) => f.tab === tab).map((f) => {
                  const on = ticked[f.attr] === true;
                  const v = values[f.attr] ?? "";
                  return (
                    <div className="field-row bulk-field" key={f.attr}>
                      <label className="bulk-tick">
                        <input
                          type="checkbox"
                          checked={on}
                          onChange={(e) =>
                            setTicked((p) => ({ ...p, [f.attr]: e.target.checked }))
                          }
                          aria-label={`Change ${f.label}`}
                        />
                        <span className="field-label">{f.label}</span>
                      </label>
                      <div className="bulk-value">
                        <input
                          className="field-input"
                          value={v}
                          disabled={!on}
                          readOnly={f.pick}
                          placeholder={on ? "(leave empty to clear)" : ""}
                          onChange={(e) =>
                            setValues((p) => ({ ...p, [f.attr]: e.target.value }))
                          }
                        />
                        {f.pick && (
                          <button
                            type="button"
                            className="btn"
                            disabled={!on}
                            onClick={() => setPicking(f.attr)}
                          >
                            Browse...
                          </button>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
              )}
            </div>
          </>
        )}

        <div className="dialog-footer">
          {confirming ? (
            <>
              <button
                type="button"
                className="btn btn-primary"
                disabled={preview.state === "loading" || preview.state === "error"}
                onClick={() => onApply(changes)}
              >
                Apply
              </button>
              <button type="button" className="btn" onClick={() => setConfirming(false)}>
                Back
              </button>
            </>
          ) : (
            <>
              <button
                type="button"
                className="btn btn-primary"
                disabled={nothingToDo}
                title={nothingToDo ? "Tick at least one field" : undefined}
                onClick={() => setConfirming(true)}
              >
                OK
              </button>
              <button type="button" className="btn" onClick={onCancel}>
                Cancel
              </button>
              <span className="bulk-props-count">
                {nothingToDo
                  ? "Nothing ticked"
                  : `${setCount} to set${clearCount ? `, ${clearCount} to clear` : ""}`}
              </span>
            </>
          )}
        </div>

        {picking && (
          <ObjectPicker
            domainKey={domainKey}
            searchBase={searchBase}
            allow={["user"]}
            title={`Select ${labelFor(picking)}`}
            onCancel={() => setPicking(null)}
            onPick={(dns) => {
              const dn = dns[0];
              if (dn) setValues((p) => ({ ...p, [picking]: dn }));
              setPicking(null);
            }}
          />
        )}
      </div>
    </div>
  );
}
