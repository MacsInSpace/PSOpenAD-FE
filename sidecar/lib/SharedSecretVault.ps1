# Shared secret vault: the sidecar half of the saved-connection design.
#
# Saved-connection passwords live here, not in the Rust host. The Tauri side
# keeps only non-secret connection records plus a vault reference; the password
# is resolved here at connect time and is never returned to the frontend.
#
# Why not the OS credential store: the keyring crate bound Keychain item ACLs to
# the Tauri binary's code-signing designated requirement. Dev builds are ad-hoc
# signed, so the cdhash changed every build and "Always Allow" never survived a
# rebuild - a prompt on every launch. Craig's rule is no OS credential UIs in
# any product, so the whole category goes rather than being papered over with a
# signing identity.
#
# Nothing here prompts, and nothing here throws at startup. If the vault is
# unavailable the sidecar still runs; features degrade and the status says why.

Set-StrictMode -Version Latest

$script:VaultName = 'shared'
$script:VaultState = @{
    ready = $false
    error = $null
    info  = $null
}

function Get-OpenAdFeVaultRoot {
    # Bundled build first, dev checkout second - same order USM uses.
    $repoRoot = Split-Path $PSScriptRoot -Parent | Split-Path -Parent
    return $repoRoot
}

function Get-OpenAdFeSecretManagementManifest {
    $root = Get-OpenAdFeVaultRoot
    foreach ($base in @(
            (Join-Path $root 'modules/Microsoft.PowerShell.SecretManagement'),
            (Join-Path $root 'vendor/psmodules/Microsoft.PowerShell.SecretManagement'))) {
        if (-not (Test-Path -LiteralPath $base)) { continue }
        $ver = Get-ChildItem -LiteralPath $base -Directory -ErrorAction SilentlyContinue |
            Sort-Object Name -Descending | Select-Object -First 1
        if (-not $ver) { continue }
        $manifest = Join-Path $ver.FullName 'Microsoft.PowerShell.SecretManagement.psd1'
        if (Test-Path -LiteralPath $manifest) { return $manifest }
    }
    return $null
}

function Get-OpenAdFeLocalVaultManifest {
    $root = Get-OpenAdFeVaultRoot
    foreach ($candidate in @(
            (Join-Path $root 'modules/SecretManagement.LocalVault/SecretManagement.LocalVault.psd1'),
            (Join-Path $root 'sidecar/psmodules/SecretManagement.LocalVault/SecretManagement.LocalVault.psd1'))) {
        if (Test-Path -LiteralPath $candidate) { return $candidate }
    }
    return $null
}

function Initialize-OpenAdFeSecretVault {
    <#
    .SYNOPSIS
        Import both modules by full path and register the shared vault.
        Idempotent, creates nothing on disk, never prompts, never resets.
    #>
    if ($script:VaultState.ready) { return $script:VaultState }

    try {
        $api = Get-OpenAdFeSecretManagementManifest
        if (-not $api) {
            throw 'Microsoft.PowerShell.SecretManagement is not vendored. Run: pwsh ./scripts/sync-secret-vault-modules.ps1'
        }
        $vault = Get-OpenAdFeLocalVaultManifest
        if (-not $vault) {
            throw 'SecretManagement.LocalVault is not vendored under sidecar/psmodules/.'
        }

        Import-Module -Name $api -ErrorAction Stop
        Import-Module -Name $vault -ErrorAction Stop

        # Registration is per user and holds one module path per vault name. The
        # first product to register 'shared' wins and the rest use its copy;
        # never unregister a sibling's registration to "fix" it.
        $info = Register-LocalVault -Name $script:VaultName -DefaultVault -ErrorAction Stop

        $script:VaultState.info = $info
        $script:VaultState.ready = $true
        $script:VaultState.error = $null

        $where = Get-OpenAdFeVaultField -Info $info -Name 'storeRoot'
        if (-not $where) { $where = '(unknown)' }
        $count = Get-OpenAdFeVaultField -Info $info -Name 'secretCount'
        if ($null -eq $count) { $count = 0 }
        Write-SidecarLog "Secret vault '$script:VaultName' ready at $where ($count secret(s))"

        # A store carried from another machine or user cannot be decrypted. Say
        # so plainly - it is a re-sign-in, not corruption.
        $keyMatches = Get-OpenAdFeVaultField -Info $info -Name 'keyMatches'
        if ($null -ne $keyMatches -and -not $keyMatches) {
            $script:VaultState.error = "The secret store at $where was created on another machine or by another user. Saved passwords cannot be read here - reconnect and save them again."
            Write-SidecarLog "Secret vault: key mismatch - $($script:VaultState.error)"
        }
    }
    catch {
        $script:VaultState.ready = $false
        $script:VaultState.error = $_.Exception.Message
        Write-SidecarLog "Secret vault unavailable: $($_.Exception.Message)"
    }

    return $script:VaultState
}

function Get-OpenAdFeVaultField {
    # Register-LocalVault returns a hashtable, not a PSObject, so property
    # probing silently finds nothing. Handle both shapes.
    param($Info, [string]$Name)
    if ($null -eq $Info) { return $null }
    if ($Info -is [System.Collections.IDictionary]) {
        if ($Info.Contains($Name)) { return $Info[$Name] }
        return $null
    }
    $prop = $Info.PSObject.Properties[$Name]
    if ($prop) { return $prop.Value }
    return $null
}

function Get-OpenAdFeVaultStatus {
    $state = Initialize-OpenAdFeSecretVault
    $out = [ordered]@{
        ready = [bool]$state.ready
        error = $state.error
        vault = $script:VaultName
    }
    if ($state.info) {
        foreach ($k in @('storeRoot', 'exists', 'scheme', 'keyMatches', 'secretCount', 'createdAt')) {
            $v = Get-OpenAdFeVaultField -Info $state.info -Name $k
            if ($null -ne $v) { $out[$k] = $v }
        }
    }
    return [pscustomobject]$out
}

function Get-OpenAdFeConnectionSecretName {
    param([Parameter(Mandatory)][string]$Id)
    # the name is never itself
    # sensitive, because Get-SecretInfo lists names in the clear.
    return "ad/connection/$Id"
}

function Set-OpenAdFeConnectionSecret {
    param(
        [Parameter(Mandatory)][string]$Id,
        [Parameter(Mandatory)][pscredential]$Credential,
        [string]$Label
    )
    $state = Initialize-OpenAdFeSecretVault
    if (-not $state.ready) { throw "Secret vault unavailable: $($state.error)" }

    $cred = $Credential
    $name = Get-OpenAdFeConnectionSecretName -Id $Id
    $meta = @{ createdBy = 'psopenad-fe'; createdAt = (Get-Date).ToUniversalTime().ToString('o') }
    if ($Label) { $meta['label'] = $Label }

    Set-Secret -Name $name -Secret $cred -Vault $script:VaultName -Metadata $meta -ErrorAction Stop
    Write-SidecarLog "Vault: stored $name"
    return $name
}

function Get-OpenAdFeConnectionCredential {
    <#
    .SYNOPSIS
        Resolve a saved connection's credential. Returns $null when absent, so
        callers can fall back rather than crash.
    #>
    param([Parameter(Mandatory)][string]$Id)
    $state = Initialize-OpenAdFeSecretVault
    if (-not $state.ready) { return $null }

    $name = Get-OpenAdFeConnectionSecretName -Id $Id
    try {
        return Get-Secret -Name $name -Vault $script:VaultName -ErrorAction Stop
    }
    catch {
        return $null
    }
}

function Remove-OpenAdFeConnectionSecret {
    param([Parameter(Mandatory)][string]$Id)
    $state = Initialize-OpenAdFeSecretVault
    if (-not $state.ready) { return $false }

    $name = Get-OpenAdFeConnectionSecretName -Id $Id
    try {
        Remove-Secret -Name $name -Vault $script:VaultName -ErrorAction Stop
        Write-SidecarLog "Vault: removed $name"
        return $true
    }
    catch {
        return $false
    }
}

function Test-OpenAdFeConnectionSecret {
    param([Parameter(Mandatory)][string]$Id)
    $state = Initialize-OpenAdFeSecretVault
    if (-not $state.ready) { return $false }
    $name = Get-OpenAdFeConnectionSecretName -Id $Id
    return [bool](@(Get-SecretInfo -Name $name -Vault $script:VaultName -ErrorAction SilentlyContinue).Count)
}
