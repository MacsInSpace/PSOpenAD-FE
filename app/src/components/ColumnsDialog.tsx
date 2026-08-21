/**
 * ADUC's View > Add/Remove Columns, same shape and same wording.
 *
 * Two list boxes with Add/Remove between them and Move Up/Move Down beside the
 * right-hand one. It is an old dialog and a slightly clumsy one, but it is the
 * one an AD admin already knows, and recognition is the whole point of this
 * app. Nothing is applied until OK, so Cancel really does nothing.
 */
import { useEffect, useState } from "react";
import {
  ALL_COLUMNS,
  COLUMNS,
  REQUIRED_COLUMN,
  type ColumnKey,
} from "../lib/columns";

export function ColumnsDialog({
  columns,
  defaults,
  onCancel,
  onApply,
}: {
  columns: ColumnKey[];
  /** What "Restore Defaults" goes back to for the list being configured. */
  defaults: ColumnKey[];
  onCancel: () => void;
  onApply: (cols: ColumnKey[]) => void;
}) {
  const [shown, setShown] = useState<ColumnKey[]>(columns);
  const [pickAvailable, setPickAvailable] = useState<ColumnKey | null>(null);
  const [pickShown, setPickShown] = useState<ColumnKey | null>(null);

  const available = ALL_COLUMNS.filter((k) => !shown.includes(k));

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onCancel();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onCancel]);

  const add = () => {
    if (!pickAvailable) return;
    setShown((prev) => [...prev, pickAvailable]);
    setPickAvailable(null);
  };

  const remove = () => {
    if (!pickShown || pickShown === REQUIRED_COLUMN) return;
    setShown((prev) => prev.filter((k) => k !== pickShown));
    setPickShown(null);
  };

  const move = (by: -1 | 1) => {
    if (!pickShown) return;
    setShown((prev) => {
      const i = prev.indexOf(pickShown);
      const j = i + by;
      if (i < 0 || j < 0 || j >= prev.length) return prev;
      const next = [...prev];
      [next[i], next[j]] = [next[j]!, next[i]!];
      return next;
    });
  };

  const shownIndex = pickShown ? shown.indexOf(pickShown) : -1;

  return (
    <div className="modal-scrim" onMouseDown={onCancel}>
      <div
        className="dialog columns-dialog"
        role="dialog"
        aria-modal="true"
        aria-label="Add/Remove Columns"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="dialog-title">
          <span>Add/Remove Columns</span>
          <button
            type="button"
            className="dialog-close"
            onClick={onCancel}
            aria-label="Close"
          >
            &#10005;
          </button>
        </div>

        <div className="dialog-body columns-body">
          <div className="columns-col">
            <label className="field-label" id="cols-available">
              Available columns:
            </label>
            <ul className="list-frame column-list" aria-labelledby="cols-available">
              {available.map((k) => (
                <li key={k}>
                  <button
                    type="button"
                    className={
                      pickAvailable === k ? "column-item is-selected" : "column-item"
                    }
                    onClick={() => setPickAvailable(k)}
                    onDoubleClick={() => {
                      setShown((prev) => [...prev, k]);
                      setPickAvailable(null);
                    }}
                  >
                    {COLUMNS[k].label}
                  </button>
                </li>
              ))}
              {available.length === 0 && (
                <li className="column-empty">Every column is displayed.</li>
              )}
            </ul>
          </div>

          <div className="columns-mid">
            <button
              type="button"
              className="btn"
              disabled={!pickAvailable}
              onClick={add}
            >
              Add -&gt;
            </button>
            <button
              type="button"
              className="btn"
              disabled={!pickShown || pickShown === REQUIRED_COLUMN}
              onClick={remove}
            >
              &lt;- Remove
            </button>
          </div>

          <div className="columns-col">
            <label className="field-label" id="cols-shown">
              Displayed columns:
            </label>
            <ul className="list-frame column-list" aria-labelledby="cols-shown">
              {shown.map((k) => (
                <li key={k}>
                  <button
                    type="button"
                    className={
                      pickShown === k ? "column-item is-selected" : "column-item"
                    }
                    title={
                      k === REQUIRED_COLUMN
                        ? "Name cannot be removed"
                        : COLUMNS[k].label
                    }
                    onClick={() => setPickShown(k)}
                    onDoubleClick={() => {
                      if (k !== REQUIRED_COLUMN) {
                        setShown((prev) => prev.filter((c) => c !== k));
                        setPickShown(null);
                      }
                    }}
                  >
                    {COLUMNS[k].label}
                  </button>
                </li>
              ))}
            </ul>
          </div>

          <div className="columns-mid">
            <button
              type="button"
              className="btn"
              disabled={shownIndex <= 0}
              onClick={() => move(-1)}
            >
              Move Up
            </button>
            <button
              type="button"
              className="btn"
              disabled={shownIndex < 0 || shownIndex >= shown.length - 1}
              onClick={() => move(1)}
            >
              Move Down
            </button>
          </div>
        </div>

        <div className="dialog-footer">
          <button
            type="button"
            className="btn btn-primary"
            onClick={() => onApply(shown)}
          >
            OK
          </button>
          <button type="button" className="btn" onClick={onCancel}>
            Cancel
          </button>
          <button
            type="button"
            className="btn"
            onClick={() => {
              setShown(defaults);
              setPickShown(null);
              setPickAvailable(null);
            }}
          >
            Restore Defaults
          </button>
        </div>
      </div>
    </div>
  );
}
