<#
.SYNOPSIS
    Rebuilds vendor/PSOpenAD from source and regenerates vendor/psopenad.lock.json.

.DESCRIPTION
    The house vendoring pattern: a sync script and a lockfile. PSOpenAD is a separate upstream project, vendored
    and reference-only - it is never edited from inside this repo. Local changes
    live as patch files under scripts/psopenad-patches/ and are re-applied on
    every rebuild, so a fresh clone reproduces the vendored binary exactly.

    The lockfile is the point. Without recorded checksums there is no way to
    tell a current vendored binary from a stale one, which is how the vendored
    0.7.0 build ended up with unrecoverable provenance.

.PARAMETER SourcePath
    Clone of the PSOpenAD source. Default ./PSOpenAD (gitignored, disposable).

.PARAMETER Clean
    Discard local modifications in the source tree before applying patches.
    Use this for a reproducible build; omit it if you are mid-patch-development.

.PARAMETER VerifyOnly
    Do not build. Compare the working tree against the lockfile and report drift.
    This is the CI-friendly mode; exits non-zero when anything has drifted.

.EXAMPLE
    pwsh -File ./scripts/sync-psopenad-vendor.ps1 -VerifyOnly
    pwsh -File ./scripts/sync-psopenad-vendor.ps1 -Clean
#>
[CmdletBinding()]
param(
    [string]$SourcePath = (Join-Path $PSScriptRoot '..' 'PSOpenAD'),
    [switch]$Clean,
    [switch]$VerifyOnly
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$RepoRoot   = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$PatchDir   = Join-Path $RepoRoot 'scripts/psopenad-patches'
$VendorDir  = Join-Path $RepoRoot 'vendor/PSOpenAD'
$LockPath   = Join-Path $RepoRoot 'vendor/psopenad.lock.json'
$Upstream   = 'https://github.com/jborean93/PSOpenAD'

function Get-Sha256([string]$Path) {
    (Get-FileHash -Path $Path -Algorithm SHA256).Hash.ToLowerInvariant()
}

function Get-PatchFiles {
    @(Get-ChildItem -Path $PatchDir -Filter '*.patch' -File | Sort-Object Name)
}

function Write-Status([string]$State, [string]$Message) {
    $colour = switch ($State) { 'OK' { 'Green' } 'DRIFT' { 'Yellow' } 'FAIL' { 'Red' } default { 'Gray' } }
    Write-Host ("  {0,-6} {1}" -f $State, $Message) -ForegroundColor $colour
}

# -- Verify ---------------------------------------------------------------------

function Invoke-DriftCheck {
    if (-not (Test-Path $LockPath)) {
        Write-Status 'FAIL' "No lockfile at $LockPath"
        return $false
    }
    $lock = Get-Content -Raw -Path $LockPath | ConvertFrom-Json
    $clean = $true

    Write-Host "`nPatches" -ForegroundColor Cyan
    $recorded = @{}
    foreach ($p in $lock.patches) { $recorded[[string]$p.file] = [string]$p.sha256 }

    foreach ($f in Get-PatchFiles) {
        $rel = "scripts/psopenad-patches/$($f.Name)"
        $actual = Get-Sha256 $f.FullName
        if (-not $recorded.ContainsKey($rel)) {
            Write-Status 'DRIFT' "$($f.Name) - present on disk but absent from the lockfile"
            $clean = $false
        }
        elseif ($recorded[$rel] -ne $actual) {
            Write-Status 'DRIFT' "$($f.Name) - changed since the vendored build"
            $clean = $false
        }
        else {
            Write-Status 'OK' $f.Name
        }
    }
    foreach ($rel in $recorded.Keys) {
        if (-not (Test-Path (Join-Path $RepoRoot $rel))) {
            Write-Status 'DRIFT' "$rel - in the lockfile but missing from disk"
            $clean = $false
        }
    }

    Write-Host "`nVendored binaries" -ForegroundColor Cyan
    foreach ($prop in $lock.vendorBuild.binaries.PSObject.Properties) {
        $path = Join-Path $VendorDir $prop.Name
        if (-not (Test-Path $path)) {
            Write-Status 'FAIL' "$($prop.Name) - missing"
            $clean = $false
            continue
        }
        if ((Get-Sha256 $path) -ne $prop.Value) {
            Write-Status 'DRIFT' "$($prop.Name) - does not match the lockfile"
            $clean = $false
        }
        else {
            Write-Status 'OK' $prop.Name
        }
    }

    # A patch reaches the build one of two ways: committed on the fork, so it
    # arrives with the clone, or floating, applied at build time. Only a
    # floating patch missing from the vendored build is drift.
    Write-Host "`nPatch carriage" -ForegroundColor Cyan
    $appliedText = ($lock.vendorBuild.patchesApplied -join "`n")
    foreach ($entry in $lock.patches) {
        $name = ([string]$entry.file).Split('/')[-1]
        $state = if ($entry.PSObject.Properties['state']) { [string]$entry.state } else { 'floating' }

        if ($state -eq 'committed-in-fork') {
            $at = if ($entry.PSObject.Properties['inSourceTreeAt']) { " via $($entry.inSourceTreeAt.Substring(0,10))" }
                  elseif ($entry.PSObject.Properties['committedAs']) { " via $($entry.committedAs)" }
                  else { '' }
            Write-Status 'OK' "$name - in the source tree$at"
        }
        elseif ($appliedText -like "*$($entry.file)*") {
            Write-Status 'OK' "$name - applied to the vendored build"
        }
        else {
            Write-Status 'DRIFT' "$name - floating, not in the vendored build; rebuild to include it"
            $clean = $false
        }
    }

    if ($lock.vendorBuild.builtFromCommit -eq 'unverified') {
        Write-Host "`nProvenance" -ForegroundColor Cyan
        Write-Status 'DRIFT' 'builtFromCommit is unverified - the next rebuild will set it'
    }

    return $clean
}

if ($VerifyOnly) {
    Write-Host "PSOpenAD vendor drift check" -ForegroundColor White
    $ok = Invoke-DriftCheck
    Write-Host ""
    if ($ok) {
        Write-Host "vendor/PSOpenAD matches the lockfile." -ForegroundColor Green
        exit 0
    }
    Write-Host "vendor/PSOpenAD has drifted from the lockfile - rebuild with -Clean." -ForegroundColor Yellow
    exit 1
}

# -- Build ----------------------------------------------------------------------

if (-not (Test-Path $SourcePath)) {
    throw "No source tree at $SourcePath. Clone it first:`n  git clone https://github.com/MacsInSpace/PSOpenAD `"$SourcePath`""
}
$SourcePath = (Resolve-Path $SourcePath).Path

Push-Location $SourcePath
try {
    if ($Clean) {
        Write-Host "Resetting source tree" -ForegroundColor Cyan
        git checkout -- . 2>&1 | Out-Null
    }
    else {
        $dirty = @(git status --porcelain -- src 2>$null)
        if ($dirty.Count -gt 0) {
            Write-Warning "Source tree has uncommitted changes under src/ and -Clean was not passed."
            Write-Warning "The build will include them, which may not match the patch files."
        }
    }

    $commit = (git rev-parse HEAD).Trim()
    $subject = (git log -1 --pretty=%s).Trim()

    # Record how far the fork sits from upstream, so the lockfile answers
    # "is there anything to pull?" without a network round trip next time.
    $behind = 'unknown'; $ahead = 'unknown'
    try {
        git fetch -q $Upstream main 2>&1 | Out-Null
        $behind = (git rev-list --count HEAD..FETCH_HEAD).Trim()
        $ahead  = (git rev-list --count FETCH_HEAD..HEAD).Trim()
        $upstreamBase = (git rev-parse FETCH_HEAD).Trim()
    }
    catch {
        Write-Warning "Could not reach upstream to compare: $($_.Exception.Message)"
        $upstreamBase = 'unknown'
    }

    # Remember how each patch reached the build, so the lockfile can say
    # "arrived with the clone" rather than claiming everything was applied.
    $script:PatchState = @{}

    if ($Clean) {
        Write-Host "Applying patches" -ForegroundColor Cyan
        foreach ($f in Get-PatchFiles) {
            # A patch may already be committed on the fork rather than floating
            # as a local change - target-spn-host-macos.patch is, since ac4d44d.
            # Blindly applying every patch file fails on a fresh clone, so check
            # for the reverse first: if it reverses cleanly it is already in.
            git apply --reverse --check $f.FullName 2>$null
            if ($LASTEXITCODE -eq 0) {
                Write-Status 'SKIP' "$($f.Name) - already committed in the source tree"
                $script:PatchState[$f.Name] = 'committed-in-fork'
                continue
            }

            git apply --check $f.FullName 2>$null
            if ($LASTEXITCODE -ne 0) {
                throw "$($f.Name) neither applies nor is already applied - the source tree has moved under it. Rebase the patch against $commit."
            }

            git apply $f.FullName
            if ($LASTEXITCODE -ne 0) { throw "Failed to apply $($f.Name)" }
            $script:PatchState[$f.Name] = 'floating'
            Write-Status 'OK' "applied $($f.Name)"
        }
    }

    Write-Host "Building (Release)" -ForegroundColor Cyan
    pwsh -NoProfile -File ./build.ps1 -Task Build -Configuration Release
    if ($LASTEXITCODE -ne 0) { throw "build.ps1 failed with exit code $LASTEXITCODE" }

    $built = Get-ChildItem -Path (Join-Path $SourcePath 'output/PSOpenAD') -Directory |
        Sort-Object Name -Descending | Select-Object -First 1
    if (-not $built) { throw "No build output under output/PSOpenAD" }
}
finally {
    Pop-Location
}

Write-Host "Copying $($built.Name) into vendor/PSOpenAD" -ForegroundColor Cyan
if (Test-Path $VendorDir) { Remove-Item -Recurse -Force $VendorDir }
New-Item -ItemType Directory -Force -Path $VendorDir | Out-Null
Copy-Item -Recurse -Force -Path (Join-Path $built.FullName '*') -Destination $VendorDir

$binaries = [ordered]@{}
foreach ($dll in Get-ChildItem -Path $VendorDir -Recurse -Filter 'PSOpenAD*.dll' -File | Sort-Object FullName) {
    $rel = $dll.FullName.Substring($VendorDir.Length).TrimStart([char]'/', [char]'\') -replace '\\', '/'
    $binaries[$rel] = Get-Sha256 $dll.FullName
}

$patchEntries = @(Get-PatchFiles | ForEach-Object {
    # Without -Clean nothing was applied this run, so we can only record that
    # the tree was taken as-is rather than assert how the patch got there.
    $state = if ($script:PatchState.ContainsKey($_.Name)) { $script:PatchState[$_.Name] } else { 'assumed-in-tree' }
    $entry = [ordered]@{
        file   = "scripts/psopenad-patches/$($_.Name)"
        sha256 = Get-Sha256 $_.FullName
        state  = $state
    }
    if ($state -eq 'committed-in-fork') { $entry['inSourceTreeAt'] = $commit }
    $entry
})

$today = (Get-Date).ToString('yyyy-MM-dd')
$lock = [ordered]@{
    _comment = 'Pins what vendor/PSOpenAD was built from. Regenerate with scripts/sync-psopenad-vendor.ps1; check with -VerifyOnly.'
    source   = 'https://github.com/MacsInSpace/PSOpenAD'
    upstream = $Upstream
    sourceTree = [ordered]@{
        commit                 = $commit
        subject                = $subject
        upstreamBase           = $upstreamBase
        commitsAheadOfUpstream = $ahead
        commitsBehindUpstream  = $behind
        checkedAgainstUpstream = $today
    }
    patches = $patchEntries
    vendorBuild = [ordered]@{
        moduleVersion   = $built.Name
        vendoredOn      = $today
        binaries        = $binaries
        builtFromCommit = $commit
        # Only the patches genuinely applied at build time; the rest arrived
        # with the clone and are listed under patches[].state instead.
        patchesApplied  = @($patchEntries | Where-Object { $_.state -eq 'floating' } | ForEach-Object { $_.file })
    }
    knownDrift = @()
}

$lock | ConvertTo-Json -Depth 8 | Set-Content -Path $LockPath -Encoding utf8

Write-Host "`nVendored PSOpenAD $($built.Name) from $($commit.Substring(0,10))" -ForegroundColor Green
Write-Host "Lockfile updated: vendor/psopenad.lock.json" -ForegroundColor Green
if ($behind -ne '0' -and $behind -ne 'unknown') {
    Write-Warning "MacsInSpace is $behind commit(s) behind $Upstream - consider pulling before the next rebuild."
}
