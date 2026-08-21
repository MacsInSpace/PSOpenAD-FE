# Upstream report - filter assertions built from raw values containing `(`

Written for [jborean93/PSOpenAD](https://github.com/jborean93/PSOpenAD).
Reproduced against a live Windows AD DC. Branch: `fix/raw-filter-values`.

---

## Summary

`Get-OpenADPrincipalGroupMembership` and `Get-OpenADGroupMember` fail outright
when the object's distinguished name contains a parenthesis:

```
Get-OpenADPrincipalGroupMembership -Identity 'CN=Some User (12345),OU=...'
LDAP filter value contained unescaped char '(', use '\28' instead
```

Parentheses are legal in a DN, and `Surname (employee id)` is a common naming
convention, so this makes both cmdlets unusable across a whole directory rather
than in a rare edge case.

It cannot be worked around by the caller. The failing filter is built internally
from the DN the cmdlet itself read back, so escaping the `-Identity` argument -
or switching to `-LDAPFilter "(distinguishedName=...)"` with the value escaped -
makes no difference. Verified both.

## Cause

`LDAPFilter.EncodeSimpleFilterValue` is a *parser*, not an encoder. It is
`ParseFilterValue` under another name, so passing it a raw value has two
consequences:

- an unescaped `(`, `)`, `*` or NUL raises `InvalidLDAPFilterException`, and
- a value that legitimately contains the three characters `\28` is silently
  decoded to `(`, which is a wrong result rather than an error.

Neither shows up at the call sites that pass a literal such as `"group"` or
`"person"`, which is most of them, and that is why it went unnoticed.

A filter assertion is encoded as an ASN.1 OCTET STRING
(`FilterAttributeValue.ToBytes` calls `writer.WriteOctetString(Value.Span)`) and
never becomes filter text on the wire, so a raw value needs no escaping at all.

## Fix

Adds `EncodeRawFilterValue` and uses it at the call sites that pass data rather
than syntax: the two DNs, the primary group SID and token, and the
`userPrincipalName` / `sAMAccountName` identity filters. Literal call sites are
left alone. Escaping still belongs in `SerializeFilterValue`.

## Related, not changed

`ADPrincipalIdentity.TryParseSamAccountName` excludes `(` and `)` from its
username pattern, so `-Identity 'Some User (12345)'` falls through to being
treated as a DN and fails with `BAD_NAME`. Parentheses are legal in a
sAMAccountName; the exclusion looks like it was defending against the same
unescaped-value problem. Offered to the maintainer as a follow-up rather than
folded in, since it is a behaviour decision.

## Verification

Against a live DC, unpatched then patched, same script:

| Call | Unpatched | Patched |
| --- | --- | --- |
| membership, DN with parens (direct) | fails | `gs-Staff, Domain Users` |
| membership, DN with parens (recursive) | fails | `Domain Users, gs-Staff, ls-Staff, Staff Computers` |
| group members, group DN with parens | fails | correct |

899 existing unit tests pass; 5 new ones cover the encoder and the round trip.

## What this repo does in the meantime

The sidecar did not wait for the patch. `getGroupMembership` implements the
same search itself with the DN escaped properly - see
`Get-OpenAdFeGroupMembership` in `sidecar/OpenADSidecar.ps1`. It is equivalent
to the cmdlet, primary group included, and it is kept rather than reverted so
that this path keeps working even if the vendored patch is ever dropped.
