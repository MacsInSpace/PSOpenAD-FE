# Release notes

## 1.0.1 - 2026-08-22

Bug fixes found in use, and two additions. **Upgrade from 1.0.0 is worth doing**
- one of these was applying every bulk operation twice.

### Fixed

- **Bulk operations ran twice.** Delete, Move, Enable, Disable and Add to group
  all applied themselves to every selected object twice over. Delete was the
  only one that showed it, because a second delete fails: "0 succeeded, 3
  failed" was three accounts deleted successfully and then deleted again, with
  the second attempt's failure being the one reported. A second Disable just
  succeeds quietly, which is why the others went unnoticed.
- **The bulk dialog could hang for ever** on "Deleting 1 of 2..." without
  running anything at all.
- **A stuck directory call could freeze the whole app**, with no cancel and no
  recovery but force-quit. Requests now have a deadline; a wedged sidecar is
  replaced rather than left holding every later call behind it.
- **A delete is now reported by what the directory says**, not by the result
  code alone. An object that is gone reports success even if the server
  complained on the way.
- **The reason column no longer truncates**, so a failure explains itself
  instead of stopping at the distinguished name.
- **Nine property-sheet tabs fit on one row**; Attribute Editor was being
  clipped out of reach.
- **Browsing to another domain in the forest** names the domain the object
  lives in and how to reach it, instead of a bare LDAP referral.
- **Very large containers** no longer time out the console tree, and the status
  bar says when a container holds more than the pane is showing rather than
  reporting the cap as a total.

### Added

- **Multi-select properties.** ADUC's shared property sheet: General, Address
  and Organization, every field with a checkbox, only ticked fields written to
  every selected object. A ticked field left empty clears that attribute, and
  nothing is written until a summary of exactly what changes has been confirmed.
- **An Attributes tab** on that sheet for any attribute the schema allows, with
  `%attributeName%` substitution resolved per object - so
  `%givenName%.%sn%@example.com` gives each user their own. Every selected
  object is checked before anything is written, and Apply is refused while any
  of them cannot resolve.
- **Sample data from the connect screen**, so a downloaded build can be tried
  without a directory, an account, or anything to break.

### Note for macOS

Signed with a Developer ID and notarised by Apple, so it opens normally where
the machine can reach Apple at first launch - Gatekeeper fetches the ticket
then.

The ticket is not stapled into the bundle, so a first launch with no route to
Apple will still be refused. If that is you, clear the quarantine flag:

```bash
xattr -dr com.apple.quarantine /Applications/PSOpenAD.app
```

## 1.0.0 - 2026-08-21

First release. A cross-platform Active Directory Users and Computers, built as
a desktop app over a PowerShell sidecar that talks to the directory through
[PSOpenAD](https://github.com/jborean93/PSOpenAD). PSOpenAD is jborean93's
work; this project vendors it and contributes fixes back.

The design goal is recognition, not novelty: someone who has used ADUC should
open this and already know how to drive it.

![The console](docs/screenshots/console.png)

### What you can do

**Browse and find.** The console tree, a sortable result pane, Find across the
domain (Ctrl+F), a raw LDAP filter under View > Filter Options, and Export List.
View > Add/Remove Columns chooses what the pane shows, remembered per list.

**Manage objects.** New user, group, computer, contact and OU; Move, with a
browser for the destination rather than a typed distinguished name; Rename;
Delete; Copy a user from a template; protect from accidental deletion. Multi-
select with bulk Move, Delete, Enable, Disable and Add to group.

**Manage accounts.** The Account tab as ADUC has it: logon names, lockout status
with Unlock, password last set, the account-options checkboxes, and account
expiry. Enable and Disable. Reset Password over a Kerberos-sealed channel.

![A user's Account tab](docs/screenshots/properties-account.png)

**Groups.** Members and Member Of, both editable through an object picker.
Member Of shows the real answer - nested membership and the primary group -
not just the `memberOf` attribute. Group scope and type are shown and the Type
column reads "Security Group - Global" as ADUC does.

**Property sheets.** General, Address, Account, Telephones, Organization,
Member Of, Managed By, Object and the Attribute Editor, which can add, edit and
remove values including multi-valued attributes.

![The Attribute Editor](docs/screenshots/attribute-editor.png)

**Recycle Bin.** A Deleted Objects node under the domain, shown when the forest
has the feature enabled. Restore puts an object back where it was; Restore
To... picks somewhere else, for when the original container was deleted too.

**Forest.** Operations Masters (read-only), managed service accounts, and a
computer's Reset Account.

**Connections.** Several domains at once as tabs. A connection ladder tries
389, StartTLS, the Global Catalog and LDAPS in turn and reports which rung it
landed on. Saved connections keep their password in an encrypted local vault,
not in the OS credential store, so there are no keychain prompts.

### Things worth knowing

- **PowerShell 7 is required** and is the one dependency the app cannot carry.
  If it is missing the app says so at startup and offers the download page.
  Everything else - PSOpenAD, the secret vault modules, the sidecar - is inside
  the bundle.
- A container holding more objects than the pane will show says so in the
  status bar ("First 500 object(s) - this container holds more") rather than
  reporting a false count.
- Browsing to an object in another domain of the forest names the domain it
  lives in and how to reach it, instead of surfacing a raw LDAP referral.
- The macOS build is signed with a Developer ID but not notarised. On first
  launch, right-click the app and choose Open.

### Contributed upstream

Three fixes to PSOpenAD were found while building this and are offered on the
fork:

- `Get-OpenADRootDSE -AuthType Anonymous` failed against a default domain
  controller because a paged-results control was attached to a base-scope
  search. Raised as an issue.
- `Get-OpenADPrincipalGroupMembership` and `Get-OpenADGroupMember` failed for
  any object whose distinguished name contains a parenthesis, because a raw
  value was passed through the filter-text parser.
- `Restore-OpenADObject`, a new cmdlet for the Recycle Bin.

### Platforms

macOS, as a universal binary (Apple silicon and Intel), in this release. The
code has no macOS-specific paths beyond locating PowerShell, but Windows and
Linux builds are untested.
