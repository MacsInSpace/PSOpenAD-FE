# Upstream report - `-AuthType Anonymous` cannot read the RootDSE

Written for [jborean93/PSOpenAD](https://github.com/jborean93/PSOpenAD). Paste
into an issue or PR. Everything below was reproduced against a live Windows AD
DC; the minimal repro needs only `ldapsearch`, not PSOpenAD.

---

## Summary

`Get-OpenADRootDSE -AuthType Anonymous` fails against a default Active Directory
domain controller with:

```
Cannot find AD RootDSE object
```

The same RootDSE read succeeds anonymously via `ldapsearch -x`. The cause is that
`Operations.LdapSearchRequest` attaches the **paged results control**
(`1.2.840.113556.1.4.319`) to *every* search, including `SearchScope.Base`
searches of the RootDSE. AD rejects that control on an anonymous connection, so
the search fails - and the real error is then discarded, producing a misleading
"not found" message.

This also leaves `New-OpenADSession -AuthType Anonymous` with an empty
`DefaultNamingContext`, since session setup performs the same RootDSE lookup.

## Environment

| | |
| --- | --- |
| PSOpenAD | 0.7.0 |
| PowerShell | 7.5.4 |
| Client OS | macOS (arm64) |
| Server | Windows AD DC, functional level 2016+, default `dSHeuristics` |

## Minimal reproduction (no PSOpenAD required)

The only difference between these two commands is the paged-results control:

```console
$ ldapsearch -x -LLL -H ldap://<dc> -s base -b "" defaultNamingContext
dn:
defaultNamingContext: DC=example,DC=com                      # works

$ ldapsearch -x -LLL -H ldap://<dc> -s base -b "" -E pr=1000/noprompt defaultNamingContext
Operations error (1)
Additional information: 000004DC: LdapErr: DSID-0C090C06, comment: In order to
perform this operation a successful bind must be completed on the connection.,
data 0, v3839                                                # fails
```

And in PSOpenAD:

```powershell
Get-OpenADRootDSE -Server <dc> -AuthType Anonymous
# Get-OpenADRootDSE: Cannot find AD RootDSE object
```

## Root cause

`src/PSOpenAD/Operations.cs`, in `LdapSearchRequest` (line ~202):

```csharp
List<LDAPControl> copiedControls = controls?.ToList() ?? new();
copiedControls.Add(new PagedResultControl(false, paginationLimit, paginationCookie));
```

The control is added unconditionally. Two consequences:

1. **A `Base` scope search can never benefit from paging** - by definition it
   returns at most one entry, so the control is pure overhead even where it is
   accepted.
2. **AD rejects the control on an anonymous connection.** The anonymous simple
   bind itself *succeeds* (`BindResponse` resultCode 0); it is the subsequent
   search carrying the control that returns `operationsError`. Confirmed from a
   `-TracePath` capture - bind succeeds, then all three searches fail with
   DSID-0C090C06.

The error is then hidden. `GetOpenADRootDSE.cs` calls `LdapSearchRequest` with
`ignoreErrors: true` and reports `FirstOrDefault() == null` as
`ItemNotFoundException("Cannot find AD RootDSE object")`, so the server's
diagnostic never reaches the user. That turns a precise, actionable LDAP error
into a dead end - worth addressing separately from the fix below.

## Proposed fix

Skip pagination when the scope cannot produce more than one entry:

```diff
   int searchId = 0;
   int paginationLimit = sizeLimit > 0 ? sizeLimit : 1000;
   byte[]? paginationCookie = null;
   bool request = true;
+
+  // A Base scope search returns at most one entry, so the paged result
+  // control can never do anything useful there. It is also actively
+  // harmful: Active Directory rejects the control on an anonymous
+  // connection with "In order to perform this operation a successful bind
+  // must be completed on the connection" (operationsError), even though
+  // the same search without controls is allowed.
+  bool usePagination = scope != SearchScope.Base;

   while (true)
   {
       if (request)
       {
           List<LDAPControl> copiedControls = controls?.ToList() ?? new();
-          copiedControls.Add(new PagedResultControl(false, paginationLimit, paginationCookie));
+          if (usePagination)
+          {
+              copiedControls.Add(new PagedResultControl(false, paginationLimit, paginationCookie));
+          }
```

Patch file: `scripts/psopenad-patches/rootdse-anonymous-paging.patch`.

## Verification

Built with `dotnet build src/PSOpenAD.Module/PSOpenAD.Module.csproj -c Release`
and tested against the live DC.

**Before** - `Get-OpenADRootDSE -AuthType Anonymous` -> `Cannot find AD RootDSE object`

**After**

```
defaultNamingContext : DC=example,DC=com
dnsHostName          : ...
SupportedSASLMechanisms : GSSAPI, GSS-SPNEGO, EXTERNAL, DIGEST-MD5
```

**No regression to paging.** A subtree search over the whole domain returns the
same count before and after - and that count exceeds AD's default 1000-entry
`MaxPageSize`, which is only reachable *with* working pagination:

| Build | `Get-OpenADObject -SearchScope Subtree -LDAPFilter '(objectClass=*)'` |
| --- | --- |
| 0.7.0 unpatched | 1388 objects |
| patched | 1388 objects |

Authenticated `connect` / `getChildren` / `listContents` / `search` flows were
also re-run against the DC and behave identically.

## Notes for a maintainer

- If some deployment genuinely needs the control on a base search, this could be
  a session option instead of unconditional behaviour - but a base-scope search
  returning <=1 entry makes that hard to justify.
- Consider surfacing the LDAP diagnostic in `Get-OpenADRootDSE` rather than
  `ignoreErrors: true` + a generic not-found. The server told us exactly what was
  wrong and the message was discarded.
