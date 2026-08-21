#!/usr/bin/env pwsh
#requires -Version 7.4
<#
.SYNOPSIS
  Long-running JSON-lines sidecar bridging Tauri <-> PSOpenAD.

.DESCRIPTION
  Reads one JSON request per stdin line; writes one JSON response per stdout line.
  Keeps multiple named domain sessions in-process.

  Protocol:
    {"id":"1","method":"ping"}
    {"id":"1","ok":true,"result":{...}}
    {"id":"1","ok":false,"error":"..."}
#>
[CmdletBinding()]
param(
    [string]$ModulePath
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$SidecarRoot = $PSScriptRoot
. (Join-Path $SidecarRoot 'lib/ConnectionLadder.ps1')
. (Join-Path $SidecarRoot 'lib/Attributes.ps1')
. (Join-Path $SidecarRoot 'lib/KerberosSealed.ps1')
. (Join-Path $SidecarRoot 'lib/SharedSecretVault.ps1')

function Write-SidecarLog {
    param([string]$Message)
    [Console]::Error.WriteLine("[sidecar] $Message")
}

function Import-OpenAdFeModule {
    param([string]$PreferredPath)

    $ProgressPreference = 'SilentlyContinue'

    function Test-BuiltModulePath {
        param([string]$Path)
        if (-not $Path -or -not (Test-Path -LiteralPath $Path)) { return $false }
        $dir = if ($Path -like '*.psd1') { Split-Path $Path -Parent } else { $Path }
        $dll = Join-Path $dir 'bin/net8.0/PSOpenAD.dll'
        $dllBeside = Join-Path $dir 'PSOpenAD.dll'
        $modDll = Join-Path $dir 'bin/net8.0/PSOpenAD.Module.dll'
        return (Test-Path -LiteralPath $dll) -or (Test-Path -LiteralPath $dllBeside) -or (Test-Path -LiteralPath $modDll)
    }

    $repoRoot = Split-Path $SidecarRoot -Parent
    $ordered = [System.Collections.Generic.List[string]]::new()
    if ($PreferredPath) { $ordered.Add($PreferredPath) }
    if ($env:PSOPENAD_MODULE_PATH) { $ordered.Add($env:PSOPENAD_MODULE_PATH) }
    # Prefer this repo's patched build (TargetSpnHost + deferred DC discovery)
    $ordered.Add((Join-Path $repoRoot 'vendor/PSOpenAD/PSOpenAD.psd1'))

    foreach ($path in $ordered) {
        if (Test-BuiltModulePath $path) {
            Import-Module -Name $path -Force -ErrorAction Stop
            Write-SidecarLog "Loaded PSOpenAD from $path"
            return
        }
    }

    $installed = Get-Module -ListAvailable PSOpenAD -ErrorAction SilentlyContinue |
        Sort-Object Version -Descending |
        Select-Object -First 1
    if ($installed) {
        Import-Module -Name $installed.Path -Force -ErrorAction Stop
        Write-SidecarLog "Loaded PSOpenAD $($installed.Version) from $($installed.Path) (gallery - may lack TargetSpnHost)"
        return
    }

    throw "PSOpenAD not found. Build with: pwsh -File ./PSOpenAD/build.ps1 -Task Build -Configuration Release && copy output to vendor/PSOpenAD"
}

$script:ModuleLoaded = $false
$script:ModulePreferredPath = $ModulePath

function Initialize-OpenAdFeModule {
    if ($script:ModuleLoaded) { return }
    Write-SidecarLog "Loading PSOpenAD (first use)..."
    Import-OpenAdFeModule -PreferredPath $script:ModulePreferredPath
    $script:ModuleLoaded = $true
}

# domainKey -> @{ Session=...; Meta=... }
$script:Sessions = @{}

function Get-ParamValue {
    param($Params, [string]$Name, $Default = $null)
    if ($null -eq $Params) { return $Default }
    $prop = $Params.PSObject.Properties[$Name]
    if (-not $prop) { return $Default }
    if ($null -eq $prop.Value -or $prop.Value -eq '') { return $Default }
    return $prop.Value
}

function Get-SessionOrThrow {
    param([Parameter(Mandatory)][string]$DomainKey)
    if (-not $script:Sessions.ContainsKey($DomainKey)) {
        throw "No session for domain '$DomainKey'. Connect first."
    }
    return $script:Sessions[$DomainKey].Session
}

function New-CredentialFromParams {
    param($Params)
    $user = [string](Get-ParamValue $Params 'username')
    $pass = Get-ParamValue $Params 'password'
    if (-not $user) { throw 'username is required' }
    if ($null -eq $pass) { throw 'password is required' }
    $secure = ConvertTo-SecureString -String ([string]$pass) -AsPlainText -Force
    return [pscredential]::new($user, $secure)
}

function Invoke-MethodConnect {
    param($Params)

    $server = [string](Get-ParamValue $Params 'server')
    if (-not $server) { throw 'server is required' }

    $domainKey = [string](Get-ParamValue $Params 'domainKey' $server)
    $label = [string](Get-ParamValue $Params 'label' $domainKey)

    # A saved connection sends its vault reference instead of a password: the
    # secret is resolved here and never travels to or from the frontend.
    $savedId = [string](Get-ParamValue $Params 'savedConnectionId' '')
    $cred = $null
    if ($savedId -and -not (Get-ParamValue $Params 'password')) {
        $cred = Get-OpenAdFeConnectionCredential -Id $savedId
        if (-not $cred) {
            throw "No stored password for saved connection '$savedId'. Reconnect and save it again."
        }
        Write-SidecarLog "connect: resolved credential for saved connection '$savedId' from the vault"
    }
    else {
        $cred = New-CredentialFromParams -Params $Params
    }
    $forceStep = Get-ParamValue $Params 'forceStep'
    $defaultDomain = [string](Get-ParamValue $Params 'defaultDomain' '')
    $channel = ([string](Get-ParamValue $Params 'channel' 'standard')).ToLowerInvariant()
    if ($channel -eq 'ldap') { $channel = 'standard' }

    $ports = $null
    $portsRaw = Get-ParamValue $Params 'ports'
    if ($portsRaw) {
        if ($portsRaw -is [string]) {
            $ports = @(($portsRaw -split '[,\s]+') | Where-Object { $_ } | ForEach-Object { [int]$_ })
        }
        else {
            $ports = @($portsRaw | ForEach-Object { [int]$_ })
        }
    }

    if ($script:Sessions.ContainsKey($domainKey)) {
        try { Remove-OpenADSession -Session $script:Sessions[$domainKey].Session -ErrorAction SilentlyContinue } catch {}
        $script:Sessions.Remove($domainKey)
    }

    $bindUser = [string](Get-ParamValue $Params 'username')
    $attempts = @()
    $stepName = $null
    $port = 0
    $authType = 'Simple'
    $startTls = $false
    $useTls = $false
    $session = $null

    if ($channel -eq 'kerberosseal' -or $channel -eq 'kerberos' -or $channel -eq 'password') {
        $dcFqdn = [string](Get-ParamValue $Params 'dcFqdn' '')
        $realm = [string](Get-ParamValue $Params 'realm' '')
        $domainDns = [string](Get-ParamValue $Params 'domainDns' $realm)
        # If realm not provided, do a quick Simple bind first to learn RootDSE, then reopen Kerberos
        if (-not $realm -or -not $dcFqdn) {
            Write-SidecarLog 'Kerberos seal: probing RootDSE via standard ladder to learn dnsHostName/realm...'
            $probe = Connect-OpenAdFeWithLadder -ComputerName $server -Credential $cred -DefaultDomain $defaultDomain
            try {
                $probeRoot = Get-OpenADRootDSE -Session $probe.Session -ErrorAction Stop
                if (-not $dcFqdn) {
                    $dcFqdn = Get-OpenAdFePropertyScalar -Object $probeRoot -Name 'DnsHostName'
                }
                if (-not $realm) {
                    $nc = Get-OpenAdFePropertyScalar -Object $probeRoot -Name 'DefaultNamingContext'
                    $realm = ConvertTo-OpenAdFeRealmFromNamingContext -DefaultNamingContext $nc
                    if (-not $domainDns) { $domainDns = $realm }
                }
            }
            finally {
                try { Remove-OpenADSession -Session $probe.Session -ErrorAction SilentlyContinue } catch {}
            }
        }

        $session = New-OpenAdFeKerberosSealedSession `
            -DcIp $server `
            -DcFqdn $dcFqdn `
            -BindCred (ConvertTo-OpenAdFeLdapCredential -Credential $cred -DefaultDomain $defaultDomain) `
            -Realm $realm `
            -DomainDns $domainDns
        $stepName = 'Kerberos sign+seal :389'
        $port = 389
        $authType = if ($session.PSObject.Properties['_AppAuth']) { [string]$session._AppAuth } else { 'Kerberos-seal' }
        $bindUser = (ConvertTo-OpenAdFeLdapCredential -Credential $cred -DefaultDomain $defaultDomain).UserName
        $attempts = @([pscustomobject]@{ step = $stepName; ok = $true; error = $null })
    }
    else {
        $connectParams = @{
            ComputerName  = $server
            Credential    = $cred
            DefaultDomain = $defaultDomain
        }
        if ($ports) { $connectParams['Ports'] = $ports }
        if ($forceStep) { $connectParams['ForceStepName'] = [string]$forceStep }

        $connected = Connect-OpenAdFeWithLadder @connectParams
        $session = $connected.Session
        $stepName = $connected.Step.Name
        $port = [int]$connected.Step.Port
        $authType = [string]$connected.Step.AuthType
        $startTls = [bool]$connected.Step.StartTLS
        $useTls = [bool]$connected.Step.UseTLS
        $attempts = @($connected.Attempts)
        if ($connected.PSObject.Properties['BindUserName'] -and $connected.BindUserName) {
            $bindUser = [string]$connected.BindUserName
        }
    }

    $root = Get-OpenADRootDSE -Session $session -ErrorAction Stop
    $defaultNc = Get-OpenAdFePropertyScalar -Object $root -Name 'DefaultNamingContext'
    $dnsHost = Get-OpenAdFePropertyScalar -Object $root -Name 'DnsHostName'
    $dsService = Get-OpenAdFePropertyScalar -Object $root -Name 'DsServiceName'
    $who = [string](Get-ParamValue $Params 'username')
    try {
        $whoObj = Get-OpenADWhoami -Session $session -ErrorAction Stop
        if ($null -ne $whoObj) {
            $idProp = $whoObj.PSObject.Properties['Identity']
            $userProp = $whoObj.PSObject.Properties['UserName']
            if ($idProp -and $null -ne $idProp.Value) {
                $who = [string]$idProp.Value
            }
            elseif ($userProp -and $null -ne $userProp.Value) {
                $who = [string]$userProp.Value
            }
            else {
                $who = [string]$whoObj
            }
        }
    }
    catch {}

    $username = [string](Get-ParamValue $Params 'username')
    $meta = [ordered]@{
        domainKey            = $domainKey
        label                = $label
        server               = $server
        username             = $username
        bindUserName         = $bindUser
        channel              = $channel
        connectionStep       = $stepName
        port                 = $port
        authType             = $authType
        startTls             = $startTls
        useTls               = $useTls
        passwordCapable      = ($startTls -or $useTls -or ($authType -match 'seal|Kerberos|Negotiate') -or ($channel -match 'kerberos|password'))
        defaultNamingContext = $defaultNc
        dnsHostName          = $dnsHost
        dsServiceName        = $dsService
        whoami               = $who
        attempts             = @($attempts | ForEach-Object {
            [ordered]@{ step = $_.step; ok = [bool]$_.ok; error = $_.error }
        })
    }

    $script:Sessions[$domainKey] = @{
        Session  = $session
        Meta     = [pscustomobject]$meta
        CredUser = $bindUser
        Cred     = $cred
    }

    return [pscustomobject]$meta
}

function Invoke-MethodProbePasswordChannel {
    param($Params)
    $server = [string](Get-ParamValue $Params 'server')
    if (-not $server) { throw 'server is required' }
    $cred = New-CredentialFromParams -Params $Params
    $defaultDomain = [string](Get-ParamValue $Params 'defaultDomain' '')
    $bindCred = ConvertTo-OpenAdFeLdapCredential -Credential $cred -DefaultDomain $defaultDomain

    $dcFqdn = [string](Get-ParamValue $Params 'dcFqdn' '')
    $realm = [string](Get-ParamValue $Params 'realm' '')
    $domainDns = [string](Get-ParamValue $Params 'domainDns' '')

    if (-not $realm -or -not $dcFqdn) {
        $probe = Connect-OpenAdFeWithLadder -ComputerName $server -Credential $cred -DefaultDomain $defaultDomain
        try {
            $root = Get-OpenADRootDSE -Session $probe.Session -ErrorAction Stop
            if (-not $dcFqdn) { $dcFqdn = Get-OpenAdFePropertyScalar -Object $root -Name 'DnsHostName' }
            if (-not $realm) {
                $nc = Get-OpenAdFePropertyScalar -Object $root -Name 'DefaultNamingContext'
                $realm = ConvertTo-OpenAdFeRealmFromNamingContext -DefaultNamingContext $nc
            }
            if (-not $domainDns) { $domainDns = $realm }
        }
        finally {
            try { Remove-OpenADSession -Session $probe.Session -ErrorAction SilentlyContinue } catch {}
        }
    }

    return (Test-OpenAdFePasswordChannel -DcIp $server -DcFqdn $dcFqdn -BindCred $bindCred -Realm $realm -DomainDns $domainDns)
}

function Invoke-MethodSetPassword {
    param($Params)
    $domainKey = [string](Get-ParamValue $Params 'domainKey')
    $identity = [string](Get-ParamValue $Params 'identity')
    $password = Get-ParamValue $Params 'password'
    if (-not $domainKey) { throw 'domainKey is required' }
    if (-not $identity) { throw 'identity (DN or sAMAccountName) is required' }
    if ($null -eq $password -or [string]$password -eq '') { throw 'password is required' }

    $entry = $script:Sessions[$domainKey]
    if (-not $entry) { throw "No session for domain '$domainKey'." }

    $meta = $entry.Meta
    $session = $entry.Session

    # Prefer an already confidential session (LDAPS / StartTLS / Kerberos seal).
    # Plain Simple :389 cannot carry unicodePwd - open the Kerberos
    # sign+seal channel for the write only (kinit + kgetcred + TargetSpnHost).
    $isConfidential = [bool]$meta.passwordCapable -or
        [bool]$meta.startTls -or
        [bool]$meta.useTls -or
        ($meta.authType -match 'seal|Kerberos|Negotiate')
    $channelUsed = if ($meta.useTls) { 'ldaps' } elseif ($meta.startTls) { 'starttls' } elseif ($isConfidential) { 'session' } else { 'none' }

    if (-not $isConfidential) {
        if (-not $entry.Cred) { throw 'Cannot open password channel - credential not retained for this session.' }
        $dcFqdn = [string]$meta.dnsHostName
        if (-not $dcFqdn) {
            throw 'Cannot open Kerberos seal - dnsHostName unknown on this session (reconnect and retry).'
        }
        $realm = ConvertTo-OpenAdFeRealmFromNamingContext -DefaultNamingContext ([string]$meta.defaultNamingContext)
        if (-not $realm) {
            throw 'Cannot open Kerberos seal - could not derive realm from defaultNamingContext.'
        }
        Write-SidecarLog "Opening Kerberos sealed session for unicodePwd on $identity (realm=$realm spn=ldap/$dcFqdn)"
        $seal = New-OpenAdFeKerberosSealedSession `
            -DcIp ([string]$meta.server) `
            -DcFqdn $dcFqdn `
            -BindCred (ConvertTo-OpenAdFeLdapCredential -Credential $entry.Cred -DefaultDomain '') `
            -Realm $realm `
            -DomainDns $realm
        $channelUsed = if ($seal.PSObject.Properties['_AppAuth']) { [string]$seal._AppAuth } else { 'Kerberos-seal' }
        try {
            Set-OpenAdFeAccountPassword -Session $seal -Identity $identity -Password ([string]$password)
        }
        finally {
            try { Remove-OpenADSession -Session $seal -ErrorAction SilentlyContinue } catch {}
        }
    }
    else {
        Set-OpenAdFeAccountPassword -Session $session -Identity $identity -Password ([string]$password)
    }

    return [pscustomobject]@{
        ok       = $true
        identity = $identity
        channel  = $channelUsed
    }
}

function Invoke-MethodDisconnect {
    param($Params)
    $domainKey = [string](Get-ParamValue $Params 'domainKey')
    if (-not $domainKey) { throw 'domainKey is required' }
    if ($script:Sessions.ContainsKey($domainKey)) {
        try { Remove-OpenADSession -Session $script:Sessions[$domainKey].Session -ErrorAction SilentlyContinue } catch {}
        $script:Sessions.Remove($domainKey)
    }
    return [pscustomobject]@{ disconnected = $true; domainKey = $domainKey }
}

function Invoke-MethodListSessions {
    $items = @()
    foreach ($key in @($script:Sessions.Keys)) {
        $items += $script:Sessions[$key].Meta
    }
    return $items
}

# A referral means "that name is not mine to answer for" - the server is
# pointing at another directory. PSOpenAD surfaces it raw:
#
#   Referral - 0000202B: RefErr: DSID-03154294, data 0, 1 access points
#
# which tells a reader nothing they can act on. Where a forest splits accounts
# across domains - one for staff, a child domain for students or service
# accounts, a common enough shape - it is not even a rare case. Name the domain
# the object actually lives in, and say what to do about it.
function Test-OpenAdFePartitionInForest {
    <#
    .SYNOPSIS
        Is the naming context holding this DN a partition of the forest we are
        connected to? Answers whether the Global Catalog could help.
    #>
    param([string]$DomainKey, [string]$TargetDn)

    if (-not $DomainKey -or -not $script:Sessions.ContainsKey($DomainKey)) { return $false }
    $nc = (($TargetDn -split ',') | Where-Object { $_ -match '^DC=' }) -join ','
    if (-not $nc) { return $false }

    try {
        $session = $script:Sessions[$DomainKey].Session
        $root = Get-OpenADRootDSE -Session $session -ErrorAction Stop
        $configNc = [string](Get-OpenAdFePropertyScalar -Object $root -Name 'ConfigurationNamingContext')
        if (-not $configNc) { return $false }

        $escaped = ConvertTo-EscapedLdapFilterValue $nc
        $found = @(Get-OpenADObject -Session $session -SearchBase "CN=Partitions,$configNc" `
                -SearchScope OneLevel -LDAPFilter "(&(objectClass=crossRef)(nCName=$escaped))" `
                -Property 'nCName' -ErrorAction Stop | Select-Object -First 1)
        return [bool]$found.Count
    }
    catch {
        # Only used to choose wording, so a failure here must not replace a
        # useful message with a worse one.
        return $false
    }
}

function Resolve-OpenAdFeReferralError {
    param(
        [Parameter(Mandatory)]$ErrorRecord,
        [string]$TargetDn,
        [string]$DomainKey
    )

    $message = [string]$ErrorRecord.Exception.Message
    if ($message -notmatch 'Referral|0000202B|RefErr') { return $null }

    $wanted = ConvertTo-OpenAdFeRealmFromNamingContext -DefaultNamingContext $TargetDn
    $here = ''
    if ($DomainKey -and $script:Sessions.ContainsKey($DomainKey)) {
        $here = ConvertTo-OpenAdFeRealmFromNamingContext `
            -DefaultNamingContext ([string]$script:Sessions[$DomainKey].Meta.defaultNamingContext)
    }

    if (-not $wanted) {
        return "This server is not authoritative for that part of the directory, and referrals are not followed. $message"
    }
    if ($here -and $wanted -eq $here) {
        # Same domain but still referred: a subordinate reference, so the DN is
        # in another partition of this forest rather than another directory.
        return "'$TargetDn' lives in another partition of $here that this domain controller does not hold. Connect to a domain controller for that partition."
    }

    # Ask the directory rather than inferring it from the DNS name: a name that
    # looks like a child domain can belong to a separate forest, and a trusted
    # forest can carry any name at all. CN=Partitions holds a crossRef for every
    # partition of THIS forest, so a hit means same forest and a miss means
    # another one. Verified against a real multi-domain forest: the child domain
    # is a partition of the parent's forest, and the Global Catalog serves it.
    $sameForest = Test-OpenAdFePartitionInForest -DomainKey $DomainKey -TargetDn $TargetDn

    $lead = if ($here) {
        "'$TargetDn' is in $wanted, but this connection is to $here."
    }
    else {
        "'$TargetDn' is in $wanted, which this connection does not serve."
    }

    $tail = if ($sameForest) {
        # Same forest, so the Global Catalog is the cheaper answer than a second
        # connection - it holds a partial copy of every domain in the forest.
        "Connect to a domain controller for $wanted, or reconnect on the Global Catalog port (3268), which serves every domain in the forest."
    }
    else {
        # Worth being explicit: the Global Catalog is the obvious next guess and
        # it does not work across a trust, because a GC only replicates its own
        # forest.
        "They are separate directories, so the Global Catalog will not show it either. Add a connection to a $wanted domain controller."
    }
    return "$lead $tail"
}

function Invoke-MethodGetChildren {
    param($Params)
    $domainKey = [string](Get-ParamValue $Params 'domainKey')
    $session = Get-SessionOrThrow -DomainKey $domainKey
    $searchBase = [string](Get-ParamValue $Params 'searchBase')
    if (-not $searchBase) {
        $searchBase = $script:Sessions[$domainKey].Meta.defaultNamingContext
    }

    # Bounded, because this ran unbounded and timed out on a container holding
    # a whole state's student accounts: one level of OU=Accounts in the DE
    # services domain is hundreds of thousands of children, and the server has
    # to walk all of them to find the sub-OUs. Select-Object -First stops the
    # pipeline, so PSOpenAD stops asking for pages rather than reading the lot.
    # A tree node showing more than this many child containers is unusable as a
    # tree anyway.
    $limit = [int](Get-ParamValue $Params 'limit' 1000)

    $filter = '(|(objectClass=organizationalUnit)(objectClass=container)(objectClass=builtinDomain)(objectClass=domainDNS))'
    try {
        $objects = @(Get-OpenADObject -Session $session -SearchBase $searchBase -SearchScope OneLevel `
                -LDAPFilter $filter -Property @('name', 'objectClass', 'distinguishedName') -ErrorAction Stop |
            Select-Object -First $limit)
    }
    catch {
        $better = Resolve-OpenAdFeReferralError -ErrorRecord $_ -TargetDn $searchBase -DomainKey $domainKey
        if ($better) { throw $better }
        throw
    }

    return @($objects | ForEach-Object { ConvertTo-OpenAdFeDirectoryRow -Object $_ })
}

function Invoke-MethodSearch {
    param($Params)
    $domainKey = [string](Get-ParamValue $Params 'domainKey')
    $session = Get-SessionOrThrow -DomainKey $domainKey
    $kind = ([string](Get-ParamValue $Params 'kind' 'user')).ToLowerInvariant()

    $searchBase = [string](Get-ParamValue $Params 'searchBase')
    if (-not $searchBase) {
        $searchBase = $script:Sessions[$domainKey].Meta.defaultNamingContext
    }

    $query = [string](Get-ParamValue $Params 'query' '')
    $ldapFilter = [string](Get-ParamValue $Params 'ldapFilter' '')
    $limit = [int](Get-ParamValue $Params 'limit' 200)

    $props = @('name', 'objectClass', 'distinguishedName', 'sAMAccountName', 'displayName', 'description', 'userPrincipalName', 'mail', 'objectGUID')

    $objects = @()
    switch ($kind) {
        'user' {
            if (-not $ldapFilter) {
                if ($query) {
                    $q = ConvertTo-EscapedLdapFilterValue $query
                    $ldapFilter = "(&(objectCategory=person)(objectClass=user)(|(cn=*$q*)(sAMAccountName=*$q*)(displayName=*$q*)(userPrincipalName=*$q*)))"
                }
                else {
                    $ldapFilter = '(&(objectCategory=person)(objectClass=user))'
                }
            }
            $objects = @(Get-OpenADUser -Session $session -SearchBase $searchBase -SearchScope Subtree `
                    -LDAPFilter $ldapFilter -Property $props -ErrorAction Stop | Select-Object -First $limit)
            $hint = 'user'
        }
        'group' {
            if (-not $ldapFilter) {
                if ($query) {
                    $q = ConvertTo-EscapedLdapFilterValue $query
                    $ldapFilter = "(&(objectClass=group)(|(cn=*$q*)(sAMAccountName=*$q*)(displayName=*$q*)))"
                }
                else {
                    $ldapFilter = '(objectClass=group)'
                }
            }
            $objects = @(Get-OpenADGroup -Session $session -SearchBase $searchBase -SearchScope Subtree `
                    -LDAPFilter $ldapFilter -Property $props -ErrorAction Stop | Select-Object -First $limit)
            $hint = 'group'
        }
        'computer' {
            if (-not $ldapFilter) {
                if ($query) {
                    $q = ConvertTo-EscapedLdapFilterValue $query
                    $ldapFilter = "(&(objectClass=computer)(|(cn=*$q*)(sAMAccountName=*$q*)(dNSHostName=*$q*)))"
                }
                else {
                    $ldapFilter = '(objectClass=computer)'
                }
            }
            $objects = @(Get-OpenADComputer -Session $session -SearchBase $searchBase -SearchScope Subtree `
                    -LDAPFilter $ldapFilter -Property $props -ErrorAction Stop | Select-Object -First $limit)
            $hint = 'computer'
        }
        default {
            if (-not $ldapFilter) {
                if ($query) {
                    $q = ConvertTo-EscapedLdapFilterValue $query
                    $ldapFilter = "(|(cn=*$q*)(name=*$q*)(sAMAccountName=*$q*))"
                }
                else {
                    $ldapFilter = '(objectClass=*)'
                }
            }
            $objects = @(Get-OpenADObject -Session $session -SearchBase $searchBase -SearchScope Subtree `
                    -LDAPFilter $ldapFilter -Property $props -ErrorAction Stop | Select-Object -First $limit)
            $hint = $null
        }
    }

    return @($objects | ForEach-Object { ConvertTo-OpenAdFeDirectoryRow -Object $_ -ObjectClassHint $hint })
}

function ConvertTo-EscapedLdapFilterValue {
    param([string]$Value)
    if ($null -eq $Value) { return '' }
    $Value = $Value -replace '\\', '\5c'
    $Value = $Value -replace '\*', '\2a'
    $Value = $Value -replace '\(', '\28'
    $Value = $Value -replace '\)', '\29'
    $Value = $Value -replace "`0", '\00'
    return $Value
}

function Invoke-MethodGetGroupMembers {
    param($Params)
    $domainKey = [string](Get-ParamValue $Params 'domainKey')
    $session = Get-SessionOrThrow -DomainKey $domainKey
    $identity = [string](Get-ParamValue $Params 'identity')
    if (-not $identity) { throw 'identity (group DN or sAMAccountName) is required' }

    # Prefer Get-OpenADGroupMember for ranged member attribute
    $members = @(Get-OpenADGroupMember -Session $session -Identity $identity -ErrorAction Stop)
    return @($members | ForEach-Object { ConvertTo-OpenAdFeDirectoryRow -Object $_ })
}

function Invoke-MethodListContents {
    param($Params)
    $domainKey = [string](Get-ParamValue $Params 'domainKey')
    $session = Get-SessionOrThrow -DomainKey $domainKey
    $searchBase = [string](Get-ParamValue $Params 'searchBase')
    if (-not $searchBase) {
        $searchBase = $script:Sessions[$domainKey].Meta.defaultNamingContext
    }

    $filterKind = ([string](Get-ParamValue $Params 'filter' 'all')).ToLowerInvariant()
    $limit = [int](Get-ParamValue $Params 'limit' 500)

    $props = @(
        'name', 'objectClass', 'distinguishedName', 'sAMAccountName', 'displayName',
        'description', 'userPrincipalName', 'mail', 'objectGUID', 'userAccountControl',
        'whenCreated', 'whenChanged', 'groupType'
    )

    # ADUC-style: show directory objects in the selected container (one level)
    # An explicit LDAP filter wins over the object-class dropdown: ADUC's
    # Filter Options works the same way and it is far more powerful than a
    # fixed list of classes.
    $customFilter = [string](Get-ParamValue $Params 'ldapFilter' '')
    if ($customFilter) {
        return (Get-OpenAdFeContentsPage -Session $session -SearchBase $searchBase `
                -Filter $customFilter -Props $props -Limit $limit -DomainKey $domainKey)
    }

    $ldapFilter = switch ($filterKind) {
        'user' { '(&(objectCategory=person)(objectClass=user))' }
        'group' { '(objectClass=group)' }
        'computer' { '(objectClass=computer)' }
        # builtinDomain and domainDNS must be here as well as in getChildren's
        # filter, or CN=Builtin appears in the console tree and is then missing
        # from the result pane for the same container. ADUC shows it in both.
        'ou' { '(|(objectClass=organizationalUnit)(objectClass=container)(objectClass=builtinDomain)(objectClass=domainDNS))' }
        default {
            '(|(objectClass=user)(objectClass=group)(objectClass=computer)(objectClass=organizationalUnit)(objectClass=container)(objectClass=builtinDomain)(objectClass=domainDNS)(objectClass=contact)(objectClass=printQueue)(objectClass=volume)(objectClass=msDS-GroupManagedServiceAccount))'
        }
    }

    return (Get-OpenAdFeContentsPage -Session $session -SearchBase $searchBase `
            -Filter $ldapFilter -Props $props -Limit $limit -DomainKey $domainKey)
}

# Reporting "500 object(s)" for a container holding 200,000 is not a small
# inaccuracy - it is the wrong answer to the question the status bar appears to
# be answering, and the reader has no way to tell. Ask for one row past the cap:
# if it arrives, the cap was hit, and the extra row is discarded.
function Get-OpenAdFeContentsPage {
    param(
        [Parameter(Mandatory)]$Session,
        [Parameter(Mandatory)][string]$SearchBase,
        [Parameter(Mandatory)][string]$Filter,
        [Parameter(Mandatory)][string[]]$Props,
        [Parameter(Mandatory)][int]$Limit,
        [string]$DomainKey
    )
    try {
        $found = @(Get-OpenADObject -Session $Session -SearchBase $SearchBase -SearchScope OneLevel `
                -LDAPFilter $Filter -Property $Props -ErrorAction Stop |
            Select-Object -First ($Limit + 1))
    }
    catch {
        $better = Resolve-OpenAdFeReferralError -ErrorRecord $_ -TargetDn $SearchBase -DomainKey $DomainKey
        if ($better) { throw $better }
        throw
    }

    $truncated = $found.Count -gt $Limit
    if ($truncated) { $found = @($found | Select-Object -First $Limit) }

    return [pscustomobject]@{
        rows      = [object[]]@($found | ForEach-Object { ConvertTo-OpenAdFeDirectoryRow -Object $_ })
        truncated = $truncated
        limit     = $Limit
    }
}

function Invoke-MethodGetObject {
    param($Params)
    $domainKey = [string](Get-ParamValue $Params 'domainKey')
    $session = Get-SessionOrThrow -DomainKey $domainKey
    $identity = [string](Get-ParamValue $Params 'identity')
    if (-not $identity) { throw 'identity (DN) is required' }

    # Everything the object actually has, not a hardcoded list. ADUC's
    # Attribute Editor shows the whole object, and a fixed list silently hides
    # attributes - proxyAddresses was invisible here, so an edit to it appeared
    # to do nothing. This is one object, so the extra bytes do not matter.
    try {
        $obj = Get-OpenADObject -Session $session -Identity $identity -Property '*' -ErrorAction Stop
    }
    catch {
        $better = Resolve-OpenAdFeReferralError -ErrorRecord $_ -TargetDn $identity -DomainKey $domainKey
        if ($better) { throw $better }
        throw
    }
    return (ConvertTo-OpenAdFeObjectDetail -Object $obj)
}

function Invoke-MethodGetRootDse {
    param($Params)
    $domainKey = [string](Get-ParamValue $Params 'domainKey')
    $session = Get-SessionOrThrow -DomainKey $domainKey
    $root = Get-OpenADRootDSE -Session $session -ErrorAction Stop
    return [pscustomobject]@{
        defaultNamingContext = Get-OpenAdFePropertyScalar -Object $root -Name 'DefaultNamingContext'
        configurationNamingContext = Get-OpenAdFePropertyScalar -Object $root -Name 'ConfigurationNamingContext'
        schemaNamingContext = Get-OpenAdFePropertyScalar -Object $root -Name 'SchemaNamingContext'
        dnsHostName = Get-OpenAdFePropertyScalar -Object $root -Name 'DnsHostName'
        domainControllerFunctionality = Get-OpenAdFePropertyScalar -Object $root -Name 'DomainControllerFunctionality'
        domainFunctionality = Get-OpenAdFePropertyScalar -Object $root -Name 'DomainFunctionality'
        forestFunctionality = Get-OpenAdFePropertyScalar -Object $root -Name 'ForestFunctionality'
    }
}

function Invoke-MethodLadder {
    return @(Get-OpenAdFeConnectionLadder | ForEach-Object {
        [ordered]@{
            name     = $_.Name
            port     = $_.Port
            startTls = [bool]$_.StartTLS
            useTls   = [bool]$_.UseTLS
            authType = $_.AuthType
            skipCert = [bool]$_.SkipCert
        }
    })
}

function Invoke-SidecarRequest {
    param($Request)

    $method = [string](Get-ParamValue $Request 'method')
    $params = Get-ParamValue $Request 'params'
    if ($null -eq $params) { $params = [pscustomobject]@{} }

    switch ($method) {
        'ping' {
            $modVer = $null
            if ($script:ModuleLoaded) {
                $m = @(Get-Module PSOpenAD -ErrorAction SilentlyContinue) | Select-Object -First 1
                if ($null -ne $m) {
                    $verProp = $m.PSObject.Properties['Version']
                    if ($verProp) { $modVer = [string]$verProp.Value }
                }
            }
            return [pscustomobject]@{
                pong         = $true
                psVersion    = [string]$PSVersionTable.PSVersion
                module       = $modVer
                moduleLoaded = [bool]$script:ModuleLoaded
            }
        }
        'ladder' { return [object[]]@(Invoke-MethodLadder) }
        'connect' {
            Initialize-OpenAdFeModule
            return (Invoke-MethodConnect -Params $params)
        }
        'disconnect' {
            Initialize-OpenAdFeModule
            return (Invoke-MethodDisconnect -Params $params)
        }
        'listSessions' { return [object[]]@(Invoke-MethodListSessions) }
        'getChildren' {
            Initialize-OpenAdFeModule
            return [object[]]@(Invoke-MethodGetChildren -Params $params)
        }
        'listContents' {
            Initialize-OpenAdFeModule
            return [object[]]@(Invoke-MethodListContents -Params $params)
        }
        'search' {
            Initialize-OpenAdFeModule
            return [object[]]@(Invoke-MethodSearch -Params $params)
        }
        'getObject' {
            Initialize-OpenAdFeModule
            return (Invoke-MethodGetObject -Params $params)
        }
        'getGroupMembers' {
            Initialize-OpenAdFeModule
            return [object[]]@(Invoke-MethodGetGroupMembers -Params $params)
        }
        'getRootDse' {
            Initialize-OpenAdFeModule
            return (Invoke-MethodGetRootDse -Params $params)
        }
        'probePasswordChannel' {
            Initialize-OpenAdFeModule
            return (Invoke-MethodProbePasswordChannel -Params $params)
        }
        'setPassword' {
            Initialize-OpenAdFeModule
            return (Invoke-MethodSetPassword -Params $params)
        }
        'setAccountEnabled' {
            Initialize-OpenAdFeModule
            return (Invoke-MethodSetAccountEnabled -Params $params)
        }
        'moveObject' {
            Initialize-OpenAdFeModule
            return (Invoke-MethodMoveObject -Params $params)
        }
        'renameObject' {
            Initialize-OpenAdFeModule
            return (Invoke-MethodRenameObject -Params $params)
        }
        'removeObject' {
            Initialize-OpenAdFeModule
            return (Invoke-MethodRemoveObject -Params $params)
        }
        'newObject' {
            Initialize-OpenAdFeModule
            return (Invoke-MethodNewObject -Params $params)
        }
        'setAttributes' {
            Initialize-OpenAdFeModule
            return (Invoke-MethodSetAttributes -Params $params)
        }
        'addGroupMember' {
            Initialize-OpenAdFeModule
            return (Invoke-MethodGroupMember -Params $params -Action 'add')
        }
        'removeGroupMember' {
            Initialize-OpenAdFeModule
            return (Invoke-MethodGroupMember -Params $params -Action 'remove')
        }
        'vaultStatus' { return (Get-OpenAdFeVaultStatus) }
        'vaultSetConnectionSecret' {
            $id = [string](Get-ParamValue $params 'id')
            if (-not $id) { throw 'id is required' }
            # New-CredentialFromParams already turns the wire password into a
            # SecureString; keep it that way from here on.
            $name = Set-OpenAdFeConnectionSecret `
                -Id $id `
                -Credential (New-CredentialFromParams -Params $params) `
                -Label ([string](Get-ParamValue $params 'label' ''))
            return [pscustomobject]@{ id = $id; secretName = $name }
        }
        'vaultRemoveConnectionSecret' {
            $id = [string](Get-ParamValue $params 'id')
            if (-not $id) { throw 'id is required' }
            return [pscustomobject]@{ id = $id; removed = (Remove-OpenAdFeConnectionSecret -Id $id) }
        }
        'vaultHasConnectionSecret' {
            $id = [string](Get-ParamValue $params 'id')
            if (-not $id) { throw 'id is required' }
            return [pscustomobject]@{ id = $id; present = (Test-OpenAdFeConnectionSecret -Id $id) }
        }
        'getRecycleBinState' {
            Initialize-OpenAdFeModule
            $session = Get-SessionOrThrow -DomainKey ([string](Get-ParamValue $params 'domainKey'))
            return (Get-OpenAdFeRecycleBinState -Session $session)
        }
        'listDeletedObjects' {
            Initialize-OpenAdFeModule
            $session = Get-SessionOrThrow -DomainKey ([string](Get-ParamValue $params 'domainKey'))
            return [object[]]@(Get-OpenAdFeDeletedObjects -Session $session `
                    -SearchBase ([string](Get-ParamValue $params 'searchBase')) `
                    -Query ([string](Get-ParamValue $params 'query')) `
                    -Limit ([int](Get-ParamValue $params 'limit' 500)))
        }
        'restoreObject' {
            Initialize-OpenAdFeModule
            $session = Get-SessionOrThrow -DomainKey ([string](Get-ParamValue $params 'domainKey'))
            $identity = [string](Get-ParamValue $params 'identity')
            if (-not $identity) { throw 'identity (the deleted object DN) is required' }
            $restoreArgs = @{ Session = $session; Identity = $identity; PassThru = $true; ErrorAction = 'Stop' }
            $target = [string](Get-ParamValue $params 'targetPath')
            if ($target) { $restoreArgs['TargetPath'] = $target }
            $newName = [string](Get-ParamValue $params 'newName')
            if ($newName) { $restoreArgs['NewName'] = $newName }
            try {
                $restored = Restore-OpenADObject @restoreArgs
            }
            catch {
                # The server says "No such object" whether it is the deleted
                # object or its lastKnownParent that is missing, and the second
                # is far more common: an OU is emptied and deleted in one go, so
                # everything in it comes back to a parent that is not there.
                # Taken at face value the message sends the reader looking for
                # the wrong thing, so name the real cause and the way out.
                if (-not $target -and $_.Exception.Message -match 'No such object|NO_OBJECT') {
                    $parent = $null
                    try {
                        $d = Get-OpenADObject -Session $session -Identity $identity `
                            -Property 'lastKnownParent' -IncludeDeletedObjects -ErrorAction Stop
                        $parent = [string](Get-OpenAdFePropertyScalar -Object $d -Name 'LastKnownParent')
                    }
                    catch { $parent = $null }

                    if ($parent) {
                        $parentGone = $false
                        try { $null = Get-OpenADObject -Session $session -Identity $parent -ErrorAction Stop }
                        catch { $parentGone = $true }
                        if ($parentGone) {
                            $readable = ConvertTo-OpenAdFeReadableDeletedDn -Dn $parent
                            throw ("Cannot restore to '$readable' because that container has been deleted too. " +
                                'Use Restore To... to pick somewhere that still exists.')
                        }
                    }
                }
                throw
            }
            if (-not $restored) { throw "Restore reported no result for '$identity'." }
            return (ConvertTo-OpenAdFeDirectoryRow -Object $restored)
        }
        'getOperationsMasters' {
            Initialize-OpenAdFeModule
            $session = Get-SessionOrThrow -DomainKey ([string](Get-ParamValue $params 'domainKey'))
            $root = Get-OpenADRootDSE -Session $session -ErrorAction Stop
            $nc = Get-OpenAdFePropertyScalar -Object $root -Name 'DefaultNamingContext'
            $configNc = Get-OpenAdFePropertyScalar -Object $root -Name 'ConfigurationNamingContext'
            $schemaNc = Get-OpenAdFePropertyScalar -Object $root -Name 'SchemaNamingContext'

            # Each role is an fSMORoleOwner on a different object. The value is
            # the NTDS Settings DN, so the DC name is two RDNs up.
            $targets = [ordered]@{
                'PDC Emulator'          = $nc
                'RID Master'            = "CN=RID Manager$,CN=System,$nc"
                'Infrastructure Master' = "CN=Infrastructure,$nc"
                'Domain Naming Master'  = "CN=Partitions,$configNc"
                'Schema Master'         = $schemaNc
            }
            $rows = foreach ($role in $targets.Keys) {
                $owner = $null
                $holder = $null
                try {
                    $o = Get-OpenADObject -Session $session -Identity $targets[$role] -Property 'fSMORoleOwner' -ErrorAction Stop
                    $owner = Get-OpenAdFePropertyScalar -Object $o -Name 'FSMORoleOwner'
                    if ($owner) {
                        # CN=NTDS Settings,CN=<DC>,CN=Servers,... -> <DC>
                        $parts = @($owner -split ',')
                        if ($parts.Count -ge 2) { $holder = ($parts[1] -replace '^CN=', '') }
                    }
                }
                catch {
                    $holder = "unavailable: $(($_.Exception.Message -split "`n")[0])"
                }
                [pscustomobject]@{ role = $role; holder = $holder; ownerDn = $owner }
            }
            return [object[]]@($rows)
        }
        'getServiceAccounts' {
            Initialize-OpenAdFeModule
            $session = Get-SessionOrThrow -DomainKey ([string](Get-ParamValue $params 'domainKey'))
            $searchBase = [string](Get-ParamValue $params 'searchBase')
            $callArgs = @{ Session = $session; ErrorAction = 'Stop' }
            if ($searchBase) { $callArgs['SearchBase'] = $searchBase }
            $accounts = @(Get-OpenADServiceAccount -LDAPFilter '(objectClass=msDS-GroupManagedServiceAccount)' @callArgs)
            return [object[]]@($accounts | ForEach-Object {
                    ConvertTo-OpenAdFeDirectoryRow -Object $_ -ObjectClassHint 'msDS-GroupManagedServiceAccount'
                })
        }
        'resetComputerAccount' {
            Initialize-OpenAdFeModule
            $session = Get-SessionOrThrow -DomainKey ([string](Get-ParamValue $params 'domainKey'))
            $identity = [string](Get-ParamValue $params 'identity')
            if (-not $identity) { throw 'identity (DN) is required' }

            # ADUC's Reset Account sets the machine password back to its default
            # - the sAMAccountName without the trailing $, lower-cased - so the
            # computer can rejoin without being removed from the domain first.
            $o = Get-OpenADObject -Session $session -Identity $identity -Property 'sAMAccountName', 'objectClass' -ErrorAction Stop
            $classes = @(Get-OpenAdFePropertyValues -Object $o -Name 'ObjectClass')
            if ($classes -notcontains 'computer') {
                throw "'$identity' is not a computer account."
            }
            $sam = [string](Get-OpenAdFePropertyScalar -Object $o -Name 'SAMAccountName')
            if (-not $sam) { throw "Could not read sAMAccountName for '$identity'." }
            $default = ($sam -replace '\$$', '').ToLowerInvariant()

            # unicodePwd needs a confidential channel, same as a user reset.
            Invoke-MethodSetPassword -Params ([pscustomobject]@{
                    domainKey = [string](Get-ParamValue $params 'domainKey')
                    identity  = $identity
                    password  = $default
                }) | Out-Null

            Write-SidecarLog "resetComputerAccount: '$identity' password reset to the machine default"
            return [pscustomobject]@{ identity = $identity; reset = $true }
        }
        'copyObject' {
            Initialize-OpenAdFeModule
            $session = Get-SessionOrThrow -DomainKey ([string](Get-ParamValue $params 'domainKey'))
            $source = [string](Get-ParamValue $params 'source')
            $name = [string](Get-ParamValue $params 'name')
            $path = [string](Get-ParamValue $params 'path')
            $sam = [string](Get-ParamValue $params 'sAMAccountName')
            if (-not $source) { throw 'source (DN of the template) is required' }
            if (-not $name) { throw 'name is required' }
            if (-not $sam) { throw 'sAMAccountName is required' }

            # ADUC's Copy: a new account in the template's container carrying
            # its group memberships and the attributes that describe a role,
            # never the ones that identify a person or a session.
            $carry = @('department', 'company', 'title', 'physicalDeliveryOfficeName',
                'streetAddress', 'l', 'st', 'postalCode', 'co', 'telephoneNumber',
                'facsimileTelephoneNumber', 'homeDrive', 'homeDirectory',
                'scriptPath', 'profilePath', 'manager', 'description')

            $tpl = Get-OpenADObject -Session $session -Identity $source -Property $carry -ErrorAction Stop
            if (-not $path) { $path = ($source -split ',', 2)[1] }

            $extra = @{ sAMAccountName = $sam }
            foreach ($a in $carry) {
                $v = Get-OpenAdFePropertyScalar -Object $tpl -Name $a
                if ($v) { $extra[$a] = $v }
            }
            $realm = ConvertTo-OpenAdFeRealmFromNamingContext -DefaultNamingContext ([string](Get-ParamValue $params 'namingContext' ''))
            if ($realm) { $extra['userPrincipalName'] = "$sam@$realm" }

            Write-SidecarLog "copyObject: '$source' -> '$name' in '$path'"
            $created = New-OpenADObject -Session $session -Name $name -Type user -Path $path `
                -OtherAttributes $extra -PassThru -ErrorAction Stop

            # Group memberships come from the real membership query, so the
            # copy inherits nested and primary-group-driven access correctly.
            $copied = 0
            $failed = [System.Collections.Generic.List[string]]::new()
            foreach ($g in @(Get-OpenADPrincipalGroupMembership -Session $session -Identity $source -ErrorAction SilentlyContinue)) {
                $gdn = Get-OpenAdFePropertyScalar -Object $g -Name 'DistinguishedName'
                if (-not $gdn) { continue }
                # Primary group membership is implied by primaryGroupID and is
                # not an explicit member entry; adding it errors.
                if ($gdn -like 'CN=Domain Users,*') { continue }
                try {
                    Add-OpenADGroupMember -Session $session -Identity $gdn -Members @($created.DistinguishedName) -ErrorAction Stop
                    $copied++
                }
                catch { $failed.Add(($gdn -split ',')[0]) }
            }

            $row = ConvertTo-OpenAdFeDirectoryRow -Object $created -ObjectClassHint 'user'
            return [pscustomobject]@{
                created       = $row
                groupsCopied  = $copied
                groupsFailed  = @($failed.ToArray())
            }
        }
        'getGroupMembership' {
            Initialize-OpenAdFeModule
            $session = Get-SessionOrThrow -DomainKey ([string](Get-ParamValue $params 'domainKey'))
            $identity = [string](Get-ParamValue $params 'identity')
            if (-not $identity) { throw 'identity (DN) is required' }
            $recursive = [bool](Get-ParamValue $params 'recursive' $false)
            return [object[]]@(Get-OpenAdFeGroupMembership -Session $session -Identity $identity -Recursive:$recursive)
        }
        'getAccountOptions' {
            Initialize-OpenAdFeModule
            return (Invoke-MethodGetAccountOptions -Params $params)
        }
        'setAccountOptions' {
            Initialize-OpenAdFeModule
            return (Invoke-MethodSetAccountOptions -Params $params)
        }
        'getProtection' {
            Initialize-OpenAdFeModule
            return (Invoke-MethodGetProtection -Params $params)
        }
        'setProtection' {
            Initialize-OpenAdFeModule
            return (Invoke-MethodSetProtection -Params $params)
        }
        'getLogOptions' {
            return [pscustomobject]@{ verbose = $script:LogVerbose; includePwsh = $script:LogPwsh }
        }
        'setLogOptions' {
            return (Set-OpenAdFeLogOptions `
                    -Verbose ([bool](Get-ParamValue $params 'verbose' $false)) `
                    -IncludePwsh ([bool](Get-ParamValue $params 'includePwsh' $false)))
        }
        'quit' {
            foreach ($key in @($script:Sessions.Keys)) {
                try { Remove-OpenADSession -Session $script:Sessions[$key].Session -ErrorAction SilentlyContinue } catch {}
            }
            $script:Sessions.Clear()
            return [pscustomobject]@{ bye = $true }
        }
        default { throw "Unknown method '$method'" }
    }
}

# -- Write methods --------------------------------------------------------------
# All of these go over the ordinary browse session. Only unicodePwd needs a
# confidential channel (see Invoke-MethodSetPassword); userAccountControl and
# the rest are normal attribute writes.

function Get-OpenAdFeUacValue {
    param($Session, [string]$Identity)
    $o = Get-OpenADObject -Session $Session -Identity $Identity -Property 'userAccountControl' -ErrorAction Stop
    $raw = Get-OpenAdFePropertyScalar -Object $o -Name 'UserAccountControl'
    # PSOpenAD hands back a decoded flags enum; [int] on the enum is the number.
    $prop = $o.PSObject.Properties['UserAccountControl']
    if ($prop -and $prop.Value -is [System.Enum]) { return [int]$prop.Value }
    if ([string]$raw -match '^\d+$') { return [int]$raw }
    throw "Could not read userAccountControl for '$Identity' (got '$raw')."
}

function Invoke-MethodSetAccountEnabled {
    param($Params)
    $domainKey = [string](Get-ParamValue $Params 'domainKey')
    $identity = [string](Get-ParamValue $Params 'identity')
    $enabled = [bool](Get-ParamValue $Params 'enabled' $false)
    if (-not $identity) { throw 'identity (DN) is required' }
    $session = Get-SessionOrThrow -DomainKey $domainKey

    $ACCOUNT_DISABLE = 2
    $uac = Get-OpenAdFeUacValue -Session $session -Identity $identity
    $next = if ($enabled) { $uac -band (-bnot $ACCOUNT_DISABLE) } else { $uac -bor $ACCOUNT_DISABLE }

    if ($next -eq $uac) {
        Write-SidecarLog "setAccountEnabled: '$identity' already $(if ($enabled) { 'enabled' } else { 'disabled' })"
        return [pscustomobject]@{ ok = $true; identity = $identity; enabled = $enabled; changed = $false; userAccountControl = $next }
    }

    Write-SidecarLog "setAccountEnabled: '$identity' userAccountControl $uac -> $next"
    Set-OpenADObject -Session $session -Identity $identity -Replace @{ userAccountControl = $next } -ErrorAction Stop
    return [pscustomobject]@{ ok = $true; identity = $identity; enabled = $enabled; changed = $true; userAccountControl = $next }
}

function Invoke-MethodMoveObject {
    param($Params)
    $session = Get-SessionOrThrow -DomainKey ([string](Get-ParamValue $Params 'domainKey'))
    $identity = [string](Get-ParamValue $Params 'identity')
    $target = [string](Get-ParamValue $Params 'targetPath')
    if (-not $identity) { throw 'identity (DN) is required' }
    if (-not $target) { throw 'targetPath (destination container DN) is required' }

    Write-SidecarLog "moveObject: '$identity' -> '$target'"
    Move-OpenADObject -Session $session -Identity $identity -TargetPath $target -ErrorAction Stop
    $rdn = ($identity -split ',')[0]
    return [pscustomobject]@{ ok = $true; distinguishedName = "$rdn,$target" }
}

function Invoke-MethodRenameObject {
    param($Params)
    $session = Get-SessionOrThrow -DomainKey ([string](Get-ParamValue $Params 'domainKey'))
    $identity = [string](Get-ParamValue $Params 'identity')
    $newName = [string](Get-ParamValue $Params 'newName')
    if (-not $identity) { throw 'identity (DN) is required' }
    if (-not $newName) { throw 'newName is required' }

    Write-SidecarLog "renameObject: '$identity' -> '$newName'"
    Rename-OpenADObject -Session $session -Identity $identity -NewName $newName -ErrorAction Stop
    $parent = ($identity -split ',', 2)[1]
    $prefix = (($identity -split ',')[0] -split '=')[0]
    return [pscustomobject]@{ ok = $true; distinguishedName = "$prefix=$newName,$parent" }
}

function Invoke-MethodRemoveObject {
    param($Params)
    $session = Get-SessionOrThrow -DomainKey ([string](Get-ParamValue $Params 'domainKey'))
    $identity = [string](Get-ParamValue $Params 'identity')
    if (-not $identity) { throw 'identity (DN) is required' }

    Write-SidecarLog "removeObject: '$identity'"
    Remove-OpenADObject -Session $session -Identity $identity -ErrorAction Stop
    return [pscustomobject]@{ ok = $true; identity = $identity }
}

function Invoke-MethodNewObject {
    param($Params)
    $session = Get-SessionOrThrow -DomainKey ([string](Get-ParamValue $Params 'domainKey'))
    $name = [string](Get-ParamValue $Params 'name')
    $type = [string](Get-ParamValue $Params 'type')
    $path = [string](Get-ParamValue $Params 'path')
    if (-not $name) { throw 'name is required' }
    if (-not $type) { throw 'type is required (user, group, computer, organizationalUnit, contact)' }
    if (-not $path) { throw 'path (parent container DN) is required' }

    $extra = @{}
    $otherRaw = Get-ParamValue $Params 'attributes'
    if ($otherRaw) {
        foreach ($prop in $otherRaw.PSObject.Properties) {
            if ($null -ne $prop.Value -and [string]$prop.Value -ne '') { $extra[$prop.Name] = $prop.Value }
        }
    }

    $callArgs = @{ Session = $session; Name = $name; Type = $type; Path = $path; PassThru = $true; ErrorAction = 'Stop' }
    $desc = Get-ParamValue $Params 'description'
    if ($desc) { $callArgs.Description = [string]$desc }
    $disp = Get-ParamValue $Params 'displayName'
    if ($disp) { $callArgs.DisplayName = [string]$disp }
    if ($extra.Count -gt 0) { $callArgs.OtherAttributes = $extra }

    Write-SidecarLog "newObject: $type '$name' in '$path'"
    $created = New-OpenADObject @callArgs
    return (ConvertTo-OpenAdFeDirectoryRow -Object $created -ObjectClassHint $type)
}

function Invoke-MethodSetAttributes {
    param($Params)
    $session = Get-SessionOrThrow -DomainKey ([string](Get-ParamValue $Params 'domainKey'))
    $identity = [string](Get-ParamValue $Params 'identity')
    if (-not $identity) { throw 'identity (DN) is required' }

    $replace = @{}
    $clear = @()
    $setRaw = Get-ParamValue $Params 'set'
    if ($setRaw) {
        foreach ($prop in $setRaw.PSObject.Properties) {
            if ($null -eq $prop.Value -or [string]$prop.Value -eq '') { $clear += $prop.Name }
            else { $replace[$prop.Name] = $prop.Value }
        }
    }
    foreach ($n in @(Get-ParamValue $Params 'clear')) { if ($n) { $clear += [string]$n } }
    # The emptiness check has to come after add/remove are parsed, below.

    # Multi-valued attributes are edited by delta, not by replacement: sending
    # a whole new list would clobber values added by anything else since the
    # sheet was opened.
    $add = @{}
    $addRaw = Get-ParamValue $Params 'add'
    if ($addRaw) {
        foreach ($prop in $addRaw.PSObject.Properties) {
            $vals = @($prop.Value | Where-Object { $null -ne $_ -and [string]$_ -ne '' })
            if ($vals.Count -gt 0) { $add[$prop.Name] = $vals }
        }
    }
    $remove = @{}
    $removeRaw = Get-ParamValue $Params 'remove'
    if ($removeRaw) {
        foreach ($prop in $removeRaw.PSObject.Properties) {
            $vals = @($prop.Value | Where-Object { $null -ne $_ -and [string]$_ -ne '' })
            if ($vals.Count -gt 0) { $remove[$prop.Name] = $vals }
        }
    }

    $callArgs = @{ Session = $session; Identity = $identity; ErrorAction = 'Stop' }
    if ($replace.Count -gt 0) { $callArgs.Replace = $replace }
    if ($clear.Count -gt 0) { $callArgs.Clear = $clear }
    if ($add.Count -gt 0) { $callArgs.Add = $add }
    if ($remove.Count -gt 0) { $callArgs.Remove = $remove }

    if ($replace.Count -eq 0 -and $clear.Count -eq 0 -and $add.Count -eq 0 -and $remove.Count -eq 0) {
        throw 'nothing to change'
    }

    Write-SidecarLog "setAttributes: '$identity' replace=$($replace.Keys -join ',') clear=$($clear -join ',') add=$($add.Keys -join ',') remove=$($remove.Keys -join ',')"
    Set-OpenADObject @callArgs
    return [pscustomobject]@{
        ok       = $true
        identity = $identity
        replaced = @($replace.Keys)
        cleared  = @($clear)
        added    = @($add.Keys)
        removed  = @($remove.Keys)
    }
}

function Invoke-MethodGroupMember {
    param($Params, [ValidateSet('add', 'remove')][string]$Action)
    $session = Get-SessionOrThrow -DomainKey ([string](Get-ParamValue $Params 'domainKey'))
    $group = [string](Get-ParamValue $Params 'group')
    $members = @(@(Get-ParamValue $Params 'members') | Where-Object { $_ })
    if (-not $group) { throw 'group (DN) is required' }
    if ($members.Count -eq 0) { throw 'members (array of DNs) is required' }

    Write-SidecarLog "${Action}GroupMember: $($members.Count) member(s) on '$group'"
    if ($Action -eq 'add') {
        Add-OpenADGroupMember -Session $session -Identity $group -Members $members -ErrorAction Stop
    }
    else {
        Remove-OpenADGroupMember -Session $session -Identity $group -Members $members -ErrorAction Stop
    }
    return [pscustomobject]@{ ok = $true; group = $group; members = $members }
}

# memberOf lists only DIRECT membership and never the primary group, so reading
# the attribute is not the same question as "what groups is this in".
#
# Get-OpenADPrincipalGroupMembership answers it properly, but cannot be used:
# it feeds the principal's DN to LDAPFilter.EncodeSimpleFilterValue, which
# VALIDATES rather than escapes and throws on a raw '(' . Parentheses are legal
# in a DN and school accounts are routinely named "Name (ID)", so the cmdlet
# fails on most of this directory. Reported upstream; this does the same work
# with the DN escaped properly.
function Get-OpenAdFeGroupMembership {
    param(
        [Parameter(Mandatory)]$Session,
        [Parameter(Mandatory)][string]$Identity,
        [switch]$Recursive
    )

    $principal = Get-OpenADObject -Session $Session -Identity $Identity `
        -Property 'objectSid', 'primaryGroupID', 'distinguishedName' -ErrorAction Stop
    $dn = [string](Get-OpenAdFePropertyScalar -Object $principal -Name 'DistinguishedName')
    if (-not $dn) { $dn = $Identity }
    $escaped = ConvertTo-EscapedLdapFilterValue $dn

    # LDAP_MATCHING_RULE_IN_CHAIN walks nested membership server-side.
    $memberClause = if ($Recursive) {
        "(member:1.2.840.113556.1.4.1941:=$escaped)"
    }
    else {
        "(member=$escaped)"
    }

    # The primary group is not a member entry: the object carries the group's
    # RID in primaryGroupID, so reconstruct the group SID from the object's own.
    $primaryClause = ''
    $sid = [string](Get-OpenAdFePropertyScalar -Object $principal -Name 'ObjectSid')
    $pgid = [string](Get-OpenAdFePropertyScalar -Object $principal -Name 'PrimaryGroupID')
    if ($sid -match '^S-1-' -and $pgid -match '^\d+$') {
        $parts = @($sid -split '-')
        $parts[$parts.Count - 1] = $pgid
        $primaryClause = "(objectSid=$($parts -join '-'))"
    }

    $filter = if ($primaryClause) {
        "(&(objectClass=group)(|$memberClause$primaryClause))"
    }
    else {
        "(&(objectClass=group)$memberClause)"
    }

    $searchBase = ($dn -split ',' | Where-Object { $_ -match '^DC=' }) -join ','
    if (-not $searchBase) { throw "Could not derive a naming context from '$dn'." }

    $groups = @(Get-OpenADObject -Session $Session -SearchBase $searchBase -SearchScope Subtree `
            -LDAPFilter $filter -Property 'name', 'distinguishedName', 'objectClass', 'description', 'groupType', 'sAMAccountName' `
            -ErrorAction Stop)
    return @($groups | ForEach-Object { ConvertTo-OpenAdFeDirectoryRow -Object $_ -ObjectClassHint 'group' })
}

# ---- Recycle Bin (ADUC's Deleted Objects) -------------------------------------

# The Recycle Bin is a FOREST optional feature, and it is one-way: once enabled
# it cannot be turned off. When it is off a deleted object is a tombstone whose
# attributes have already been stripped, so there is nothing worth restoring and
# offering the node would only mislead. That is why the UI asks this first.
$script:RecycleBinFeatureRdn = 'CN=Recycle Bin Feature,'

# A deleted object's DN is mangled: "CN=Name\0ADEL:<guid>,CN=Deleted Objects,...".
# lastKnownParent is rewritten to that form too once the parent is itself
# deleted, so the raw value is unreadable exactly when a reader most needs to
# understand it. This recovers what the path was called.
function ConvertTo-OpenAdFeReadableDeletedDn {
    param([string]$Dn)
    if (-not $Dn) { return '' }
    # \0A is RFC 4514 hex escaping for the newline AD inserts before DEL:.
    return ($Dn -replace '\\0ADEL:[0-9a-fA-F-]{36}', '')
}

function Get-OpenAdFeRecycleBinState {
    param([Parameter(Mandatory)]$Session)

    $root = Get-OpenADRootDSE -Session $Session -ErrorAction Stop
    $nc = [string](Get-OpenAdFePropertyScalar -Object $root -Name 'DefaultNamingContext')
    $configNc = [string](Get-OpenAdFePropertyScalar -Object $root -Name 'ConfigurationNamingContext')

    $enabled = $false
    $err = $null
    if ($configNc) {
        try {
            # msDS-EnabledFeature on the Partitions container lists the optional
            # features switched on for the forest, each by its feature object DN.
            $partitions = Get-OpenADObject -Session $Session -Identity "CN=Partitions,$configNc" `
                -Property 'msDS-EnabledFeature' -ErrorAction Stop
            $features = @(Get-OpenAdFePropertyValues -Object $partitions -Name 'msDS-EnabledFeature')
            foreach ($f in $features) {
                if ([string]$f -like "$script:RecycleBinFeatureRdn*") { $enabled = $true }
            }
        }
        catch {
            # Not fatal. A reader without rights on the config NC still gets a
            # usable app, just without the node.
            $err = $_.Exception.Message
        }
    }

    $deletedDn = $null
    if ($nc) { $deletedDn = "CN=Deleted Objects,$nc" }

    return [pscustomobject]@{
        enabled          = $enabled
        deletedObjectsDn = $deletedDn
        namingContext    = $nc
        error            = $err
    }
}

function Get-OpenAdFeDeletedObjects {
    param(
        [Parameter(Mandatory)]$Session,
        [string]$SearchBase,
        [string]$Query,
        [int]$Limit = 500
    )

    if (-not $SearchBase) {
        $state = Get-OpenAdFeRecycleBinState -Session $Session
        $SearchBase = [string]$state.deletedObjectsDn
    }
    if (-not $SearchBase) { throw 'Could not determine the Deleted Objects container.' }

    # A deleted object is invisible without LDAP_SERVER_SHOW_DELETED_OID, which
    # is what -IncludeDeletedObjects attaches.
    $filter = '(isDeleted=TRUE)'
    if ($Query) {
        $escaped = ConvertTo-EscapedLdapFilterValue $Query
        $filter = "(&(isDeleted=TRUE)(|(name=*$escaped*)(msDS-LastKnownRDN=*$escaped*)(sAMAccountName=*$escaped*)))"
    }

    $props = @(
        'name', 'objectClass', 'distinguishedName', 'sAMAccountName', 'description',
        'isDeleted', 'isRecycled', 'lastKnownParent', 'msDS-LastKnownRDN',
        'whenChanged', 'whenCreated', 'objectGuid'
    )

    $found = @(Get-OpenADObject -Session $Session -SearchBase $SearchBase -SearchScope OneLevel `
            -LDAPFilter $filter -IncludeDeletedObjects -Property $props -ErrorAction Stop |
        Select-Object -First $Limit)

    return @($found | ForEach-Object {
        $row = ConvertTo-OpenAdFeDirectoryRow -Object $_
        $rdn = Get-OpenAdFePropertyScalar -Object $_ -Name 'msDS-LastKnownRDN'
        $parent = Get-OpenAdFePropertyScalar -Object $_ -Name 'LastKnownParent'
        $recycled = Get-OpenAdFePropertyScalar -Object $_ -Name 'IsRecycled'

        # The mangled name inside the container carries the object GUID after a
        # NUL, which is noise to a reader. Show what it was called instead.
        if ($rdn) { $row.name = [string]$rdn }
        $row | Add-Member -NotePropertyName 'isDeleted' -NotePropertyValue $true -Force
        $row | Add-Member -NotePropertyName 'lastKnownParent' `
            -NotePropertyValue (ConvertTo-OpenAdFeReadableDeletedDn -Dn ([string]$parent)) -Force
        $row | Add-Member -NotePropertyName 'lastKnownRdn' -NotePropertyValue ([string]$rdn) -Force
        # Recycled: the deleted object lifetime expired and the attributes are
        # gone. It still lists, but it can never be restored.
        $row | Add-Member -NotePropertyName 'isRecycled' -NotePropertyValue ([bool]$recycled) -Force
        $row
    })
}

# ---- Account options (ADUC's Account tab) ------------------------------------
# The whole checkbox block is one attribute family: userAccountControl bits,
# plus pwdLastSet, lockoutTime and accountExpires.
#
# Reads and writes are asymmetric and it matters: PSOpenAD DECODES these on the
# way out (userAccountControl becomes a flags enum, the FILETIME attributes
# become DateTime) but wants RAW INTEGERS on the way in.

$script:UacFlags = @{
    disabled              = 2          # ACCOUNTDISABLE
    homeDirRequired       = 8
    passwordNotRequired   = 32         # PASSWD_NOTREQD
    passwordNeverExpires  = 65536      # DONT_EXPIRE_PASSWORD
    smartcardRequired     = 262144     # SMARTCARD_REQUIRED
    trustedForDelegation  = 524288
    notDelegated          = 1048576    # NOT_DELEGATED
    useDesKeyOnly         = 2097152
    dontRequirePreauth    = 4194304    # DONT_REQ_PREAUTH
}
$script:UacLockoutBit = 16             # LOCKOUT, only meaningful on the computed attribute
$script:NeverExpires = 9223372036854775807

function ConvertTo-OpenAdFeInt64 {
    param($Value)
    if ($null -eq $Value) { return $null }
    if ($Value -is [System.Enum]) { return [int64][int]$Value }
    if ($Value -is [datetime]) { return [int64]([datetime]$Value).ToFileTimeUtc() }
    if ($Value -is [datetimeoffset]) { return [int64](([datetimeoffset]$Value).UtcDateTime).ToFileTimeUtc() }
    $text = [string]$Value
    if ($text -match '^-?\d+$') { return [int64]$text }
    try { return [int64]([datetime]::Parse($text)).ToFileTimeUtc() } catch { return $null }
}

function Get-OpenAdFeUacInt {
    param($Object, [string]$Name)
    $prop = $Object.PSObject.Properties | Where-Object { $_.Name -replace '-', '' -eq ($Name -replace '-', '') } | Select-Object -First 1
    if (-not $prop -or $null -eq $prop.Value) { return $null }
    return ConvertTo-OpenAdFeInt64 -Value $prop.Value
}

function Invoke-MethodGetAccountOptions {
    param($Params)
    $session = Get-SessionOrThrow -DomainKey ([string](Get-ParamValue $Params 'domainKey'))
    $identity = [string](Get-ParamValue $Params 'identity')
    if (-not $identity) { throw 'identity (DN) is required' }

    $props = @('userAccountControl', 'msDS-User-Account-Control-Computed',
        'pwdLastSet', 'lockoutTime', 'accountExpires')
    $o = Get-OpenADObject -Session $session -Identity $identity -Property $props -ErrorAction Stop

    $uac = Get-OpenAdFeUacInt -Object $o -Name 'userAccountControl'
    if ($null -eq $uac) { throw "Could not read userAccountControl for '$identity'." }
    $computed = Get-OpenAdFeUacInt -Object $o -Name 'msDS-User-Account-Control-Computed'
    $pwdLastSet = Get-OpenAdFeUacInt -Object $o -Name 'pwdLastSet'
    $expires = Get-OpenAdFeUacInt -Object $o -Name 'accountExpires'

    $flags = [ordered]@{}
    foreach ($k in $script:UacFlags.Keys) {
        $flags[$k] = [bool]($uac -band $script:UacFlags[$k])
    }

    # Never trust lockoutTime alone: AD leaves it set after the lockout has
    # expired. The DC-computed attribute is the only current answer.
    $locked = if ($null -ne $computed) { [bool]($computed -band $script:UacLockoutBit) } else { $false }

    $expiresIso = $null
    if ($null -ne $expires -and $expires -gt 0 -and $expires -lt $script:NeverExpires) {
        $expiresIso = ([datetimeoffset]([datetime]::FromFileTimeUtc($expires))).ToString('o')
    }

    return [pscustomobject]@{
        identity            = $identity
        userAccountControl  = $uac
        flags               = [pscustomobject]$flags
        locked              = $locked
        mustChangePassword  = ($pwdLastSet -eq 0)
        passwordLastSet     = if ($pwdLastSet -gt 0) { ([datetimeoffset]([datetime]::FromFileTimeUtc($pwdLastSet))).ToString('o') } else { $null }
        accountExpires      = $expiresIso
    }
}

function Invoke-MethodSetAccountOptions {
    param($Params)
    $session = Get-SessionOrThrow -DomainKey ([string](Get-ParamValue $Params 'domainKey'))
    $identity = [string](Get-ParamValue $Params 'identity')
    if (-not $identity) { throw 'identity (DN) is required' }

    $o = Get-OpenADObject -Session $session -Identity $identity -Property 'userAccountControl' -ErrorAction Stop
    $uac = Get-OpenAdFeUacInt -Object $o -Name 'userAccountControl'
    if ($null -eq $uac) { throw "Could not read userAccountControl for '$identity'." }

    $replace = @{}
    $next = $uac
    $flagsRaw = Get-ParamValue $Params 'flags'
    if ($flagsRaw) {
        foreach ($prop in $flagsRaw.PSObject.Properties) {
            if (-not $script:UacFlags.ContainsKey($prop.Name)) {
                throw "Unknown account flag '$($prop.Name)'."
            }
            $bit = $script:UacFlags[$prop.Name]
            if ([bool]$prop.Value) { $next = $next -bor $bit } else { $next = $next -band (-bnot $bit) }
        }
    }
    if ($next -ne $uac) { $replace['userAccountControl'] = $next }

    # Unlock is a write of 0; there is no "lock" counterpart, which is why this
    # is a one-way switch rather than a checkbox.
    if ([bool](Get-ParamValue $Params 'unlock' $false)) { $replace['lockoutTime'] = 0 }

    $mustChange = Get-ParamValue $Params 'mustChangePassword'
    if ($null -ne $mustChange) {
        # 0 forces a change at next logon; -1 means "set it to now" and is how
        # AD clears the flag without altering the password itself.
        $replace['pwdLastSet'] = if ([bool]$mustChange) { 0 } else { -1 }
    }

    if ($Params.PSObject.Properties['accountExpires']) {
        $raw = $Params.accountExpires
        if ($null -eq $raw -or [string]$raw -eq '') {
            $replace['accountExpires'] = 0          # 0 means never
        }
        else {
            $ft = ConvertTo-OpenAdFeInt64 -Value $raw
            if ($null -eq $ft) { throw "Could not read accountExpires value '$raw' as a date." }
            $replace['accountExpires'] = $ft
        }
    }

    if ($replace.Count -eq 0) {
        return [pscustomobject]@{ identity = $identity; changed = $false }
    }

    Write-SidecarLog "setAccountOptions: '$identity' $($replace.Keys -join ', ')"
    Set-OpenADObject -Session $session -Identity $identity -Replace $replace -ErrorAction Stop
    return [pscustomobject]@{ identity = $identity; changed = $true; applied = @($replace.Keys) }
}

# ADUC's "Protect object from accidental deletion". Not an attribute: it is a
# Deny ACE for Everyone on the object's own DACL. Verified against a DC that
# already had it set - the mask AD writes is Delete + DeleteTree + DeleteChild.
#
# .NET's own SecurityIdentifier throws "Windows Principal functionality is not
# supported on this platform" off Windows, so this uses PSOpenAD.Security,
# which ships a cross-platform implementation.

$script:EveryoneSid = 'S-1-1-0'
$script:AceDelete = 65536      # ADS_RIGHT_DELETE
$script:AceDeleteChild = 2     # ADS_RIGHT_DS_DELETE_CHILD

function Get-OpenAdFeDenyChildAce {
    param($SecurityDescriptor)
    return @($SecurityDescriptor.DiscretionaryAcl | Where-Object {
            "$($_.AceType)" -eq 'AccessDenied' -and
            "$($_.Sid)" -eq $script:EveryoneSid -and
            ([int]$_.AccessMask -band $script:AceDeleteChild)
        })
}

function Add-OpenAdFeDenyAce {
    param($Session, [string]$Identity, [string]$Rights)
    $sd = Get-OpenAdFeSecurityDescriptor -Session $Session -Identity $Identity
    $ace = [PSOpenAD.Security.Ace]::new(
        [PSOpenAD.Security.AceType]::AccessDenied,
        [PSOpenAD.Security.AceFlags]::None,
        [PSOpenAD.Security.ActiveDirectoryRights]$Rights,
        [PSOpenAD.Security.SecurityIdentifier]::new($script:EveryoneSid),
        $null)
    # Deny ACEs belong ahead of allow ACEs in canonical order.
    $sd.DiscretionaryAcl.Insert(0, $ace)
    $bytes = [byte[]]::new($sd.BinaryLength)
    $sd.GetBinaryForm($bytes, 0)
    Set-OpenADObject -Session $Session -Identity $Identity -Replace @{ nTSecurityDescriptor = $bytes } -ErrorAction Stop
}

function Get-OpenAdFeProtectionAce {
    param($SecurityDescriptor)
    # Protection means Delete is denied. The domain head carries a Deny-Everyone
    # ACE for DeleteChild alone, which is a different thing and must not count.
    return @($SecurityDescriptor.DiscretionaryAcl | Where-Object {
            "$($_.AceType)" -eq 'AccessDenied' -and
            "$($_.Sid)" -eq $script:EveryoneSid -and
            ([int]$_.AccessMask -band $script:AceDelete)
        })
}

function Get-OpenAdFeSecurityDescriptor {
    param($Session, [string]$Identity)
    $o = Get-OpenADObject -Session $Session -Identity $Identity -Property 'nTSecurityDescriptor' -ErrorAction Stop
    $prop = $o.PSObject.Properties['NTSecurityDescriptor']
    if (-not $prop -or $null -eq $prop.Value) {
        throw "Could not read nTSecurityDescriptor for '$Identity' - the account may lack permission to read the ACL."
    }
    return $prop.Value
}

function Invoke-MethodGetProtection {
    param($Params)
    $session = Get-SessionOrThrow -DomainKey ([string](Get-ParamValue $Params 'domainKey'))
    $identity = [string](Get-ParamValue $Params 'identity')
    if (-not $identity) { throw 'identity (DN) is required' }

    $sd = Get-OpenAdFeSecurityDescriptor -Session $session -Identity $identity
    return [pscustomobject]@{
        identity  = $identity
        protected = (@(Get-OpenAdFeProtectionAce -SecurityDescriptor $sd).Count -gt 0)
    }
}

function Invoke-MethodSetProtection {
    param($Params)
    $session = Get-SessionOrThrow -DomainKey ([string](Get-ParamValue $Params 'domainKey'))
    $identity = [string](Get-ParamValue $Params 'identity')
    $protect = [bool](Get-ParamValue $Params 'protected' $false)
    if (-not $identity) { throw 'identity (DN) is required' }

    $sd = Get-OpenAdFeSecurityDescriptor -Session $session -Identity $identity
    $existing = @(Get-OpenAdFeProtectionAce -SecurityDescriptor $sd)

    if ($protect -and $existing.Count -gt 0) {
        return [pscustomobject]@{ identity = $identity; protected = $true; changed = $false }
    }
    if (-not $protect -and $existing.Count -eq 0) {
        return [pscustomobject]@{ identity = $identity; protected = $false; changed = $false }
    }

    if ($protect) {
        # AD allows a delete when the caller has EITHER Delete on the object
        # OR DeleteChild on its parent. Denying only on the object therefore
        # protects nothing - verified against a live DC, the object deleted
        # anyway. Both halves are required.
        $parent = ($identity -split ',', 2)[1]
        if ($parent) {
            $parentSd = Get-OpenAdFeSecurityDescriptor -Session $session -Identity $parent
            if (@(Get-OpenAdFeDenyChildAce -SecurityDescriptor $parentSd).Count -eq 0) {
                Write-SidecarLog "setProtection: parent '$parent' also needs a DeleteChild deny"
                Add-OpenAdFeDenyAce -Session $session -Identity $parent -Rights 'DeleteChild'
            }
        }
        $sid = [PSOpenAD.Security.SecurityIdentifier]::new($script:EveryoneSid)
        # DeleteChild on the object too, matching what AD writes on its own
        # protected OUs: it is what lets this object's children be protected.
        $mask = [PSOpenAD.Security.ActiveDirectoryRights]'Delete, DeleteTree, DeleteChild'
        $ace = [PSOpenAD.Security.Ace]::new(
            [PSOpenAD.Security.AceType]::AccessDenied,
            [PSOpenAD.Security.AceFlags]::None,
            $mask, $sid, $null)
        $sd.DiscretionaryAcl.Insert(0, $ace)
    }
    else {
        # Only this object's deny is removed. The parent's DeleteChild deny is
        # shared with its siblings, so clearing it would silently unprotect
        # them as well.
        foreach ($ace in $existing) { [void]$sd.DiscretionaryAcl.Remove($ace) }
    }

    # The whole descriptor goes back, owner/group/SACL included. Verified against
    # a live DC that the SACL survives the round trip unchanged.
    $bytes = [byte[]]::new($sd.BinaryLength)
    $sd.GetBinaryForm($bytes, 0)

    Write-SidecarLog "setProtection: '$identity' -> protected=$protect"
    Set-OpenADObject -Session $session -Identity $identity -Replace @{ nTSecurityDescriptor = $bytes } -ErrorAction Stop

    return [pscustomobject]@{ identity = $identity; protected = $protect; changed = $true }
}

# Diagnostic verbosity. Off by default: PSOpenAD narrates every LDAP operation,
# which is exactly what you want when a connect misbehaves and pure noise
# otherwise. Toggled at runtime by the setLogOptions method.
$script:LogVerbose = $false
$script:LogPwsh = $false

function Set-OpenAdFeLogOptions {
    param([bool]$Verbose, [bool]$IncludePwsh)

    $script:LogVerbose = $Verbose
    $script:LogPwsh = $IncludePwsh

    # These only decide whether the records are *emitted*; the main loop is what
    # keeps them off stdout, which is the JSON channel.
    $global:VerbosePreference = if ($Verbose) { 'Continue' } else { 'SilentlyContinue' }
    $global:DebugPreference = if ($IncludePwsh) { 'Continue' } else { 'SilentlyContinue' }
    $global:InformationPreference = if ($IncludePwsh) { 'Continue' } else { 'SilentlyContinue' }
    $global:WarningPreference = if ($IncludePwsh) { 'Continue' } else { 'Continue' }

    Write-SidecarLog "Log options: verbose=$Verbose includePwsh=$IncludePwsh"
    return [pscustomobject]@{ verbose = $script:LogVerbose; includePwsh = $script:LogPwsh }
}

# Methods whose result is a list; an empty one must serialise as [] not null.
$script:ListMethods = @(
    'ladder', 'listSessions', 'getChildren', 'search', 'getGroupMembers',
    'getGroupMembership', 'getOperationsMasters', 'getServiceAccounts',
    'listDeletedObjects'
)

Write-SidecarLog "Ready (PID $PID)"
# Handshake for the Tauri host - must be first stdout line
[Console]::Out.WriteLine('{"event":"ready","pid":' + $PID + '}')
[Console]::Out.Flush()

while ($true) {
    $line = [Console]::In.ReadLine()
    if ($null -eq $line) { break }
    $line = $line.Trim()
    if (-not $line) { continue }

    $id = $null
    try {
        $req = $line | ConvertFrom-Json -ErrorAction Stop
        $id = Get-ParamValue $req 'id'
        $method = [string](Get-ParamValue $req 'method')

        if ($script:LogVerbose -or $script:LogPwsh) {
            # Verbose, debug, information and warning records all land on
            # STDOUT by default - which is the JSON channel - so turning
            # verbosity on naively would corrupt the protocol. Drain them out
            # of the pipeline here and write them to stderr instead, where the
            # log viewer already picks them up.
            $result = Invoke-SidecarRequest -Request $req 3>&1 4>&1 5>&1 6>&1 | ForEach-Object {
                if ($_ -is [System.Management.Automation.InformationalRecord]) {
                    Write-SidecarLog "[pwsh] $($_.Message)"
                }
                elseif ($_ -is [System.Management.Automation.InformationRecord]) {
                    Write-SidecarLog "[pwsh] $($_.MessageData)"
                }
                else {
                    $_
                }
            }
        }
        else {
            $result = Invoke-SidecarRequest -Request $req
        }

        # A list result must always serialise as [...]. Three things conspire
        # against that: the pipeline above enumerates arrays, returning an empty
        # array from a function unrolls it to $null, and ConvertTo-Json wraps
        # inconsistently. Normalising here covers all three.
        if ($method -in $script:ListMethods) {
            $result = [object[]]@($result | Where-Object { $null -ne $_ })
        }
        elseif ($result -is [System.Array] -and -not ($result -is [byte[]]) -and -not ($result -is [char[]])) {
            $result = [object[]]$result
        }
        $payload = [ordered]@{
            id     = $id
            ok     = $true
            result = $result
        }
        $json = ($payload | ConvertTo-Json -Depth 8 -Compress -EnumsAsStrings)
        [Console]::Out.WriteLine($json)
        [Console]::Out.Flush()

        if ([string](Get-ParamValue $req 'method') -eq 'quit') { break }
    }
    catch {
        $msg = $_.Exception.Message
        Write-SidecarLog "Error: $msg"
        $payload = [ordered]@{
            id     = $id
            ok     = $false
            error  = $msg
        }
        $json = ($payload | ConvertTo-Json -Depth 4 -Compress)
        [Console]::Out.WriteLine($json)
        [Console]::Out.Flush()
    }
}
