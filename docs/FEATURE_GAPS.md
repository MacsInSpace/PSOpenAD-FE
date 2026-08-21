# Feature gaps against ADUC

What PSOpenAD-FE does not do yet, ordered by how often an AD admin actually
needs it. Compiled 2026-08-21 from PSOpenAD's own cmdlet documentation
(`PSOpenAD/docs/en-US/`), ADUC's menu and property-sheet structure, and
**feasibility probes run against a live DC** - every "verified" below was
executed, not assumed.

PSOpenAD ships 21 cmdlets; the sidecar currently uses 11.

---

## Status 2026-08-21

Tier 1, Tier 2 and Tier 3 are **done**, bar Saved Queries. Tier 4 stands.

The vendor was rebuilt this session, so `Restore-OpenADObject` is now available
to the app and the recorded `knownDrift` is cleared.

### Upstream patches carried

| Branch | State |
| --- | --- |
| `fix/rootdse-anonymous-paging` | raised with jborean93 as an issue |
| `fix/raw-filter-values` | pushed to the fork, not yet raised |
| `feat/restore-openadobject` | pushed to the fork, not yet raised |

All three are vendored, so the app has them regardless of what upstream does.
`raw-filter-values` matters beyond Member Of: `Get-OpenADGroupMember` backs the
Members tab and fails the same way, and a group inherits any parenthesis in its
OU path, so the fix is what makes Members reliable here.

### Not yet verified against a live DC

The Recycle Bin work was written and built while the test DC was unreachable
(off the corporate VPN). Dispatch, types and the build are checked; the
directory round trip is not. Verify before relying on it:

- Deleted Objects node appears only when the forest feature is on
- the listing shows last known parent and deletion time
- Restore returns an object to its original parent
- Restore To... handles a deleted original parent
- a recycled object is offered no Restore at all

## Already done

Browse, search, Find, Properties (editable), Attribute Editor, New
(user/group/computer/contact/OU), Move, Rename, Delete, Enable/Disable,
Reset Password (via Kerberos seal), Members and Member Of with a picker,
Protect from accidental deletion, multi-select with bulk operations,
Sidecar Log.

---

## Tier 1 - daily helpdesk work, missing, and all cheap

These are what a school IT person does most days. Each was probed against the
DC and **works**; the only reason they are absent is that nothing calls them.

| Gap | Why it matters | Verified |
| --- | --- | --- |
| **Unlock account** | The single most common helpdesk task after a password reset. Set `lockoutTime = 0` | yes |
| **Show locked / expired state** | You cannot unlock what you cannot see. Needs `lockoutTime` and `accountExpires` surfaced in the list and Account tab | reads fine |
| **User must change password at next logon** | Paired with almost every password reset. Set `pwdLastSet = 0` | yes |
| **Password never expires / cannot change password / smartcard required / no preauth** | The `userAccountControl` checkbox block on ADUC's Account tab. We only toggle the disable bit | yes |
| **Account expires** | Temp and casual staff, student teachers. Set `accountExpires` | yes |

Effort: small. One sidecar method (`setAccountOptions`) plus an Account tab
that looks like ADUC's, since all five are the same attribute family.

**Note:** `pwdLastSet`, `lockoutTime` and `userAccountControl` are currently in
the Attribute Editor's read-only list. That is right - they should be driven by
named controls (Unlock, Must change password) rather than typed as raw
integers - but it does mean the capability is unreachable today.

## Tier 2 - common, straightforward

| Gap | Why it matters | Notes |
| --- | --- | --- |
| **The rest of the General/Address/Telephones/Organization fields** | `givenName`, `sn`, `initials`, office, `telephoneNumber`, `mobile`, street, city, state, postcode, country, company | Just more fields; the write path is proven. `manager` is DN-valued and wants the object picker |
| **Move via the tree** | Move exists but demands a typed DN, which is the weakest thing shipped. The picker and tree both already exist | Usability, not capability |
| **Copy user from template** | ADUC's Copy. In a school this is how a new staff account gets made: clone the OU, group memberships and standard attributes | Composite of existing methods |
| **Group scope and type** | `groupType`. Also fixes the Type column, which says "Group" where ADUC says "Security Group - Global" | Read verified |
| **Managed By** | `managedBy` on OUs, groups and computers. Common for delegation records | DN-valued, needs the picker |
| **Nested Member Of** | `memberOf` shows only direct membership. `Get-OpenADPrincipalGroupMembership -Recursive` gives the real answer, and the primary group, which `memberOf` never lists | verified |
| **Multi-valued attribute editing** | `Set-OpenADObject -Add/-Remove` exists and works. The Attribute Editor currently shows multi-valued attributes read-only | verified |
| **Export List** | ADUC has it on every result pane. CSV of what is on screen | trivial |
| **Custom LDAP filter** | ADUC's View > Filter Options. The View dropdown only does object classes; a raw LDAP filter box is far more powerful and the search path already accepts one | small |

## Tier 3 - less common, still worth having

| Gap | Notes |
| --- | --- |
| **Saved Queries that persist** | The tree node exists but holds only the last search. ADUC saves named queries with a filter and scope. Local JSON, no directory involvement |
| ~~**Add/Remove Columns**~~ | **Done.** Columns come from a registry in `app/src/lib/columns.ts`, chosen through View > Add/Remove Columns and remembered per list |
| ~~**Browse deleted objects (Recycle Bin)**~~ | **Done.** A Deleted Objects node under the domain, shown only when the forest feature is on, with Restore and Restore To... |
| **Operations Masters (FSMO)** | Read-only, from RootDSE and the domain object. Rare but reassuring |
| **Managed service accounts** | `Get-OpenADServiceAccount` for gMSA/MSA. Unused today |
| **Computer: Reset Account** | Occasionally needed when a machine loses its trust relationship |
| **Typed getters** | We use `Get-OpenADObject` generically; `Get-OpenADUser`/`Group`/`Computer` return richer, better-typed defaults. Internal quality, no visible feature |

## Tier 4 - hard, low value, or not applicable

| Gap | Why it is here |
| --- | --- |
| **Security tab (full ACL editor)** | We can read and write security descriptors - protect-from-deletion proves it - but a real DACL editor with inheritance, object-type ACEs and canonical ordering is a project in itself, not a tab |
| **Delegate Control wizard** | Writes ACE templates, so it depends on the ACL work above |
| ~~**Restore from the Recycle Bin**~~ | **Done.** `Restore-OpenADObject` is vendored and wired to the Deleted Objects node. Still pushed as `feat/restore-openadobject` for upstream |
| **Terminal Services / Dial-in / COM+ / Published Certificates tabs** | Legacy tabs almost nobody opens |
| **Raise domain or forest functional level** | Rare, irreversible, and a bad fit for a cross-platform tool |
| **Manage, Resultant Set of Policy, Send Mail** | Windows-only shell integration. Not meaningful from macOS |
| **Group Policy management** | A different snap-in (GPMC), not ADUC. Out of scope |

---

## Suggested order

1. Tier 1 as one piece of work - an ADUC-shaped Account tab. Biggest daily
   payoff for the least code, and it is the most obvious absence to anyone who
   opens the app expecting ADUC.
2. Move-via-tree, then the remaining General/Organization fields. Both are
   finishing work on things that already half-exist.
3. Copy user - the highest-value composite, and the one most specific to how
   schools actually create accounts.
4. Nested Member Of and group scope, which make what is already on screen
   correct rather than merely present.
5. Everything else as it comes up.

## One caveat on the probe

`manager` failed in the feasibility run, but the DN I used was a guess at an
existing account rather than a real one, so that is most likely a bad test
rather than a missing capability. Re-check before planning around it.
