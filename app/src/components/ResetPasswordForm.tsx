import { useState, type FormEvent } from "react";
import { setAccountPassword } from "../lib/api";

type Props = {
  domainKey: string;
  identity: string;
  accountLabel: string;
  /** Browse session already confidential (TLS / seal); otherwise setPassword opens Kerberos seal. */
  passwordCapable?: boolean;
};

export function ResetPasswordForm({
  domainKey,
  identity,
  accountLabel,
  passwordCapable,
}: Props) {
  const [open, setOpen] = useState(false);
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [okMsg, setOkMsg] = useState<string | null>(null);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setOkMsg(null);
    if (password !== confirm) {
      setError("Passwords do not match.");
      return;
    }
    if (!password) {
      setError("Password is required.");
      return;
    }
    setBusy(true);
    try {
      const res = await setAccountPassword(domainKey, identity, password);
      const via = res.channel ? ` via ${res.channel}` : "";
      setOkMsg(`Password updated for ${accountLabel}${via}.`);
      setPassword("");
      setConfirm("");
      setOpen(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  if (!open) {
    return (
      <div className="reset-pw-block">
        {okMsg && <p className="ok-msg">{okMsg}</p>}
        <button type="button" className="btn-secondary" onClick={() => setOpen(true)}>
          Reset password...
        </button>
        {!passwordCapable && (
          <p className="field-hint">
            Browse session is not confidential - reset will open a Kerberos
            sign+seal channel on :389 (kinit / kgetcred /
            TargetSpnHost).
          </p>
        )}
      </div>
    );
  }

  return (
    <form className="reset-pw-form" onSubmit={onSubmit}>
      <h3>Reset password</h3>
      <p className="field-hint">
        Sets <code>unicodePwd</code> for <strong>{accountLabel}</strong>.
        {!passwordCapable
          ? " Uses Kerberos sign+seal on plain :389 when LDAPS/StartTLS are unavailable."
          : " Uses the existing confidential session."}
      </p>
      <label>
        New password
        <input
          type="password"
          autoComplete="new-password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          required
          autoFocus
        />
      </label>
      <label>
        Confirm
        <input
          type="password"
          autoComplete="new-password"
          value={confirm}
          onChange={(e) => setConfirm(e.target.value)}
          required
        />
      </label>
      {error && <pre className="error-block">{error}</pre>}
      <div className="reset-pw-actions">
        <button type="submit" className="btn-primary" disabled={busy}>
          {busy ? "Setting..." : "Set password"}
        </button>
        <button
          type="button"
          className="btn-secondary"
          disabled={busy}
          onClick={() => {
            setOpen(false);
            setError(null);
            setPassword("");
            setConfirm("");
          }}
        >
          Cancel
        </button>
      </div>
    </form>
  );
}
