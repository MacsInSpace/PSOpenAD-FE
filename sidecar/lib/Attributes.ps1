# PSOpenAD wraps attribute values in PSObjects / lists - unwrap safely.
# See docs/PSOpenAD_notes.md section Reading attribute values.

# Dot-sourced into the sidecar, which sets this too. Declared here as well so
# the file is equally strict if it is ever loaded or tested on its own.
Set-StrictMode -Version Latest

function ConvertTo-OpenAdFeScalar {
    [CmdletBinding()]
    param([AllowNull()][object]$Value)

    if ($null -eq $Value) { return $null }

    if ($Value -is [System.Collections.IEnumerable] -and -not ($Value -is [string]) -and -not ($Value -is [byte[]])) {
        # Don't recurse into collections here - callers iterate.
        return $Value
    }

    if ($Value -is [psobject]) {
        $noteNames = @($Value.PSObject.Properties | Where-Object { $_.MemberType -eq 'NoteProperty' } | ForEach-Object { $_.Name })
        if ($noteNames -contains 'Value') {
            return ConvertTo-OpenAdFeScalar -Value $Value.Value
        }
        $typeNames = @($Value.PSObject.TypeNames)
        if ($typeNames -contains 'PSOpenAD.LDAP.DistinguishedName') {
            try { return [string]$Value.Value } catch { return [string]$Value }
        }
    }

    try {
        if ($Value -is [PSOpenAD.LDAP.DistinguishedName]) {
            return [string]$Value.Value
        }
    } catch {
        # type may be unavailable if module not loaded in this scope
    }

    if ($Value -is [datetime] -or $Value -is [datetimeoffset]) {
        return ([datetimeoffset]$Value).ToString('o')
    }

    if ($Value -is [guid]) { return $Value.ToString() }
    if ($Value -is [byte[]]) { return [Convert]::ToBase64String($Value) }

    return [string]$Value
}

function Get-OpenAdFePropertyValues {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)]
        $Object,

        [Parameter(Mandatory)]
        [string]$Name
    )

    $prop = $Object.PSObject.Properties[$Name]
    if (-not $prop) {
        # Case-insensitive fallback
        $prop = $Object.PSObject.Properties | Where-Object { $_.Name -eq $Name } | Select-Object -First 1
    }
    if (-not $prop) { return @() }

    $raw = $prop.Value
    if ($null -eq $raw) { return @() }

    $vals = [System.Collections.Generic.List[string]]::new()
    foreach ($item in @($raw)) {
        $s = ConvertTo-OpenAdFeScalar -Value $item
        if ($null -ne $s -and -not ($s -is [System.Collections.IEnumerable] -and -not ($s -is [string]))) {
            $vals.Add([string]$s)
        }
        elseif ($null -ne $s -and $s -is [string]) {
            $vals.Add($s)
        }
    }
    return @($vals.ToArray())
}

function Get-OpenAdFePropertyScalar {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)]$Object,
        [Parameter(Mandatory)][string]$Name
    )
    $vals = @(Get-OpenAdFePropertyValues -Object $Object -Name $Name)
    if ($vals.Count -eq 0) { return $null }
    return $vals[0]
}

function ConvertTo-OpenAdFeDirectoryRow {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)]$Object,
        [string]$ObjectClassHint
    )

    $dn = Get-OpenAdFePropertyScalar -Object $Object -Name 'DistinguishedName'
    if (-not $dn) { $dn = [string]$Object.DistinguishedName }

    $name = Get-OpenAdFePropertyScalar -Object $Object -Name 'Name'
    if (-not $name -and $dn) {
        $rdn = ($dn -split ',')[0]
        if ($rdn -match '^[^=]+=(.+)$') { $name = $Matches[1] }
    }

    $classes = @(Get-OpenAdFePropertyValues -Object $Object -Name 'ObjectClass')
    $objectClass = $ObjectClassHint
    if (-not $objectClass -and $classes.Count -gt 0) {
        $objectClass = $classes[-1]
    }

    # userAccountControl reaches us in one of three shapes, and only the last
    # one is a plain number: PSOpenAD's attribute transformer normally hands
    # back a decoded [UserAccountControl] flags enum, which stringifies as
    # "AccountDisable, NormalAccount, DontExpirePassword". Testing only for
    # digits left `enabled` null for every account, so no account ever showed
    # as disabled in the UI.
    $uac = Get-OpenAdFePropertyScalar -Object $Object -Name 'UserAccountControl'
    $enabled = $null
    if ($null -ne $uac) {
        $ACCOUNT_DISABLE = 2  # ADS_UF_ACCOUNTDISABLE
        $uacText = [string]$uac
        if ($uac -is [System.Enum]) {
            $enabled = -not ([int]$uac -band $ACCOUNT_DISABLE)
        }
        elseif ($uacText -match '^\d+$') {
            $enabled = -not ([int]$uacText -band $ACCOUNT_DISABLE)
        }
        elseif ($uacText) {
            # Match the whole flag name, never a substring of a longer one.
            $enabled = $uacText -notmatch '(^|,\s*)AccountDisable(\s*,|$)'
        }
    }

    [pscustomobject]@{
        distinguishedName = $dn
        name              = $name
        objectClass       = $objectClass
        samAccountName    = Get-OpenAdFePropertyScalar -Object $Object -Name 'SAMAccountName'
        displayName       = Get-OpenAdFePropertyScalar -Object $Object -Name 'DisplayName'
        description       = Get-OpenAdFePropertyScalar -Object $Object -Name 'Description'
        userPrincipalName = Get-OpenAdFePropertyScalar -Object $Object -Name 'UserPrincipalName'
        mail              = Get-OpenAdFePropertyScalar -Object $Object -Name 'Mail'
        objectGuid        = Get-OpenAdFePropertyScalar -Object $Object -Name 'ObjectGuid'
        whenCreated       = Get-OpenAdFePropertyScalar -Object $Object -Name 'WhenCreated'
        whenChanged       = Get-OpenAdFePropertyScalar -Object $Object -Name 'WhenChanged'
        groupType         = Get-OpenAdFePropertyScalar -Object $Object -Name 'GroupType'
        enabled           = $enabled
    }
}

function ConvertTo-OpenAdFeObjectDetail {
    [CmdletBinding()]
    param([Parameter(Mandatory)]$Object)

    $row = ConvertTo-OpenAdFeDirectoryRow -Object $Object
    $attrs = [ordered]@{}
    foreach ($prop in @($Object.PSObject.Properties)) {
        if ($prop.MemberType -ne 'NoteProperty' -and $prop.MemberType -ne 'Property') { continue }
        $name = [string]$prop.Name
        if ($name -in @('PSComputerName', 'RunspaceId', 'PSShowComputerName')) { continue }
        $vals = @(Get-OpenAdFePropertyValues -Object $Object -Name $name)
        if ($vals.Count -eq 0) {
            $attrs[$name] = $null
        }
        elseif ($vals.Count -eq 1) {
            $attrs[$name] = $vals[0]
        }
        else {
            $attrs[$name] = $vals
        }
    }

    [pscustomobject]@{
        summary    = $row
        attributes = [pscustomobject]$attrs
    }
}
