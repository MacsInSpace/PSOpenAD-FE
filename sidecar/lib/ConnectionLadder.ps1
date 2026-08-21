# LDAP connection ladder for New-OpenADSession.
# Order is least -> most secure; first success wins.
#   389 plain -> 389 StartTLS -> 3268 plain GC -> 3268 StartTLS -> 636 LDAPS -> 3269 LDAPS-GC
# SkipCertificateCheck on TLS steps (typical for IP binds against an internal CA).
# Kerberos seal channel is separate (unicodePwd without LDAPS).

# Dot-sourced into the sidecar, which sets this too. Declared here as well so
# the file is equally strict if it is ever loaded or tested on its own.
Set-StrictMode -Version Latest

function Get-OpenAdFeDefaultPorts {
    if ($env:APP_LDAP_PORTS) {
        return @(($env:APP_LDAP_PORTS -split '[,\s]+') |
            Where-Object { $_ } |
            ForEach-Object { [int]$_ })
    }
    return @(389, 3268, 636, 3269)
}

function Write-OpenAdFeLadderLog {
    param([string]$Message)
    if (Get-Command Write-SidecarLog -ErrorAction SilentlyContinue) {
        Write-SidecarLog $Message
    }
    else {
        [Console]::Error.WriteLine("[ldap] $Message")
    }
}

function Get-OpenAdFeCanonicalLadder {
    <#
    .SYNOPSIS
        Full escalating ladder (least -> most transport security).
        Port 636/3269 are LDAPS-only (TLS is inherent); 389/3268 offer plain then StartTLS.
    #>
    return @(
        [pscustomobject]@{
            Name = 'LDAP:389 Simple'; Port = 389; StartTLS = $false; UseTLS = $false
            AuthType = 'Simple'; SkipCert = $false
        }
        [pscustomobject]@{
            Name = 'StartTLS:389 Simple'; Port = 389; StartTLS = $true; UseTLS = $false
            AuthType = 'Simple'; SkipCert = $true
        }
        [pscustomobject]@{
            Name = 'LDAP:3268 GC Simple'; Port = 3268; StartTLS = $false; UseTLS = $false
            AuthType = 'Simple'; SkipCert = $false
        }
        [pscustomobject]@{
            Name = 'StartTLS:3268 GC Simple'; Port = 3268; StartTLS = $true; UseTLS = $false
            AuthType = 'Simple'; SkipCert = $true
        }
        [pscustomobject]@{
            Name = 'LDAPS:636 Simple'; Port = 636; StartTLS = $false; UseTLS = $true
            AuthType = 'Simple'; SkipCert = $true
        }
        [pscustomobject]@{
            Name = 'LDAPS:3269 GC Simple'; Port = 3269; StartTLS = $false; UseTLS = $true
            AuthType = 'Simple'; SkipCert = $true
        }
    )
}

function Get-OpenAdFeConnectionLadder {
    [CmdletBinding()]
    param(
        [int[]]$Ports
    )

    $canonical = @(Get-OpenAdFeCanonicalLadder)

    if (-not $Ports -or $Ports.Count -eq 0) {
        $Ports = @(Get-OpenAdFeDefaultPorts)
    }

    $wanted = [System.Collections.Generic.HashSet[int]]::new()
    foreach ($p in $Ports) { [void]$wanted.Add([int]$p) }

    $filtered = @($canonical | Where-Object { $wanted.Contains([int]$_.Port) })
    if ($filtered.Count -gt 0) {
        return $filtered
    }

    # Unknown custom ports: plain then StartTLS (or LDAPS-style UseTLS for 636/3269-like).
    $steps = [System.Collections.Generic.List[object]]::new()
    foreach ($port in $Ports) {
        if ($port -in @(636, 3269)) {
            $steps.Add([pscustomobject]@{
                    Name = "LDAPS:${port} Simple"; Port = [int]$port
                    StartTLS = $false; UseTLS = $true; AuthType = 'Simple'; SkipCert = $true
                })
        }
        else {
            $steps.Add([pscustomobject]@{
                    Name = "LDAP:${port} Simple"; Port = [int]$port
                    StartTLS = $false; UseTLS = $false; AuthType = 'Simple'; SkipCert = $false
                })
            $steps.Add([pscustomobject]@{
                    Name = "StartTLS:${port} Simple"; Port = [int]$port
                    StartTLS = $true; UseTLS = $false; AuthType = 'Simple'; SkipCert = $true
                })
        }
    }
    return @($steps.ToArray())
}

function ConvertTo-OpenAdFeLdapCredential {
    <#
    .SYNOPSIS
        Normalize username for Simple bind.
        UPN and DOMAIN\user are left unchanged.
        Bare sAMAccountName is prefixed with DefaultDomain\ only when DefaultDomain is set.
    #>
    param(
        [Parameter(Mandatory)]
        [pscredential]$Credential,

        [string]$DefaultDomain
    )

    $user = [string]$Credential.UserName
    if (-not $user) { return $Credential }

    if ($user -match '@' -or $user -match '\\') {
        return $Credential
    }

    if (-not $DefaultDomain) {
        return $Credential
    }

    $secure = $Credential.Password
    return [pscredential]::new("${DefaultDomain}\${user}", $secure)
}

function New-OpenAdFeSessionFromStep {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)]
        [string]$ComputerName,

        [Parameter(Mandatory)]
        [pscredential]$Credential,

        [Parameter(Mandatory)]
        $Step,

        [int]$ConnectTimeoutMs = 5000,
        [int]$OperationTimeoutMs = 15000
    )

    $optionParams = @{}
    $soCmd = Get-Command New-OpenADSessionOption -ErrorAction Stop
    if ($soCmd.Parameters.ContainsKey('ConnectTimeout')) {
        $optionParams['ConnectTimeout'] = $ConnectTimeoutMs
    }
    if ($soCmd.Parameters.ContainsKey('OperationTimeout')) {
        $optionParams['OperationTimeout'] = $OperationTimeoutMs
    }
    if ($Step.SkipCert -and $soCmd.Parameters.ContainsKey('SkipCertificateCheck')) {
        $optionParams['SkipCertificateCheck'] = $true
    }
    $sessionOption = New-OpenADSessionOption @optionParams

    $params = @{
        ComputerName  = $ComputerName
        Port          = [int]$Step.Port
        Credential    = $Credential
        AuthType      = if ($Step.AuthType) { [string]$Step.AuthType } else { 'Simple' }
        SessionOption = $sessionOption
        ErrorAction   = 'Stop'
    }
    if ($Step.StartTLS) { $params['StartTLS'] = $true }
    if ($Step.UseTLS) { $params['UseTLS'] = $true }

    New-OpenADSession @params
}

function Connect-OpenAdFeWithLadder {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)]
        [string]$ComputerName,

        [Parameter(Mandatory)]
        [pscredential]$Credential,

        [int[]]$Ports,

        [string]$ForceStepName,

        [string]$DefaultDomain,

        [switch]$ReturnAttempts
    )

    $bindCred = ConvertTo-OpenAdFeLdapCredential -Credential $Credential -DefaultDomain $DefaultDomain
    $ladder = @(Get-OpenAdFeConnectionLadder -Ports $Ports)

    if ($ForceStepName) {
        $ladder = @($ladder | Where-Object { $_.Name -like "*$ForceStepName*" })
        if ($ladder.Count -eq 0) {
            if ($ForceStepName -match '^\d+$') {
                $p = [int]$ForceStepName
                $ladder = @(Get-OpenAdFeConnectionLadder -Ports @($p))
            }
        }
        if ($ladder.Count -eq 0) {
            throw "No connection ladder step matched '$ForceStepName'."
        }
    }

    $firstMs = if ($env:APP_LDAP_FIRST_CONNECT_TIMEOUT_MS) { [int]$env:APP_LDAP_FIRST_CONNECT_TIMEOUT_MS } else { 5000 }
    $lastMs = if ($env:APP_LDAP_CONNECT_TIMEOUT_MS) { [int]$env:APP_LDAP_CONNECT_TIMEOUT_MS } else { 12000 }
    $operMs = if ($env:APP_LDAP_OPERATION_TIMEOUT_MS) { [int]$env:APP_LDAP_OPERATION_TIMEOUT_MS } else { 15000 }

    $attempts = [System.Collections.Generic.List[object]]::new()

    for ($i = 0; $i -lt $ladder.Count; $i++) {
        $step = $ladder[$i]
        $isLast = ($i -eq ($ladder.Count - 1))
        $connectMs = if ($isLast) { $lastMs } else { $firstMs }

        $attempt = [ordered]@{
            step  = $step.Name
            ok    = $false
            error = $null
        }
        try {
            Write-OpenAdFeLadderLog "LDAP: ${ComputerName}:$($step.Port) trying $($step.Name) (${connectMs}ms) as $($bindCred.UserName)"
            $session = New-OpenAdFeSessionFromStep `
                -ComputerName $ComputerName `
                -Credential $bindCred `
                -Step $step `
                -ConnectTimeoutMs $connectMs `
                -OperationTimeoutMs $operMs
            $attempt.ok = $true
            $attempts.Add([pscustomobject]$attempt)

            return [pscustomobject]@{
                Session      = $session
                Step         = $step
                Attempts     = @($attempts.ToArray())
                BindUserName = $bindCred.UserName
            }
        }
        catch {
            $attempt.error = $_.Exception.Message
            $attempts.Add([pscustomobject]$attempt)
            Write-OpenAdFeLadderLog "LDAP: ${ComputerName}:$($step.Port) failed: $($_.Exception.Message)"
        }
    }

    $detail = ($attempts | ForEach-Object { "  [$($_.step)] $($_.error)" }) -join "`n"
    $err = @"
All connection ladder steps failed for ${ComputerName} (as $($bindCred.UserName)).
Default ladder (least -> most secure): 389 -> 389 StartTLS -> 3268 -> 3268 StartTLS -> 636 LDAPS -> 3269 LDAPS-GC. First success wins.
$detail
"@
    if ($ReturnAttempts) {
        return [pscustomobject]@{
            Session      = $null
            Step         = $null
            Attempts     = @($attempts.ToArray())
            Error        = $err
            BindUserName = $bindCred.UserName
        }
    }
    throw $err
}
