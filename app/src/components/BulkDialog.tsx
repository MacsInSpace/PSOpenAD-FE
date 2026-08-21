/**
 * Runs one operation across a multi-selection and reports what happened to
 * each object.
 *
 * The per-item result is the whole point. A bulk change against a directory
 * partially fails all the time - one account is protected, another is in a
 * container you cannot write, a third is already in the group. Reporting only
 * "done" would hide that, and an admin would find out later from a user who
 * still cannot log in. So every target gets a line, and the failures stay on
 * screen until dismissed.
 *
 * Work is sequential rather than parallel: these are writes against one LDAP
 * session, and a readable, ordered log of what happened is worth more than
 * shaving a second off a hundred objects.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import type { DirectoryRow } from "../lib/api";
import { ObjectIcon } from "./ObjectIcon";

type Outcome = { row: DirectoryRow; ok: boolean; error?: string };

export function BulkDialog({
  title,
  verb,
  targets,
  confirmMessage,
  danger = false,
  run,
  onClose,
  onFinished,
}: {
  title: string;
  /** Present tense, for the progress line: "Disabling", "Deleting". */
  verb: string;
  targets: DirectoryRow[];
  /** When set, nothing runs until the operator agrees. */
  confirmMessage?: React.ReactNode;
  danger?: boolean;
  run: (row: DirectoryRow) => Promise<unknown>;
  onClose: () => void;
  onFinished: () => void;
}) {
  const [started, setStarted] = useState(!confirmMessage);
  const [done, setDone] = useState<Outcome[]>([]);
  const [finished, setFinished] = useState(false);
  const cancelled = useRef(false);

  useEffect(() => () => {
    cancelled.current = true;
  }, []);

  const go = useCallback(async () => {
    setStarted(true);
    const results: Outcome[] = [];
    for (const row of targets) {
      if (cancelled.current) return;
      try {
        await run(row);
        results.push({ row, ok: true });
      } catch (err) {
        results.push({
          row,
          ok: false,
          error: err instanceof Error ? err.message : String(err),
        });
      }
      if (cancelled.current) return;
      setDone([...results]);
    }
    setFinished(true);
    onFinished();
  }, [targets, run, onFinished]);

  useEffect(() => {
    if (started && done.length === 0 && !finished) void go();
    // Intentionally only on the initial start.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [started]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && (!started || finished)) {
        e.stopPropagation();
        onClose();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose, started, finished]);

  const failed = done.filter((d) => !d.ok);
  const succeeded = done.length - failed.length;
  const busy = started && !finished;

  return (
    <div className="modal-scrim" onMouseDown={busy ? undefined : onClose}>
      <div
        className="dialog bulk-dialog"
        role="dialog"
        aria-modal="true"
        aria-label={title}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="dialog-title">
          <span>{title}</span>
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
          {!started ? (
            <>
              <p className="ask-message">{confirmMessage}</p>
              <div className="list-frame bulk-preview">
                <table className="sheet-table">
                  <tbody>
                    {targets.map((t) => (
                      <tr key={t.distinguishedName}>
                        <td>
                          <span className="name-cell">
                            <ObjectIcon row={t} />
                            <span className="name-text">
                              {t.displayName || t.name}
                            </span>
                          </span>
                        </td>
                        <td className="mono">{t.samAccountName}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          ) : (
            <>
              <p className="ask-message">
                {finished ? (
                  failed.length === 0 ? (
                    <>All {done.length} succeeded.</>
                  ) : (
                    <>
                      {succeeded} succeeded, <strong>{failed.length} failed</strong>.
                    </>
                  )
                ) : (
                  <>
                    {verb} {done.length + 1} of {targets.length}...
                  </>
                )}
              </p>

              <div className="list-frame bulk-preview">
                <table className="sheet-table">
                  <tbody>
                    {done.map((d) => (
                      <tr key={d.row.distinguishedName}>
                        <td>
                          <span className="name-cell">
                            <ObjectIcon row={d.row} />
                            <span className="name-text">
                              {d.row.displayName || d.row.name}
                            </span>
                          </span>
                        </td>
                        <td className={d.ok ? "bulk-ok" : "bulk-fail"}>
                          {d.ok ? "OK" : (d.error ?? "failed")}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          )}
        </div>

        <div className="dialog-footer">
          {!started ? (
            <>
              <button
                type="button"
                className={danger ? "btn btn-danger" : "btn btn-primary"}
                onClick={() => void go()}
              >
                Yes
              </button>
              <button type="button" className="btn" onClick={onClose}>
                Cancel
              </button>
            </>
          ) : (
            <button type="button" className="btn" onClick={onClose} disabled={busy}>
              {busy ? "Working..." : "Close"}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
