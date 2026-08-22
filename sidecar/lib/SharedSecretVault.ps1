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
# The vault module is a separate project, vendored from its own repository at a
# pinned tag by scripts/sync-secret-vault-modules.ps1 and recorded with a
# checksum per file. It is not maintained here: fixes belong upstream in that
# repository, and the vendored copy stays byte-identical to the tag.
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

function Get-OpenAdFeVendoredModuleManifest {
    <#
    .SYNOPSIS
        Manifest path for a vendored module, or $null.
    .DESCRIPTION
        One resolver for both modules. Both are vendored in the layout
        Install-Module and the sync script produce - <Name>/<version>/<Name>.psd1 -
        so the version directory is not optional: SecretManagement resolves a
        directory registration only when the directory is named after the module,
        which is why the vault module registers its manifest path rather than its
        folder. The flat layout is still accepted, because a checkout of the
        module repo itself is flat.

        Bundle first (Contents/Resources/modules), then the vendored copy a dev
        checkout has.
    #>
    param([Parameter(Mandatory)][string]$Name)

    $root = Get-OpenAdFeVaultRoot
    $leaf = "$Name.psd1"
    foreach ($base in @(
            (Join-Path $root "modules/$Name"),
            (Join-Path $root "vendor/psmodules/$Name"))) {
        if (-not (Test-Path -LiteralPath $base)) { continue }

        # Highest version wins, and versions sort as versions - "1.10.0" is
        # above "1.9.0", which a plain string sort gets backwards.
        $versions = @(Get-ChildItem -LiteralPath $base -Directory -ErrorAction SilentlyContinue |
            Where-Object { $_.Name -match '^\d+(\.\d+)*$' } |
            Sort-Object { [version]$_.Name } -Descending)
        foreach ($v in $versions) {
            $manifest = Join-Path $v.FullName $leaf
            if (Test-Path -LiteralPath $manifest) { return $manifest }
        }

        $flat = Join-Path $base $leaf
        if (Test-Path -LiteralPath $flat) { return $flat }
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
        $api = Get-OpenAdFeVendoredModuleManifest -Name 'Microsoft.PowerShell.SecretManagement'
        if (-not $api) {
            throw 'Microsoft.PowerShell.SecretManagement is not vendored. Run: pwsh ./scripts/sync-secret-vault-modules.ps1'
        }
        $vault = Get-OpenAdFeVendoredModuleManifest -Name 'SecretManagement.LocalVault'
        if (-not $vault) {
            throw 'SecretManagement.LocalVault is not vendored. Run: pwsh ./scripts/sync-secret-vault-modules.ps1'
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
