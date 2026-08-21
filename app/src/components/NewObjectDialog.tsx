/**
 * ADUC's New > User / Group / Computer / Organizational Unit wizard, collapsed
 * to one page.
 *
 * ADUC spreads a new user over three wizard pages; there is no reason to here
 * when the whole thing is six fields. What is kept is the important part: the
 * container you are creating in is stated up front and cannot be got wrong,
 * because in ADUC the commonest new-object mistake is creating it in the wrong
 * OU.
 *
 * A new account is created disabled and without a password - the directory
 * refuses an enabled account with no password, and setting one needs the
 * confidential channel. Reset Password... then Enable Account is the same two
 * steps an admin already knows.
 */
import { useEffect, useRef, useState } from "react";
import { newObject, type DirectoryRow, type NewObjectRequest } from "../lib/api";

export type NewKind = NewObjectRequest["type"];

const FIELDS: Record<NewKind, { label: string; sam: boolean; upn: boolean }> = {
  user: { label: "User", sam: true, upn: true },
  group: { label: "Group", sam: true, upn: false },
  computer: { label: "Computer", sam: true, upn: false },
  organizationalUnit: { label: "Organizational Unit", sam: false, upn: false },
  contact: { label: "Contact", sam: false, upn: false },
};

export function NewObjectDialog({
  domainKey,
  path,
  type,
  realm,
  onClose,
  onCreated,
}: {
  domainKey: string;
  path: string;
  type: NewKind;
  realm: string;
  onClose: () => void;
  onCreated: (row: DirectoryRow | null) => void;
}) {
  const spec = FIELDS[type];
  const [name, setName] = useState("");
  const [sam, setSam] = useState("");
  const [description, setDescription] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const nameRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    nameRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  // Computers conventionally carry the trailing $ on sAMAccountName.
  const effectiveSam =
    sam.trim() || (type === "computer" ? `${name.trim()}$` : name.trim());

  async function submit() {
    setBusy(true);
    setError(null);
    try {
      const attributes: Record<string, string> = {};
      if (spec.sam && effectiveSam) attributes.sAMAccountName = effectiveSam;
      if (spec.upn && effectiveSam && realm) {
        attributes.userPrincipalName = `${effectiveSam}@${realm}`;
      }
      const row = await newObject({
        domainKey,
        path,
        name: name.trim(),
        type,
        description: description.trim() || undefined,
        attributes: Object.keys(attributes).length ? attributes : undefined,
      });
      onCreated(row);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setBusy(false);
    }
  }

  return (
    <div className="modal-scrim" onMouseDown={busy ? undefined : onClose}>
      <form
        className="dialog new-dialog"
        role="dialog"
        aria-modal="true"
        aria-label={`New ${spec.label}`}
        onMouseDown={(e) => e.stopPropagation()}
        onSubmit={(e) => {
          e.preventDefault();
          if (name.trim() && !busy) void submit();
        }}
      >
        <div className="dialog-title">
          <span>New Object - {spec.label}</span>
          <button
            type="button"
            className="dialog-close"
            onClick={onClose}
            disabled={busy}
            aria-label="Close"
          >
            &#10005;
          </button>
        </div>

        <div className="dialog-body">
          <div className="field-row">
            <label className="field-label">Create in</label>
            <input className="field-input mono" value={path} readOnly />
          </div>

          <div className="field-row">
            <label className="field-label" htmlFor="new-name">
              Name
            </label>
            <input
              id="new-name"
              ref={nameRef}
              className="field-input"
              value={name}
              disabled={busy}
              onChange={(e) => setName(e.target.value)}
            />
          </div>

          {spec.sam && (
            <div className="field-row">
              <label className="field-label" htmlFor="new-sam">
                {type === "computer" ? "Computer name (pre-Windows 2000)" : "Logon name"}
              </label>
              <input
                id="new-sam"
                className="field-input mono"
                value={sam}
                placeholder={effectiveSam || "defaults to the name"}
                disabled={busy}
                onChange={(e) => setSam(e.target.value)}
              />
            </div>
          )}

          {spec.upn && effectiveSam && realm && (
            <div className="field-row">
              <label className="field-label">User logon name</label>
              <input
                className="field-input mono"
                value={`${effectiveSam}@${realm}`}
                readOnly
              />
            </div>
          )}

          <div className="field-row">
            <label className="field-label" htmlFor="new-desc">
              Description
            </label>
            <input
              id="new-desc"
              className="field-input"
              value={description}
              disabled={busy}
              onChange={(e) => setDescription(e.target.value)}
            />
          </div>

          {type === "user" && (
            <p className="dialog-note">
              Created disabled and without a password - the directory will not
              accept an enabled account that has none. Use Reset Password..., then
              Enable Account.
            </p>
          )}

          {error && <pre className="error-block">{error}</pre>}
        </div>

        <div className="dialog-footer">
          <button type="submit" className="btn btn-primary" disabled={busy || !name.trim()}>
            {busy ? "Creating..." : "OK"}
          </button>
          <button type="button" className="btn" onClick={onClose} disabled={busy}>
            Cancel
          </button>
        </div>
      </form>
    </div>
  );
}
