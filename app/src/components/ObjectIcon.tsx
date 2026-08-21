import type { DirectoryRow } from "../lib/api";
import { objectKind } from "../lib/api";

/**
 * Object-class glyphs, drawn to read like the ADUC/MMC icon set at 16px:
 * a person bust for users, a pair of busts for groups, a monitor for
 * computers, a folder for containers and a folder-with-page for OUs.
 *
 * Two tones per glyph - a body and a detail - both driven by CSS custom
 * properties so light and dark each get a full palette (style guide section 1).
 * A disabled account gets a corner overlay rather than a colour change,
 * because colour alone is not a state indicator.
 */
export function ObjectIcon({
  row,
  size = 16,
}: {
  row: Pick<DirectoryRow, "objectClass" | "enabled">;
  size?: number;
}) {
  const kind = objectKind(row);
  const disabled = row.enabled === false;
  return (
    <span
      className={`obj-icon kind-${kind}${disabled ? " is-disabled" : ""}`}
      style={{ width: size, height: size }}
      aria-hidden
    >
      <svg viewBox="0 0 16 16" width={size} height={size}>
        {kind === "user" && (
          <>
            <circle cx="8" cy="4.6" r="2.9" className="glyph-fg" />
            <path d="M2.4 14.2c0-3.1 2.5-5 5.6-5s5.6 1.9 5.6 5z" className="glyph-fg" />
          </>
        )}

        {kind === "group" && (
          <>
            <circle cx="4.4" cy="5.1" r="2.3" className="glyph-bg" />
            <path d="M0.6 13.4c0-2.4 1.7-3.9 3.8-3.9s3.8 1.5 3.8 3.9z" className="glyph-bg" />
            <circle cx="10.6" cy="4.6" r="2.7" className="glyph-fg" />
            <path d="M5.4 14.2c0-2.8 2.3-4.6 5.2-4.6s5.2 1.8 5.2 4.6z" className="glyph-fg" />
          </>
        )}

        {kind === "computer" && (
          <>
            <rect x="1.2" y="2.6" width="13.6" height="8.4" rx="1" className="glyph-fg" />
            <rect x="2.6" y="4" width="10.8" height="5.6" className="glyph-screen" />
            <path d="M4.6 14.4h6.8l-.9-2.2H5.5z" className="glyph-fg" />
          </>
        )}

        {(kind === "ou" || kind === "container") && (
          <>
            <path
              d="M1 3.4h4.9l1.3 1.7h7.8v8.5H1z"
              className={kind === "ou" ? "glyph-fg" : "glyph-bg"}
            />
            {kind === "ou" && (
              /* OUs carry a page, the way ADUC marks a managed container. */
              <>
                <rect x="5.4" y="7" width="5.2" height="6" rx="0.4" className="glyph-screen" />
                <path
                  d="M6.5 8.6h3M6.5 10h3M6.5 11.4h2"
                  className="glyph-rule"
                  fill="none"
                  strokeWidth="0.9"
                  strokeLinecap="round"
                />
              </>
            )}
          </>
        )}

        {kind === "other" && (
          <>
            <path d="M3 1.6h6.2L13 5.4v9H3z" className="glyph-bg" />
            <path d="M9.2 1.6 13 5.4H9.2z" className="glyph-fg" />
          </>
        )}
      </svg>

      {disabled && (
        /* ADUC's "account disabled" overlay: a red circle-slash on the corner. */
        <svg className="obj-overlay" viewBox="0 0 8 8" width={Math.round(size * 0.62)}>
          <circle cx="4" cy="4" r="3.4" className="overlay-disabled" />
          <path d="M2.1 4h3.8" stroke="#fff" strokeWidth="1.3" strokeLinecap="round" />
        </svg>
      )}
    </span>
  );
}
