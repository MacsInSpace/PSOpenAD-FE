/**
 * ADUC's Account tab: the lockout row, the account-options checkbox block and
 * the expiry radio pair.
 *
 * These look like separate settings but are one attribute family -
 * userAccountControl bits plus pwdLastSet, lockoutTime and accountExpires - so
 * they are read and written together rather than one call per checkbox.
 *
 * Unlock is a button, not a checkbox, because the operation is one-way: AD
 * gives you no way to lock an account on demand, only to clear a lockout. A
 * checkbox would imply you could tick it back on.
 */
import { useCallback, useEffect, useState } from "react";
import {
  getAccountOptions,
  setAccountOptions,
  type AccountFlags,
  type AccountOptions as Options,
} from "../lib/api";

/** Label and tooltip per flag, in ADUC's own order and wording. */
const FLAG_ROWS: Array<[keyof AccountFlags, string, string]> = [
  [
    "passwordNeverExpires",
    "Password never expires",
    "The password is exempt from the domain's maximum password age.",
  ],
  [
    "passwordNotRequired",
    "Password not required",
    "Lets the account have an empty password. Rarely what you want.",
  ],
  [
    "smartcardRequired",
    "Smart card is required for interactive logon",
    "Also resets the password to a random value the user never sees.",
  ],
  [
    "notDelegated",
    "Account is sensitive and cannot be delegated",
    "Stops the account's credentials being forwarded by a delegated service.",
  ],
  [
    "dontRequirePreauth",
    "Do not require Kerberos preauthentication",
    "Only for interoperability with older Kerberos implementations. Weakens the account against offline attack.",
  ],
  [
    "useDesKeyOnly",
    "Use only Kerberos DES encryption types",
    "Legacy. DES is broken; modern DCs usually refuse it outright.",
  ],
];

export function AccountOptions({
  domainKey,
  identity,
  onChanged,
}: {
  domainKey: string;
  identity: string;
  /** Fires after a successful write, so the caller can refresh the list. */
  onChanged?: () => void;
}) {
  const [opts, setOpts] = useState<Options | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [expiryDraft, setExpiryDraft] = useState<string>("");

  const load = useCallback(async () => {
    setError(null);
    try {
      const o = await getAccountOptions(domainKey, identity);
      setOpts(o);
      setExpiryDraft(o.accountExpires ? o.accountExpires.slice(0, 10) : "");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [domainKey, identity]);

  useEffect(() => {
    void load();
  }, [load]);

  const apply = useCallback(
    async (req: Parameters<typeof setAccountOptions>[0]) => {
      setBusy(true);
      setError(null);
      try {
        await setAccountOptions(req);
        await load();
        onChanged?.();
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setBusy(false);
      }
    },
    [load, onChanged],
  );

  if (error && !opts) return <pre className="error-block">{error}</pre>;
  if (!opts) return <p className="muted">Reading account options...</p>;

  const expiresNever = !opts.accountExpires;

  return (
    <div className="account-options">
      <div className="account-block">
        <div className="account-row">
          <span className="account-state">
            {opts.locked ? (
              <strong className="state-bad">Account is locked out</strong>
            ) : (
              <span className="muted">Account is not locked out</span>
            )}
          </span>
          <button
            type="button"
            className="btn"
            disabled={busy || !opts.locked}
            title={
              opts.locked
                ? "Clear the lockout so the user can sign in again"
                : "Only available while the account is locked. AD has no way to lock an account on demand."
            }
            onClick={() => void apply({ domainKey, identity, unlock: true })}
          >
            Unlock Account
          </button>
        </div>
        {opts.passwordLastSet && (
          <p className="field-hint">
            Password last set {new Date(opts.passwordLastSet).toLocaleString()}
          </p>
        )}
      </div>

      <div className="account-block">
        <div className="account-legend">Account options</div>

        <label className="checkbox-row">
          <input
            type="checkbox"
            checked={opts.mustChangePassword}
            disabled={busy || opts.flags.passwordNeverExpires}
            title={
              opts.flags.passwordNeverExpires
                ? "Cannot be combined with Password never expires - AD rejects it"
                : "Forces a password change at the next sign-in."
            }
            onChange={(e) =>
              void apply({ domainKey, identity, mustChangePassword: e.target.checked })
            }
          />
          <span>User must change password at next logon</span>
        </label>

        {FLAG_ROWS.map(([key, label, hint]) => (
          <label className="checkbox-row" key={key}>
            <input
              type="checkbox"
              checked={opts.flags[key]}
              disabled={
                busy ||
                (key === "passwordNeverExpires" && opts.mustChangePassword)
              }
              title={
                key === "passwordNeverExpires" && opts.mustChangePassword
                  ? "Cannot be combined with must change password at next logon"
                  : hint
              }
              onChange={(e) =>
                void apply({
                  domainKey,
                  identity,
                  flags: { [key]: e.target.checked } as Partial<AccountFlags>,
                })
              }
            />
            <span>{label}</span>
          </label>
        ))}

        <label className="checkbox-row">
          <input
            type="checkbox"
            checked={opts.flags.disabled}
            disabled={busy}
            title="The same setting as the Disable Account verb."
            onChange={(e) =>
              void apply({
                domainKey,
                identity,
                flags: { disabled: e.target.checked },
              })
            }
          />
          <span>Account is disabled</span>
        </label>
      </div>

      <div className="account-block">
        <div className="account-legend">Account expires</div>
        <label className="checkbox-row">
          <input
            type="radio"
            name="expires"
            checked={expiresNever}
            disabled={busy}
            onChange={() => void apply({ domainKey, identity, accountExpires: null })}
          />
          <span>Never</span>
        </label>
        <label className="checkbox-row">
          <input
            type="radio"
            name="expires"
            checked={!expiresNever}
            disabled={busy || !expiryDraft}
            onChange={() =>
              expiryDraft &&
              void apply({
                domainKey,
                identity,
                accountExpires: new Date(`${expiryDraft}T00:00:00Z`).toISOString(),
              })
            }
          />
          <span>End of</span>
          <input
            type="date"
            className="field-input account-date"
            value={expiryDraft}
            disabled={busy}
            onChange={(e) => setExpiryDraft(e.target.value)}
            onBlur={() => {
              if (!expiryDraft) return;
              const iso = new Date(`${expiryDraft}T00:00:00Z`).toISOString();
              if (iso !== opts.accountExpires) {
                void apply({ domainKey, identity, accountExpires: iso });
              }
            }}
          />
        </label>
      </div>

      {error && <pre className="error-block">{error}</pre>}
    </div>
  );
}
