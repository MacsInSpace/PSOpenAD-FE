<#
.SYNOPSIS
    Enforces the two project conventions that have bitten us repeatedly.

.DESCRIPTION
    1. Printable ASCII only. No em-dashes, no box drawing, no emoji, no smart
       quotes, and no stray control characters, in any tracked source or
       documentation file. Non-ASCII characters make
       diffs unreadable, break patch matching (a comment-only difference was
       enough to make an entire patch fail to apply), and render inconsistently
       across terminals and editors.

    1b. No site data. No private IP addresses and no stray email addresses in
       tracked files. The app is directory-agnostic and the repo is public;
       a test DC's address is somebody's real infrastructure.

    2. StrictMode. Every PowerShell file sets Set-StrictMode -Version Latest,
       and PSScriptAnalyzer reports no Error or Warning outside the agreed
       exclusions. StrictMode turns a silently-wrong scalar into a loud failure,
       which is what we want from a tool that writes to a directory.

    Run with no arguments to check; exits non-zero on any violation.

.PARAMETER Fix
    Repair what can be repaired mechanically: the ASCII substitutions, and a
    missing Set-StrictMode line. Everything else is reported only.

.EXAMPLE
    pwsh -File ./scripts/lint-conventions.ps1
    pwsh -File ./scripts/lint-conventions.ps1 -Fix
#>
[CmdletBinding()]
param([switch]$Fix)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$Extensions = @('.md', '.ps1', '.ts', '.tsx', '.css', '.json', '.html', '.rs', '.toml')

# vendor/, PSOpenAD/ and psmodules/ are other people's code - the vendored
# vault modules must stay byte-identical across products, so never lint or
# "fix" them here. node_modules and target are build output.
$ExcludePattern = 'node_modules|[\\/]\.git[\\/]|src-tauri[\\/]target|[\\/]dist[\\/]|[\\/]PSOpenAD[\\/]|[\\/]vendor[\\/]|[\\/]psmodules[\\/]|package-lock\.json|Cargo\.lock'

# What to write instead. UI glyphs use an HTML entity or a \u escape so the
# source file stays ASCII while the rendered output is unchanged.
$Replacements = [ordered]@{
    [char]0x2500 = '-'; [char]0x2550 = '='; [char]0x2502 = '|'
    [char]0x250C = '+'; [char]0x2510 = '+'; [char]0x2514 = '+'; [char]0x2518 = '+'
    [char]0x251C = '+'; [char]0x2524 = '+'; [char]0x252C = '+'; [char]0x2534 = '+'
    [char]0x2014 = '-'; [char]0x2013 = '-'
    [char]0x2192 = '->'; [char]0x2190 = '<-'; [char]0x2191 = '^'; [char]0x2193 = 'v'
    [char]0x2194 = '<->'; [char]0x2026 = '...'; [char]0x00B7 = '-'; [char]0x2022 = '*'
    [char]0x00A7 = 'section '; [char]0x2264 = '<='; [char]0x2265 = '>='
    [char]0x201C = '"'; [char]0x201D = '"'; [char]0x2018 = "'"; [char]0x2019 = "'"
    [char]0x26A0 = 'WARNING'; [char]0x2713 = 'OK'; [char]0x2717 = 'FAIL'
}

$violations = 0

# ---- 1. ASCII only ----------------------------------------------------------

Write-Host "ASCII check" -ForegroundColor Cyan
$files = @(Get-ChildItem -Path $RepoRoot -Recurse -File |
    Where-Object { $Extensions -contains $_.Extension -and $_.FullName -notmatch $ExcludePattern })

foreach ($file in $files) {
    $text = Get-Content -Raw -LiteralPath $file.FullName -Encoding utf8
    if ([string]::IsNullOrEmpty($text)) { continue }

    # Control characters count as offenders too, even though they are ASCII.
    # A NUL sitting in a string literal in ConsoleTree.tsx made grep treat the
    # whole file as binary, so every search of it silently returned nothing -
    # which cost a debugging cycle before anyone thought to question the tool.
    # Tab, CR and LF are legitimate.
    $offenders = [System.Collections.Generic.SortedSet[char]]::new()
    foreach ($ch in $text.ToCharArray()) {
        $code = [int]$ch
        if ($code -gt 127) { [void]$offenders.Add($ch) }
        elseif ($code -lt 32 -and $code -notin @(9, 10, 13)) { [void]$offenders.Add($ch) }
        elseif ($code -eq 127) { [void]$offenders.Add($ch) }
    }
    if ($offenders.Count -eq 0) { continue }

    $rel = $file.FullName.Substring($RepoRoot.Length + 1)
    if ($Fix) {
        $fixed = $text
        foreach ($ch in @($offenders)) {
            if ($Replacements.Contains($ch)) { $fixed = $fixed.Replace([string]$ch, $Replacements[$ch]) }
        }
        $stillBad = @($fixed.ToCharArray() | Where-Object {
                [int]$_ -gt 127 -or [int]$_ -eq 127 -or ([int]$_ -lt 32 -and [int]$_ -notin @(9, 10, 13))
            })
        Set-Content -LiteralPath $file.FullName -Value $fixed -NoNewline -Encoding utf8
        if ($stillBad.Count -gt 0) {
            $codes = ($stillBad | Sort-Object -Unique | ForEach-Object { 'U+{0:X4}' -f [int]$_ }) -join ' '
            Write-Host "  MANUAL $rel - no safe substitution for $codes" -ForegroundColor Yellow
            Write-Host "         In JSX text use an HTML entity (&#10005;); in a JS string use a \uXXXX escape." -ForegroundColor DarkGray
            $violations++
        }
        else {
            Write-Host "  fixed  $rel" -ForegroundColor Green
        }
    }
    else {
        $codes = (@($offenders) | ForEach-Object { 'U+{0:X4}' -f [int]$_ }) -join ' '
        Write-Host "  FAIL   $rel - $codes" -ForegroundColor Red
        $violations++
    }
}
if ($violations -eq 0) { Write-Host "  all $($files.Count) files are ASCII" -ForegroundColor Green }

# ---- 1b. No site data -------------------------------------------------------
#
# This app is directory-agnostic. Test environments are somebody's real
# infrastructure, and this repo is public, so a DC address or a work email that
# wanders in from a debugging session is a leak rather than a detail. Both have
# happened, which is why this check exists.
#
# Deliberately generic: private IPv4 literals and unexpected email addresses.
# Naming a customer's domains here would defeat the purpose.

Write-Host "`nSite data" -ForegroundColor Cyan
$siteViolations = 0

# RFC 5737 / RFC 2606 are the ranges and names reserved for documentation.
$AllowedEmails = @('craig.hair@gmail.com', 'noreply@anthropic.com')
$privateIp = '(?<![\d.])(?:10\.\d{1,3}\.\d{1,3}\.\d{1,3}|172\.(?:1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3}|192\.168\.\d{1,3}\.\d{1,3})(?![\d.])'
$emailPattern = '[A-Za-z0-9._%%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}'

foreach ($file in $files) {
    $text = Get-Content -Raw -LiteralPath $file.FullName -Encoding utf8
    if ([string]::IsNullOrEmpty($text)) { continue }
    $rel = $file.FullName.Substring($RepoRoot.Length + 1)

    $ips = @([regex]::Matches($text, $privateIp) | ForEach-Object { $_.Value } | Sort-Object -Unique)
    if ($ips.Count -gt 0) {
        Write-Host "  FAIL   $rel - private IP address: $($ips -join ' ')" -ForegroundColor Red
        Write-Host "         Use a documentation range (192.0.2.0/24) or drop it." -ForegroundColor DarkGray
        $siteViolations++
    }

    $mails = @([regex]::Matches($text, $emailPattern) | ForEach-Object { $_.Value } |
        Where-Object {
            $_ -notin $AllowedEmails -and
            $_ -notmatch '@example\.(com|org|net)$' -and
            # "128x128@2x.png" is an asset, not an address.
            $_ -notmatch '\.(png|jpg|jpeg|gif|svg|webp|ico|icns|css|json|md|ts|tsx|js|html|ps1|psd1|psm1|rs|toml|lock|patch|txt|ps1xml)$'
        } |
        Sort-Object -Unique)
    if ($mails.Count -gt 0) {
        Write-Host "  FAIL   $rel - unexpected email address: $($mails -join ' ')" -ForegroundColor Red
        $siteViolations++
    }
}
if ($siteViolations -eq 0) {
    Write-Host "  no private addresses or stray emails in $($files.Count) files" -ForegroundColor Green
}
else { $violations += $siteViolations }

# ---- 2. StrictMode declared -------------------------------------------------

Write-Host "`nStrictMode check" -ForegroundColor Cyan
$psFiles = @(Get-ChildItem -Path $RepoRoot -Recurse -File -Filter *.ps1 |
    Where-Object { $_.FullName -notmatch $ExcludePattern })

foreach ($ps in $psFiles) {
    $text = Get-Content -Raw -LiteralPath $ps.FullName
    $rel = $ps.FullName.Substring($RepoRoot.Length + 1)
    if ($text -match '(?m)^\s*Set-StrictMode\s+-Version\s+Latest') {
        Write-Host "  ok     $rel" -ForegroundColor Green
        continue
    }
    if ($Fix) {
        Set-Content -LiteralPath $ps.FullName -Value ("Set-StrictMode -Version Latest`n`n" + $text) -NoNewline
        Write-Host "  fixed  $rel" -ForegroundColor Green
    }
    else {
        Write-Host "  FAIL   $rel - missing Set-StrictMode -Version Latest" -ForegroundColor Red
        $violations++
    }
}

# ---- 3. PSScriptAnalyzer ----------------------------------------------------

Write-Host "`nPSScriptAnalyzer" -ForegroundColor Cyan
if (-not (Get-Module -ListAvailable PSScriptAnalyzer)) {
    Write-Host "  skipped - not installed (Install-Module PSScriptAnalyzer)" -ForegroundColor Yellow
}
else {
    # Excluded deliberately: Write-Host is how this script talks to the operator;
    # the sidecar's state-changing verbs are an internal JSON protocol, not
    # cmdlets a user pipes into; the credential rules fire on a sidecar that
    # exists precisely to carry a password to LDAP.
    $exclude = @(
        'PSAvoidUsingWriteHost'
        'PSUseShouldProcessForStateChangingFunctions'
        'PSAvoidUsingPlainTextForPassword'
        'PSAvoidUsingConvertToSecureStringWithPlainText'
        'PSUseSingularNouns'
        'PSAvoidUsingEmptyCatchBlock'
    )
    $found = 0
    foreach ($ps in $psFiles) {
        $issues = @(Invoke-ScriptAnalyzer -Path $ps.FullName -Severity Error, Warning -ExcludeRule $exclude)
        foreach ($i in $issues) {
            Write-Host ("  FAIL   {0}:{1} [{2}] {3}" -f $ps.Name, $i.Line, $i.RuleName, $i.Message) -ForegroundColor Red
            $found++
        }
    }
    if ($found -eq 0) { Write-Host "  no Error or Warning findings" -ForegroundColor Green }
    $violations += $found
}

Write-Host ""
if ($violations -eq 0) {
    Write-Host "Conventions OK." -ForegroundColor Green
    exit 0
}
Write-Host "$violations violation(s). Run with -Fix for the mechanical ones." -ForegroundColor Yellow
exit 1
