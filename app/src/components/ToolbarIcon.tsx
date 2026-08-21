import type { ReactNode } from "react";

/**
 * MMC toolbar glyphs. Stroke-only, 16px, single-colour (currentColor) so they
 * inherit enabled/disabled state from the button - the toolbar is chrome, and
 * chrome does not carry its own palette (style guide section 1).
 */
export type ToolbarGlyph =
  | "back"
  | "forward"
  | "up"
  | "refresh"
  | "find"
  | "filter"
  | "newUser"
  | "newGroup"
  | "newOu"
  | "properties"
  | "columns";

const PATHS: Record<ToolbarGlyph, ReactNode> = {
  back: <path d="M10 3.5 5.5 8l4.5 4.5" />,
  forward: <path d="M6 3.5 10.5 8 6 12.5" />,
  up: <path d="M8 12.5V4M4.5 7.5 8 4l3.5 3.5" />,
  refresh: (
    <>
      <path d="M13 8a5 5 0 1 1-1.6-3.7" />
      <path d="M13.4 2.6v2.6h-2.6" />
    </>
  ),
  find: (
    <>
      <circle cx="7" cy="7" r="4" />
      <path d="M10 10l3.5 3.5" />
    </>
  ),
  filter: <path d="M2.5 3.5h11L9.5 8.3v4.4l-3 1.3V8.3z" />,
  newUser: (
    <>
      <circle cx="6.3" cy="5.2" r="2.5" />
      <path d="M2 13.2c0-2.5 1.9-4.1 4.3-4.1 .8 0 1.5.2 2.1.5" />
      <path d="M11.5 8.5v5M9 11h5" />
    </>
  ),
  newGroup: (
    <>
      <circle cx="4.6" cy="5.2" r="2.1" />
      <circle cx="9" cy="5.2" r="2.1" />
      <path d="M1 12.6c0-2.1 1.6-3.4 3.6-3.4M5.6 12.6c0-2.1 1.6-3.4 3.4-3.4" />
      <path d="M12.5 8.8v4.8M10.1 11.2h4.8" />
    </>
  ),
  newOu: (
    <>
      <path d="M1.5 3.8h4.2l1.1 1.5H11v4.2" />
      <path d="M1.5 3.8v9h5.2" />
      <path d="M12 9.2v4.6M9.7 11.5h4.6" />
    </>
  ),
  properties: (
    <>
      <rect x="2.5" y="2" width="11" height="12" rx="1" />
      <path d="M5 5.5h6M5 8h6M5 10.5h3.5" />
    </>
  ),
  columns: (
    <>
      <rect x="2" y="3" width="12" height="10" rx="1" />
      <path d="M6.5 3v10M2 6h12" />
    </>
  ),
};

export function ToolbarIcon({ glyph, size = 16 }: { glyph: ToolbarGlyph; size?: number }) {
  return (
    <svg
      className="tb-icon"
      viewBox="0 0 16 16"
      width={size}
      height={size}
      fill="none"
      stroke="currentColor"
      strokeWidth="1.4"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      {PATHS[glyph]}
    </svg>
  );
}
