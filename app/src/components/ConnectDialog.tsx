import { useEffect, useState, type FormEvent } from "react";
import {
  connectDomain,
  connectSavedConnection,
  migrateSavedConnectionSecrets,
  deleteSavedConnection,
  listSavedConnections,
  saveConnection,
  type DomainSession,
  type SavedConnection,
  enableDemo,
  DEMO_SESSION,
} from "../lib/api";

/** Least -> most secure; first success wins. 636/3269 are LDAPS-only. */
const LADDER_STEPS = [
  "LDAP:389 Simple",
  "StartTLS:389 Simple",
  "LDAP:3268 GC Simple",
  "StartTLS:3268 GC Simple",
  "LDAPS:636 Simple",
  "LDAPS:3269 GC Simple",
] as const;

const CONTEXT_KEY_TIP =
  "Internal label for this connection tab - not sent to AD. Identifies the session in the app (multi-domain tabs, disconnect, later password ops). Leave blank to default to the server hostname/IP. Use a short unique id when connecting to more than one forest/DC (e.g. prod, lab).";

type Props = {
  onConnected: (session: DomainSession) => void;
  existingKeys: string[];
  compact?: boolean;
};

export function ConnectDialog({ onConnected, compact }: Props) {
  const [server, setServer] = useState("");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [label, setLabel] = useState("");
  const [domainKey, setDomainKey] = useState("");
  const [forceStep, setForceStep] = useState("");
  const [channel, setChannel] = useState<"standard" | "kerberosSeal">(
    "standard",
  );
  const [remember, setRemember] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [attempts, setAttempts] = useState<
    Array<{ step: string; ok: boolean; error?: string | null }>
  >([]);
  const [saved, setSaved] = useState<SavedConnection[]>([]);

  async function refreshSaved() {
    try {
      setSaved(await listSavedConnections());
    } catch {
      setSaved([]);
    }
  }

  useEffect(() => {
    /* One-release migration: anything still in the OS keychain moves into the
       vault and the keychain item is deleted. Silent on success - there is
       nothing the operator needs to do - but a failure must not hide, because
       it means a saved password is now unreachable. */
    void (async () => {
      try {
        const res = await migrateSavedConnectionSecrets();
        if (res.failed.length > 0) {
          setError(
            `Could not move ${res.failed.length} saved password(s) into the secret vault: ${res.failed.join("; ")}`,
          );
        }
      } catch (err) {
        /* Do not block sign-in, but do not hide it either: a failure here
           means a saved password is still in the keychain and will prompt
           again next launch. */
        console.warn("secret migration failed", err);
      }
      void refreshSaved();
    })();
  }, []);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    setAttempts([]);
    try {
      const key = domainKey.trim() || server.trim();
      const session = await connectDomain({
        server: server.trim(),
        username: username.trim(),
        password,
        domainKey: key,
        label: label.trim() || key,
        forceStep: forceStep || undefined,
        channel,
      });
      if (session.attempts) setAttempts(session.attempts);
      if (remember) {
        try {
          await saveConnection({
            id: key,
            label: label.trim() || key,
            domainKey: key,
            server: server.trim(),
            username: username.trim(),
            password,
            channel,
            forceStep: forceStep || undefined,
          });
          await refreshSaved();
        } catch (saveErr) {
          // Connected OK - surface save failure without blocking the session.
          setError(
            `Connected, but could not save credentials: ${
              saveErr instanceof Error ? saveErr.message : String(saveErr)
            }`,
          );
        }
      }
      onConnected(session);
      setPassword("");
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setError(msg);
    } finally {
      setBusy(false);
    }
  }

  async function onConnectSaved(id: string) {
    setBusy(true);
    setError(null);
    setAttempts([]);
    try {
      const session = await connectSavedConnection(id);
      if (session.attempts) setAttempts(session.attempts);
      onConnected(session);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function onDeleteSaved(id: string) {
    try {
      await deleteSavedConnection(id);
      await refreshSaved();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  function fillFromSaved(c: SavedConnection) {
    setServer(c.server);
    setUsername(c.username);
    setLabel(c.label);
    setDomainKey(c.domainKey);
    setChannel(
      c.channel === "kerberosSeal" ? "kerberosSeal" : "standard",
    );
    setForceStep(c.forceStep ?? "");
    setPassword("");
    setRemember(true);
  }

  return (
    <form
      className={compact ? "connect-form compact" : "connect-form"}
      onSubmit={onSubmit}
    >
      {!compact && (
        <header className="connect-header">
          <p className="brand">PSOpenAD</p>
          <h1>Active Directory</h1>
        </header>
      )}
      {compact && <h2 className="connect-compact-title">Add domain</h2>}

      {saved.length > 0 && (
        <div className="saved-connections">
          <div className="saved-heading">Saved connections</div>
          <ul className="saved-list">
            {saved.map((c) => (
              <li key={c.id}>
                <button
                  type="button"
                  className="saved-connect"
                  disabled={busy || !c.hasPassword}
                  title={
                    c.hasPassword
                      ? `${c.username} @ ${c.server}`
                      : "Password missing from keychain - fill the form and reconnect with Remember checked"
                  }
                  onClick={() => void onConnectSaved(c.id)}
                >
                  <span className="saved-label">{c.label}</span>
                  <span className="saved-meta">
                    {c.username} - {c.server}
                    {!c.hasPassword ? " - no password" : ""}
                  </span>
                </button>
                <button
                  type="button"
                  className="saved-edit"
                  title="Load into form"
                  disabled={busy}
                  onClick={() => fillFromSaved(c)}
                >
                  Edit
                </button>
                <button
                  type="button"
                  className="saved-delete"
                  title="Remove saved connection"
                  disabled={busy}
                  onClick={() => void onDeleteSaved(c.id)}
                >
                  &#10005;
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}

      <label>
        Domain controller (IP or hostname)
        <input
          required
          autoFocus={saved.length === 0}
          placeholder="dc01.example.com or 192.0.2.5"
          value={server}
          onChange={(e) => setServer(e.target.value)}
        />
      </label>

      <div className="row-2">
        <label>
          Username
          <input
            required
            placeholder="DOMAIN\user or user@realm"
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            autoComplete="username"
          />
        </label>
        <label>
          Password
          <input
            required
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete="current-password"
          />
        </label>
      </div>

      <div className="row-2">
        <label>
          Display name
          <input
            placeholder="Contoso"
            value={label}
            onChange={(e) => setLabel(e.target.value)}
          />
        </label>
        <label title={CONTEXT_KEY_TIP}>
          <span className="label-with-tip">
            Context key
            <abbr
              className="field-tip"
              title={CONTEXT_KEY_TIP}
              aria-label={CONTEXT_KEY_TIP}
            >
              ?
            </abbr>
          </span>
          <input
            placeholder="unique id for this forest"
            value={domainKey}
            onChange={(e) => setDomainKey(e.target.value)}
            title={CONTEXT_KEY_TIP}
          />
        </label>
      </div>

      <label>
        Bind channel
        <select
          value={channel}
          onChange={(e) =>
            setChannel(e.target.value as "standard" | "kerberosSeal")
          }
        >
          <option value="standard">
            Standard (389 &gt; TLS &gt; LDAPS) - directory browse
          </option>
          <option value="kerberosSeal">
            Kerberos sign+seal :389 - keep sealed session (password-ready)
          </option>
        </select>
      </label>

      <label>
        Connection method
        <select
          value={forceStep}
          onChange={(e) => setForceStep(e.target.value)}
          disabled={channel !== "standard"}
        >
          <option value="">Automatic ladder (recommended)</option>
          {LADDER_STEPS.map((name) => (
            <option key={name} value={name}>
              {name}
            </option>
          ))}
        </select>
      </label>

      <label className="remember-row">
        <input
          type="checkbox"
          checked={remember}
          onChange={(e) => setRemember(e.target.checked)}
        />
        <span>
          Remember this connection (password stored in OS keychain)
        </span>
      </label>

      {error && <pre className="error-block">{error}</pre>}
      {attempts.length > 0 && (
        <ul className="attempt-list">
          {attempts.map((a) => (
            <li key={a.step} className={a.ok ? "ok" : "fail"}>
              {a.ok ? "OK" : "FAIL"} {a.step}
              {!a.ok && a.error ? ` - ${a.error}` : ""}
            </li>
          ))}
        </ul>
      )}

      <button type="submit" disabled={busy}>
        {busy ? "Starting PowerShell / binding..." : "Connect"}
      </button>

      {/* Somebody who has just downloaded this has no reason to point it at a
          live directory to find out what it is. The demo forest is invented,
          answers locally, and touches no network at all. */}
      <div className="try-demo">
        <button
          type="button"
          className="btn-link"
          disabled={busy}
          onClick={() => {
            enableDemo();
            onConnected(DEMO_SESSION);
          }}
        >
          Explore with sample data instead
        </button>
        <span className="field-help">
          A small fictional directory, entirely local. Nothing is contacted and
          nothing can be changed.
        </span>
      </div>
    </form>
  );
}
