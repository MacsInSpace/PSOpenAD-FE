# Kerberos sign+seal over plain :389 for unicodePwd when LDAPS/StartTLS is unavailable.
# The local-AD password channel recipe.
#
# Why this exists: AD rejects unicodePwd on an unprotected connection. Many DCs
# have no LDAPS cert; StartTLS is often unavailable. Kerberos GSSAPI sign+seal on
# :389 gives a confidential channel with no PKI.
#
# Why the CLI dance (macOS): Apple Heimdal 1.5.1's gss_acquire_cred_with_password
# is broken, and its GSS ignores KRB5_CONFIG / FILE: ccaches. So:
#   1. temp krb5.conf with kdc=<DC IP>, dns_lookup_kdc=false
#   2. system /usr/bin/kinit user@REALM (--password-file=/dev/stdin) into default cache
#   3. kgetcred ldap/<dc-fqdn> to pre-fetch the service ticket
#   4. New-OpenADSession -ComputerName <IP> -AuthType Kerberos
#      -SessionOption (New-OpenADSessionOption -TargetSpnHost <fqdn>)  # no -Credential
#
# Requires patched PSOpenAD with -TargetSpnHost (vendor/PSOpenAD in this repo).

# Dot-sourced into the sidecar, which sets this too. Declared here as well so
# the file is equally strict if it is ever loaded or tested on its own.
Set-StrictMode -Version Latest

function New-OpenAdFeKrb5Config {
    param(
        [Parameter(Mandatory)][string]$Realm,
        [Parameter(Mandatory)][string]$KdcHost,
        [string]$DomainDns
    )
    $realmUpper = $Realm.Trim().ToUpperInvariant()
    $dnsLower = if ($DomainDns) { $DomainDns.Trim().ToLowerInvariant() } else { $realmUpper.ToLowerInvariant() }
    $lines = @(
        '[libdefaults]'
        "    default_realm = $realmUpper"
        '    dns_lookup_kdc = false'
        '    dns_lookup_realm = false'
        '    rdns = false'
        '    udp_preference_limit = 1'
        ''
        '[realms]'
        "    $realmUpper = {"
        "        kdc = $KdcHost"
        '    }'
        ''
        '[domain_realm]'
        "    .$dnsLower = $realmUpper"
        "    $dnsLower = $realmUpper"
    )
    $path = Join-Path ([System.IO.Path]::GetTempPath()) ("psopenad-fe-krb5-{0}.conf" -f $realmUpper.ToLowerInvariant())
    Set-Content -LiteralPath $path -Value ($lines -join "`n") -Encoding ascii -Force
    return $path
}

function Invoke-OpenAdFeKinit {
    param(
        [Parameter(Mandatory)][string]$Upn,
        [Parameter(Mandatory)][string]$Password,
        [int]$TimeoutMs = 15000
    )
    $kinit = if (Test-Path -LiteralPath '/usr/bin/kinit') { '/usr/bin/kinit' } else { 'kinit' }
    $psi = [System.Diagnostics.ProcessStartInfo]::new()
    $psi.FileName = $kinit
    [void]$psi.ArgumentList.Add('--password-file=/dev/stdin')
    [void]$psi.ArgumentList.Add($Upn)
    $psi.RedirectStandardInput = $true
    $psi.RedirectStandardOutput = $true
    $psi.RedirectStandardError = $true
    $psi.UseShellExecute = $false
    $proc = [System.Diagnostics.Process]::Start($psi)
    $proc.StandardInput.Write($Password + "`n")
    $proc.StandardInput.Close()
    $out = $proc.StandardOutput.ReadToEnd()
    $err = $proc.StandardError.ReadToEnd()
    if (-not $proc.WaitForExit($TimeoutMs)) {
        try { $proc.Kill() } catch {}
        return @{ ok = $false; message = 'kinit timed out' }
    }
    return @{ ok = ($proc.ExitCode -eq 0); message = (($out + $err).Trim()) }
}

function Test-OpenAdFeTargetSpnHostSupport {
    $cmd = Get-Command New-OpenADSessionOption -ErrorAction SilentlyContinue
    if (-not $cmd) { return $false }
    return $cmd.Parameters.ContainsKey('TargetSpnHost')
}

function ConvertTo-OpenAdFeRealmFromNamingContext {
    param([string]$DefaultNamingContext)
    if (-not $DefaultNamingContext) { return '' }
    return ((([string]$DefaultNamingContext) -split ',') |
        Where-Object { $_ -match '^DC=' } |
        ForEach-Object { $_ -replace '^DC=', '' }) -join '.'
}

function New-OpenAdFeKerberosSealedSession {
    <#
    .SYNOPSIS
        Kerberos sign+seal LDAP session on plain :389 for confidential writes (unicodePwd).
        DNS-independent: TCP to DC IP, SPN ldap/<fqdn> via -TargetSpnHost, KDC via temp krb5.conf.
        Bind is from the default ticket cache (no -Credential) - security context stays valid after
        this function restores KRB5_CONFIG / KRB5CCNAME.
    #>
    param(
        [string]$DcIp,
        [string]$DcFqdn,
        [Parameter(Mandatory)][pscredential]$BindCred,
        [string]$Realm,
        [string]$DomainDns,
        [int]$Port = 389
    )

    if (-not (Test-OpenAdFeTargetSpnHostSupport)) {
        throw 'This PSOpenAD build lacks -TargetSpnHost. Use vendor/PSOpenAD from this repo (patched build).'
    }

    $realmUpper = if ($Realm) { $Realm.Trim().ToUpperInvariant() } else { '' }
    $connectHost = if ($DcIp) { $DcIp } else { $DcFqdn }
    $spnHost = if ($DcFqdn) { $DcFqdn.Trim() } else { $DcIp }
    if (-not $realmUpper -or -not $connectHost) {
        throw 'Kerberos sealed session needs Realm and DcIp (or DcFqdn).'
    }
    if (-not $spnHost) {
        throw 'Kerberos sealed session needs DcFqdn (dnsHostName) for ldap/<fqdn> SPN.'
    }

    $soCmd = Get-Command New-OpenADSessionOption -ErrorAction Stop
    $optParams = @{}
    if ($soCmd.Parameters.ContainsKey('ConnectTimeout')) { $optParams['ConnectTimeout'] = 8000 }
    if ($soCmd.Parameters.ContainsKey('OperationTimeout')) { $optParams['OperationTimeout'] = 15000 }
    if ($soCmd.Parameters.ContainsKey('SkipCertificateCheck')) { $optParams['SkipCertificateCheck'] = $true }
    # Decouple TCP host (often an IP) from the Kerberos SPN host (DC registered FQDN).
    $optParams['TargetSpnHost'] = $spnHost

    $bareUser = $BindCred.UserName.Trim()
    if ($bareUser -match '^(.*)\\(.+)$') { $bareUser = $Matches[2] }
    elseif ($bareUser -match '^(.+)@(.+)$') { $bareUser = $Matches[1] }
    $upn = "$bareUser@$realmUpper"
    $kgetcred = if (Test-Path -LiteralPath '/usr/bin/kgetcred') { '/usr/bin/kgetcred' } else { 'kgetcred' }

    $prevKrb5 = $env:KRB5_CONFIG
    $prevCc = $env:KRB5CCNAME
    try {
        $env:KRB5_CONFIG = New-OpenAdFeKrb5Config -Realm $realmUpper -KdcHost $connectHost -DomainDns $DomainDns
        # Apple GSS reads the default/API cache, not FILE: - clear KRB5CCNAME so kinit fills that.
        Remove-Item Env:KRB5CCNAME -ErrorAction SilentlyContinue
        $kres = Invoke-OpenAdFeKinit -Upn $upn -Password ($BindCred.GetNetworkCredential().Password)
        if (-not $kres.ok) { throw "kinit ($upn) failed: $($kres.message)" }
        $null = try { & $kgetcred "ldap/$spnHost" 2>&1 } catch {}

        $lastErr = $null
        foreach ($authType in @('Kerberos', 'Negotiate')) {
            try {
                # No -Credential: bind from the ticket cache established by kinit/kgetcred.
                $s = New-OpenADSession -ComputerName $connectHost -Port $Port -AuthType $authType `
                    -SessionOption (New-OpenADSessionOption @optParams) -ErrorAction Stop
                try { $s | Add-Member -NotePropertyName _AppPort -NotePropertyValue $Port -Force -ErrorAction SilentlyContinue } catch {}
                try { $s | Add-Member -NotePropertyName _AppAuth -NotePropertyValue "$authType-seal" -Force -ErrorAction SilentlyContinue } catch {}
                return $s
            }
            catch { $lastErr = $_ }
        }
        if ($lastErr) { throw $lastErr }
        throw 'GSSAPI sign+seal bind failed'
    }
    finally {
        if ($null -ne $prevKrb5) { $env:KRB5_CONFIG = $prevKrb5 } else { Remove-Item Env:KRB5_CONFIG -ErrorAction SilentlyContinue }
        if ($null -ne $prevCc) { $env:KRB5CCNAME = $prevCc } else { Remove-Item Env:KRB5CCNAME -ErrorAction SilentlyContinue }
    }
}

function Test-OpenAdFePasswordChannel {
    <#
    .SYNOPSIS
        Non-destructive probe: LDAPS :636 Simple, else Kerberos sign+seal :389.
    #>
    param(
        [string]$DcIp,
        [string]$DcFqdn,
        [Parameter(Mandatory)][pscredential]$BindCred,
        [string]$Realm,
        [string]$DomainDns
    )

    $soCmd = Get-Command New-OpenADSessionOption -ErrorAction Stop
    $optParams = @{}
    if ($soCmd.Parameters.ContainsKey('ConnectTimeout')) { $optParams['ConnectTimeout'] = 8000 }
    if ($soCmd.Parameters.ContainsKey('OperationTimeout')) { $optParams['OperationTimeout'] = 15000 }
    if ($soCmd.Parameters.ContainsKey('SkipCertificateCheck')) { $optParams['SkipCertificateCheck'] = $true }

    $targets = @(@($DcFqdn, $DcIp) | Where-Object { $_ } | Select-Object -Unique)
    $ldapsErr = 'not attempted'
    $negErr = 'not attempted'

    foreach ($tgt in $targets) {
        try {
            $s = New-OpenADSession -ComputerName $tgt -Port 636 -UseTLS -Credential $BindCred -AuthType Simple `
                -SessionOption (New-OpenADSessionOption @optParams) -ErrorAction Stop
            try { Remove-OpenADSession -Session $s -Confirm:$false } catch {}
            return [pscustomobject]@{
                channel   = 'ldaps'
                encrypted = $true
                port      = 636
                auth      = 'Simple'
                target    = [string]$tgt
                detail    = "LDAPS :636 bind OK ($tgt)"
            }
        }
        catch { $ldapsErr = $_.Exception.Message }
    }

    try {
        $s = New-OpenAdFeKerberosSealedSession -DcIp $DcIp -DcFqdn $DcFqdn -BindCred $BindCred `
            -Realm $Realm -DomainDns $DomainDns
        if ($s) {
            $auth = 'kerberos-seal'
            if ($s.PSObject.Properties['_AppAuth']) { $auth = [string]$s._AppAuth }
            try { Remove-OpenADSession -Session $s -Confirm:$false } catch {}
            return [pscustomobject]@{
                channel   = 'kerberos-seal'
                encrypted = $true
                port      = 389
                auth      = $auth
                target    = [string]$DcIp
                detail    = "Kerberos sign+seal :389 OK ($auth)"
            }
        }
        $negErr = 'no realm/host'
    }
    catch {
        $negErr = $_.Exception.Message
    }

    return [pscustomobject]@{
        channel   = 'none'
        encrypted = $false
        port      = 0
        auth      = ''
        target    = ''
        detail    = "No confidential channel - LDAPS :636 -> $ldapsErr | Kerberos :389 -> $negErr"
    }
}

function Set-OpenAdFeAccountPassword {
    <#
    .SYNOPSIS
        Set unicodePwd over an already-confidential session (LDAPS, StartTLS, or Kerberos seal).
    #>
    param(
        [Parameter(Mandatory)]$Session,
        [Parameter(Mandatory)][string]$Identity,
        [Parameter(Mandatory)][string]$Password
    )
    $quoted = '"{0}"' -f $Password
    $bytes = [System.Text.Encoding]::Unicode.GetBytes($quoted)
    Set-OpenADObject -Session $Session -Identity $Identity -Replace @{ unicodePwd = $bytes } -ErrorAction Stop
}
