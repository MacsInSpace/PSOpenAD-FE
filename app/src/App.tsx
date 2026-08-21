import { useEffect, useMemo, useState } from "react";
import { ConnectDialog } from "./components/ConnectDialog";
import { DirectoryBrowser } from "./components/DirectoryBrowser";
import { PowerShellRequired } from "./components/PowerShellRequired";
import { disconnectDomain, isDemo, type DomainSession, getPwshStatus } from "./lib/api";
import "./App.css";

/** 3268/3269 are the Global Catalog ports: partial attribute set, read-only. */
function isGlobalCatalog(port: number) {
  return port === 3268 || port === 3269;
}

/**
 * Application shell: a 32px title bar carrying the product mark and one tab
 * per connected domain, then the console itself.
 *
 * Multiple domains are tabs rather than separate windows because that is the
 * one place this app has to differ from ADUC - ADUC scopes a console to a
 * forest, and an admin here may hold sessions against several.
 */
function App() {
  const [sessions, setSessions] = useState<DomainSession[]>([]);
  const [activeKey, setActiveKey] = useState<string | null>(null);
  const [showConnect, setShowConnect] = useState(true);
  /* null = not asked yet; the dialog only shows on a definite "not found". */
  const [pwshMissing, setPwshMissing] = useState<boolean | null>(null);

  const checkPwsh = () => {
    void getPwshStatus()
      .then((st) => setPwshMissing(!st.found))
      .catch(() => setPwshMissing(null));
  };
  useEffect(checkPwsh, []);

  const active = useMemo(
    () => sessions.find((s) => s.domainKey === activeKey) ?? null,
    [sessions, activeKey],
  );

  function onConnected(session: DomainSession) {
    setSessions((prev) => [
      ...prev.filter((s) => s.domainKey !== session.domainKey),
      session,
    ]);
    setActiveKey(session.domainKey);
    setShowConnect(false);
  }

  async function onDisconnect(key: string) {
    try {
      await disconnectDomain(key);
    } catch {
      /* the session is going away either way */
    }
    setSessions((prev) => {
      const next = prev.filter((s) => s.domainKey !== key);
      setActiveKey((cur) => (cur === key ? (next[0]?.domainKey ?? null) : cur));
      if (next.length === 0) setShowConnect(true);
      return next;
    });
  }

  const onConsole = Boolean(active) && !showConnect;

  return (
    <div className={`shell${onConsole ? " is-console" : " is-connect"}`}>
      {pwshMissing === true && <PowerShellRequired onRecheck={checkPwsh} />}
      <header className="titlebar">
        <span className="brand-mark" aria-hidden />
        <span className="brand">PSOpenAD-FE</span>

        {sessions.length > 0 && (
          <div className="domain-tabs" role="tablist" aria-label="Connected domains">
            {sessions.map((s) => {
              const current = s.domainKey === activeKey && !showConnect;
              return (
                <button
                  key={s.domainKey}
                  type="button"
                  role="tab"
                  aria-selected={current}
                  className={current ? "domain-tab is-active" : "domain-tab"}
                  title={`${s.server} - ${s.connectionStep}`}
                  onClick={() => {
                    setActiveKey(s.domainKey);
                    setShowConnect(false);
                  }}
                >
                  <span
                    className={`dot-status ${s.passwordCapable ? "dot-ok" : "dot-pending"}`}
                    aria-hidden
                  />
                  {s.label}
                </button>
              );
            })}
            <button
              type="button"
              className="domain-tab is-add"
              title="Connect another domain"
              onClick={() => setShowConnect(true)}
            >
              +
            </button>
          </div>
        )}

        <div className="titlebar-right">
          {isDemo() && (
            <span
              className="badge badge-warn"
              title="No Tauri backend detected, so the console is showing a built-in sample forest. Nothing here is a real directory."
            >
              DEMO DATA
            </span>
          )}
          {active && !showConnect && (
            <>
              {isGlobalCatalog(active.port) && (
                /* The ladder can land on the GC, and the GC answers with a
                   partial attribute set - an admin would otherwise see an
                   object missing PwdLastSet, AccountExpires, BadPwdCount and
                   the rest with no clue why. Actionable, so it gets colour. */
                <span
                  className="badge badge-warn"
                  title={
                    "Connected to the Global Catalog. It holds a partial copy of every object, " +
                    "so some attributes (PwdLastSet, AccountExpires, BadPwdCount, BadPasswordTime, " +
                    "CodePage, CountryCode, IsCriticalSystemObject) are simply absent, and it is " +
                    "read-only. Reconnect on :389 or :636 for the full, writable view - pick a " +
                    "Connection method other than the GC rungs, or fix whatever is blocking :389."
                  }
                >
                  GC - PARTIAL
                </span>
              )}
              <span className="badge badge-dim" title={`Bound on port ${active.port}`}>
                {active.authType}
                {active.startTls ? " - StartTLS" : ""}
                {active.useTls ? " - LDAPS" : ""} - :{active.port}
              </span>
              <button
                type="button"
                className="linkish"
                onClick={() => void onDisconnect(active.domainKey)}
              >
                Disconnect
              </button>
            </>
          )}
        </div>
      </header>

      <main className="main">
        {onConsole && active ? (
          <DirectoryBrowser key={active.domainKey} session={active} />
        ) : (
          <div className="connect-stage">
            <ConnectDialog
              onConnected={onConnected}
              existingKeys={sessions.map((s) => s.domainKey)}
              compact={sessions.length > 0}
            />
            {sessions.length > 0 && (
              <button
                type="button"
                className="btn"
                onClick={() => setShowConnect(false)}
              >
                Back to console
              </button>
            )}
          </div>
        )}
      </main>
    </div>
  );
}

export default App;
