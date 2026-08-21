/**
 * Sidecar log viewer - View > Sidecar Log.
 *
 * The sidecar narrates every rung of the connection ladder on stderr, which is
 * the single most useful thing to read when a connect misbehaves: which ports
 * were tried, in what order, how long each waited, and what the DC said. In a
 * packaged build there is no terminal to read it in, so the app retains the
 * lines and shows them here.
 *
 * Follow mode polls rather than streaming - the volume is a few lines per
 * connect, so a 1s poll costs nothing and avoids an event channel for what is
 * a diagnostic pane.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import {
  clearSidecarLog,
  getLogOptions,
  getSidecarLog,
  setLogOptions,
} from "../lib/api";

export function LogDialog({ onClose }: { onClose: () => void }) {
  const [lines, setLines] = useState<string[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [follow, setFollow] = useState(true);
  const [filter, setFilter] = useState("");
  const [verbose, setVerbose] = useState(false);
  const [includePwsh, setIncludePwsh] = useState(false);
  const [optsError, setOptsError] = useState<string | null>(null);
  const bodyRef = useRef<HTMLPreElement>(null);

  const refresh = useCallback(async () => {
    try {
      setLines(await getSidecarLog());
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  /* The toggles live in the sidecar, not here. Read them on open so reopening
     the viewer shows what is actually set rather than this component's
     defaults - otherwise verbose looks as though it did not stick. */
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const o = await getLogOptions();
        if (cancelled) return;
        setVerbose(Boolean(o.verbose));
        setIncludePwsh(Boolean(o.includePwsh));
      } catch {
        /* leave the defaults; the toggles still work */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!follow) return;
    const t = setInterval(() => void refresh(), 1000);
    return () => clearInterval(t);
  }, [follow, refresh]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  // Pin to the newest line while following, the way a tail does.
  useEffect(() => {
    if (follow && bodyRef.current) {
      bodyRef.current.scrollTop = bodyRef.current.scrollHeight;
    }
  }, [lines, follow]);

  // Applied to the live sidecar, so it takes effect on the next request
  // without a reconnect.
  const applyOptions = useCallback(
    async (v: boolean, p: boolean) => {
      setVerbose(v);
      setIncludePwsh(p);
      try {
        await setLogOptions(v, p);
        setOptsError(null);
      } catch (err) {
        setOptsError(err instanceof Error ? err.message : String(err));
      }
      void refresh();
    },
    [refresh],
  );

  const shown = (lines ?? []).filter(
    (l) => !filter || l.toLowerCase().includes(filter.toLowerCase()),
  );

  return (
    <div className="modal-scrim" onMouseDown={onClose}>
      <div
        className="dialog log-dialog"
        role="dialog"
        aria-modal="true"
        aria-label="Sidecar Log"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="dialog-title">
          <span>Sidecar Log</span>
          <button type="button" className="dialog-close" onClick={onClose} aria-label="Close">
            &#10005;
          </button>
        </div>

        <div className="log-toolbar">
          <input
            type="search"
            placeholder="Filter..."
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
          />
          <label className="log-follow" title="Poll for new lines every second">
            <input
              type="checkbox"
              checked={follow}
              onChange={(e) => setFollow(e.target.checked)}
            />
            Follow
          </label>
          <span className="log-count">
            {filter ? `${shown.length} / ${lines?.length ?? 0}` : `${lines?.length ?? 0}`} line(s)
          </span>
          <button type="button" className="btn" onClick={() => void refresh()}>
            Refresh
          </button>
          <button
            type="button"
            className="btn"
            disabled={!shown.length}
            onClick={() => void navigator.clipboard?.writeText(shown.join("\n"))}
          >
            Copy
          </button>
          <button
            type="button"
            className="btn"
            onClick={() => {
              void clearSidecarLog().then(refresh);
            }}
          >
            Clear
          </button>
        </div>

        <div className="log-toolbar log-options">
          <label
            className="log-follow"
            title="Surface PSOpenAD's own narration - every LDAP search, bind and control it issues."
          >
            <input
              type="checkbox"
              checked={verbose}
              onChange={(e) => void applyOptions(e.target.checked, includePwsh)}
            />
            Verbose
          </label>
          <label
            className="log-follow"
            title="Also include PowerShell's debug, information and warning streams. Very noisy - expect many lines per request."
          >
            <input
              type="checkbox"
              checked={includePwsh}
              onChange={(e) => void applyOptions(verbose, e.target.checked)}
            />
            Include PowerShell streams
          </label>
          {includePwsh && <span className="log-count">noisy</span>}
          {optsError && <span className="log-line is-bad">{optsError}</span>}
        </div>

        <pre className="log-body" ref={bodyRef}>
          {error && <span className="log-line is-bad">{error}</span>}
          {!error && lines === null && "Loading..."}
          {!error &&
            lines !== null &&
            shown.length === 0 &&
            (filter
              ? "No lines match the filter."
              : "Nothing logged yet. The sidecar writes here as it connects.")}
          {shown.map((l, i) => (
            <span key={i} className={`log-line${toneOf(l)}`}>
              {l}
            </span>
          ))}
        </pre>

        <div className="dialog-footer">
          <button type="button" className="btn" onClick={onClose}>
            Close
          </button>
        </div>
      </div>
    </div>
  );
}

/** Colour only what an admin must act on - a failure or a refusal (section 6). */
function toneOf(line: string): string {
  const l = line.toLowerCase();
  if (/\b(failed|error|denied|refused|timed out|unable)\b/.test(l)) return " is-bad";
  if (/\b(bound|ready|loaded|success)\b/.test(l)) return " is-good";
  return "";
}
