/**
 * The small modal ADUC throws up for a single decision or a single value:
 * "Are you sure you want to delete...", "Rename to...", "Move to...".
 *
 * One component rather than three, because they differ only in whether there
 * is an input and whether the primary button is destructive. Keeping them
 * identical in shape is the point - an admin should not have to re-read a
 * dialog they have already seen in another guise.
 */
import { useEffect, useRef, useState, type ReactNode } from "react";

export type AskKind = "confirm" | "prompt";

export function AskDialog({
  kind,
  title,
  message,
  label,
  initialValue = "",
  confirmLabel = "OK",
  danger = false,
  busy = false,
  error = null,
  onCancel,
  onConfirm,
}: {
  kind: AskKind;
  title: string;
  message: ReactNode;
  label?: string;
  initialValue?: string;
  confirmLabel?: string;
  danger?: boolean;
  busy?: boolean;
  error?: string | null;
  onCancel: () => void;
  onConfirm: (value: string) => void;
}) {
  const [value, setValue] = useState(initialValue);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onCancel();
      }
    };
    window.addEventListener("keydown", onKey);
    inputRef.current?.focus();
    inputRef.current?.select();
    return () => window.removeEventListener("keydown", onKey);
  }, [onCancel]);

  const canConfirm = !busy && (kind === "confirm" || value.trim().length > 0);

  return (
    <div className="modal-scrim" onMouseDown={busy ? undefined : onCancel}>
      <form
        className="dialog ask-dialog"
        role="dialog"
        aria-modal="true"
        aria-label={title}
        onMouseDown={(e) => e.stopPropagation()}
        onSubmit={(e) => {
          e.preventDefault();
          if (canConfirm) onConfirm(value.trim());
        }}
      >
        <div className="dialog-title">
          <span>{title}</span>
          <button
            type="button"
            className="dialog-close"
            onClick={onCancel}
            disabled={busy}
            aria-label="Close"
          >
            &#10005;
          </button>
        </div>

        <div className="dialog-body">
          <p className="ask-message">{message}</p>

          {kind === "prompt" && (
            <div className="field-row">
              <label className="field-label" htmlFor="ask-value">
                {label ?? "Value"}
              </label>
              <input
                id="ask-value"
                ref={inputRef}
                className="field-input"
                value={value}
                disabled={busy}
                onChange={(e) => setValue(e.target.value)}
              />
            </div>
          )}

          {error && <pre className="error-block">{error}</pre>}
        </div>

        <div className="dialog-footer">
          <button
            type="submit"
            className={danger ? "btn btn-danger" : "btn btn-primary"}
            disabled={!canConfirm}
          >
            {busy ? "Working..." : confirmLabel}
          </button>
          <button type="button" className="btn" onClick={onCancel} disabled={busy}>
            Cancel
          </button>
        </div>
      </form>
    </div>
  );
}
