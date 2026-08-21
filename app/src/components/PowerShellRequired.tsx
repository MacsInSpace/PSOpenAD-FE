/**
 * Shown once at startup when PowerShell 7 cannot be found.
 *
 * It is the one dependency the bundle cannot carry, and without it nothing in
 * the app works - every directory call goes through a pwsh sidecar. Meeting
 * that as a bare spawn error on the first Connect is the worst way to learn
 * it, so the app checks up front and says exactly what is missing and where to
 * get it. There is no Cancel: there is nothing useful to do in the app without
 * it, and pretending otherwise would only move the failure later.
 */
import { openUrl } from "@tauri-apps/plugin-opener";

const DOWNLOAD = "https://aka.ms/powershell";

export function PowerShellRequired({ onRecheck }: { onRecheck: () => void }) {
  return (
    <div className="modal-scrim">
      <div
        className="dialog pwsh-dialog"
        role="alertdialog"
        aria-modal="true"
        aria-label="PowerShell 7 is required"
      >
        <div className="dialog-title">
          <span>PowerShell 7 is required</span>
        </div>
        <div className="dialog-body">
          <p>
            PSOpenAD-FE talks to Active Directory through PowerShell 7, and it
            could not be found on this computer.
          </p>
          <p>
            Install it, then choose <strong>Check again</strong>. On macOS,
            either the installer from the download page or{" "}
            <code>brew install --cask powershell</code> will do.
          </p>
          <p className="field-help">
            If it is installed somewhere unusual, start the app with the
            environment variable <code>PWSH_PATH</code> set to the full path of{" "}
            <code>pwsh</code>.
          </p>
        </div>
        <div className="dialog-footer">
          <button
            type="button"
            className="btn btn-primary"
            onClick={() => void openUrl(DOWNLOAD).catch(() => undefined)}
          >
            Open download page
          </button>
          <button type="button" className="btn" onClick={onRecheck}>
            Check again
          </button>
        </div>
      </div>
    </div>
  );
}
