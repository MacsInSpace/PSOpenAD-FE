# Very large containers, and browsing across domains

Two things that only show up against a big directory. Both were found by
pointing the console at a container holding several hundred thousand accounts,
and both are fixed. Names below are RFC 2606 examples; this app is not tied to
any particular directory and nothing site-specific belongs in this repo.

## Very large containers

### The console tree used to time out

`getChildren` ran **unbounded**. To find the handful of sub-OUs in a container,
the server has to walk every child of it, so on a container with hundreds of
thousands of children the expansion hit the 15s operation timeout and failed
outright:

```
Timeout while waiting response of 7
```

It is now bounded. `Select-Object -First` stops the pipeline, so PSOpenAD stops
asking for pages rather than reading the lot. A tree node with more than a
thousand child containers is not usable as a tree, so the cap costs nothing
real.

### The result pane used to lie

The pane caps at 500 rows, and the status bar said `500 object(s)`. For a
container holding orders of magnitude more that is not a rounding error - it is
the wrong answer to the question the status bar appears to be answering, and
nothing on screen let the reader tell.

`listContents` now asks for one row past the cap and discards it, which is
enough to know the cap was reached. The status bar says so and points at the
tools that actually narrow a search:

> First 500 object(s) - this container holds more. Use Find, or View > Filter
> Options, to narrow it.

### Timings, for whoever tunes this later

Measured through the sidecar, connect included, over a VPN:

| Query | Result |
| --- | --- |
| `listContents` limit 500 | 500 rows, ~3.7s |
| `listContents` limit 2000 | 2000 rows, ~11s |

Near enough linear, about 5ms per row. The 500 cap is a couple of seconds of
work and the pane stays responsive.

The result pane is **not virtualised** - `ObjectList` renders one `<tr>` per
row. 500 is comfortable, 2000 is noticeably slow to scroll, and tens of
thousands is not worth attempting. If the cap is ever raised, virtualise first.
Raising it alone only moves the failure from a wrong number to a frozen window.

### Working with a huge container

Do not try to make the pane show all of it. Use Find, or View > Filter Options
with a real LDAP filter, and let the directory do the narrowing - which is what
an AD admin would do in ADUC, for the same reason.

## Browsing across domains

A plain LDAP bind on 389 to a domain controller of one domain cannot read
another domain's naming context. The server answers with a referral, which
PSOpenAD used to surface raw:

```
Referral - 0000202B: RefErr: DSID-03154294, data 0, 1 access points
```

That tells a reader nothing they can act on. In a forest where accounts are
split across domains - staff in one, students or service accounts in a child
domain, which is a common shape - it is not even a rare case.

The sidecar now names the domain the object actually lives in, the domain the
connection is serving, and what to do about it:

> `'OU=Accounts,DC=sub,DC=example,DC=com'` is in `sub.example.com`, but this
> connection is to `example.com`. Connect to a domain controller for
> `sub.example.com`, or reconnect on the Global Catalog port (3268), which
> serves every domain in the forest.

There are two ways across, and the Global Catalog is usually the cheaper one:

| Route | Port | Good for | Limit |
| --- | --- | --- | --- |
| Global Catalog on the same DC | 3268 | browsing and searching any domain in the forest | partial attribute set, read-only |
| A DC of the other domain | 389 | full attributes, writes | a second connection to manage |

### Do not infer forest membership from the DNS name

Whether to offer the Global Catalog depends on whether the target is in the
**same forest**, and the GC only replicates its own forest. That question cannot
be answered from the name: `sub.example.com` may be a child domain of
`example.com` in one forest, or a separate forest entirely, and a trusted forest
can carry any name at all.

So `Test-OpenAdFePartitionInForest` asks the directory instead.
`CN=Partitions,<configuration NC>` holds a `crossRef` for every partition of the
forest you are connected to, so a `crossRef` whose `nCName` matches the target's
naming context means same forest, and no match means another one. It runs only
on the error path, and a failure there falls back to the safe wording rather
than replacing a useful message with a worse one.

This was originally written the other way, guessing from the DNS suffix, and it
got a real environment wrong in both directions at once. The lesson is the
general one this project keeps relearning: ask the directory, do not infer from
a name that merely looks authoritative.
