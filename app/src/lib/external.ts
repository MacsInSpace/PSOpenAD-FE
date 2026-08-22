/**
 * Open a link in the user's browser.
 *
 * `window.open` does nothing useful inside a Tauri webview - at best it opens
 * inside the app window, which is not what a documentation link should do - so
 * the opener plugin is the real path. The fallback exists for `npm run dev`
 * and the sample-data build running in a plain browser, where the plugin is
 * absent and `window.open` is exactly right.
 */
import { openUrl } from "@tauri-apps/plugin-opener";

export function openExternal(url: string): void {
  void openUrl(url).catch(() => {
    try {
      window.open(url, "_blank", "noopener,noreferrer");
    } catch {
      /* nothing further to try; a dead link is not worth an error dialog */
    }
  });
}
