/**
 * Demo directory - used only when the UI runs outside Tauri (plain `vite dev`
 * or `vite preview`), where `invoke` has no backend to talk to.
 *
 * It exists so the console can be looked at, styled and demonstrated without a
 * domain controller. Inside the real app `isDemo()` is false and every call
 * goes to the sidecar as normal; nothing here is reachable from a Tauri build.
 *
 * The forest is deliberately generic - no tenant, school or customer shapes.
 */
import type { DirectoryRow, DomainSession, ObjectDetail } from "./api";

const NC = "DC=corp,DC=example,DC=com";

export function isDemo(): boolean {
  return (
    typeof window !== "undefined" && !("__TAURI_INTERNALS__" in window)
  );
}

export const DEMO_SESSION: DomainSession = {
  domainKey: "demo",
  label: "corp.example.com",
  server: "dc01.corp.example.com",
  username: "CORP\\administrator",
  connectionStep: "StartTLS:389 Simple",
  port: 389,
  authType: "Simple",
  startTls: true,
  useTls: false,
  passwordCapable: true,
  defaultNamingContext: NC,
  dnsHostName: "dc01.corp.example.com",
  whoami: "u:CORP\\administrator",
};

type Seed = {
  rdn: string;
  cls: string;
  desc?: string;
  sam?: string;
  display?: string;
  enabled?: boolean;
  children?: Seed[];
};

/** A small but believable forest: the containers ADUC shows on a fresh domain. */
const FOREST: Seed[] = [
  {
    rdn: "CN=Builtin",
    cls: "builtinDomain",
    children: [
      { rdn: "CN=Administrators", cls: "group", desc: "Administrators have complete and unrestricted access to the computer/domain" },
      { rdn: "CN=Backup Operators", cls: "group", desc: "Backup Operators can override security restrictions for the sole purpose of backing up or restoring files" },
      { rdn: "CN=Remote Desktop Users", cls: "group", desc: "Members in this group are granted the right to logon remotely" },
      { rdn: "CN=Users", cls: "group", desc: "Users are prevented from making accidental or intentional system-wide changes" },
    ],
  },
  {
    rdn: "CN=Computers",
    cls: "container",
    desc: "Default container for upgraded computer accounts",
    children: [
      { rdn: "CN=WKS-0148", cls: "computer", sam: "WKS-0148$", desc: "Windows 11 Pro 24H2" },
      { rdn: "CN=WKS-0212", cls: "computer", sam: "WKS-0212$", desc: "Windows 11 Pro 24H2" },
    ],
  },
  {
    rdn: "OU=Domain Controllers",
    cls: "organizationalUnit",
    desc: "Default container for domain controllers",
    children: [
      { rdn: "CN=DC01", cls: "computer", sam: "DC01$", desc: "Windows Server 2022 Datacenter" },
      { rdn: "CN=DC02", cls: "computer", sam: "DC02$", desc: "Windows Server 2022 Datacenter" },
    ],
  },
  {
    rdn: "OU=Corp",
    cls: "organizationalUnit",
    desc: "Managed accounts",
    children: [
      {
        rdn: "OU=Engineering",
        cls: "organizationalUnit",
        desc: "Engineering staff and workstations",
        children: [
          { rdn: "CN=Ada Lovelace", cls: "user", sam: "alovelace", display: "Ada Lovelace", desc: "Principal Engineer" },
          { rdn: "CN=Grace Hopper", cls: "user", sam: "ghopper", display: "Grace Hopper", desc: "Engineering Manager" },
          { rdn: "CN=Alan Turing", cls: "user", sam: "aturing", display: "Alan Turing", desc: "Research", enabled: false },
          { rdn: "CN=Engineering Staff", cls: "group", sam: "eng-staff", desc: "All engineering personnel" },
          { rdn: "CN=BUILD-01", cls: "computer", sam: "BUILD-01$", desc: "Build agent" },
        ],
      },
      {
        rdn: "OU=Finance",
        cls: "organizationalUnit",
        desc: "Finance staff",
        children: [
          { rdn: "CN=Rosalind Franklin", cls: "user", sam: "rfranklin", display: "Rosalind Franklin", desc: "Financial Controller" },
          { rdn: "CN=Finance Staff", cls: "group", sam: "fin-staff", desc: "All finance personnel" },
        ],
      },
      {
        rdn: "OU=Service Accounts",
        cls: "organizationalUnit",
        desc: "Non-interactive accounts",
        children: [
          { rdn: "CN=svc-backup", cls: "user", sam: "svc-backup", desc: "Backup service account" },
          { rdn: "CN=svc-monitor", cls: "user", sam: "svc-monitor", desc: "Monitoring service account", enabled: false },
        ],
      },
    ],
  },
  {
    rdn: "CN=Users",
    cls: "container",
    desc: "Default container for upgraded user accounts",
    children: [
      { rdn: "CN=Administrator", cls: "user", sam: "administrator", desc: "Built-in account for administering the computer/domain" },
      { rdn: "CN=Guest", cls: "user", sam: "guest", desc: "Built-in account for guest access to the computer/domain", enabled: false },
      { rdn: "CN=Domain Admins", cls: "group", sam: "Domain Admins", desc: "Designated administrators of the domain" },
      { rdn: "CN=Domain Users", cls: "group", sam: "Domain Users", desc: "All domain users" },
      { rdn: "CN=Enterprise Admins", cls: "group", sam: "Enterprise Admins", desc: "Designated administrators of the enterprise" },
      { rdn: "CN=krbtgt", cls: "user", sam: "krbtgt", desc: "Key Distribution Center Service Account", enabled: false },
    ],
  },
];

const BY_PARENT = new Map<string, DirectoryRow[]>();

function seedRow(seed: Seed, parentDn: string): DirectoryRow {
  const dn = `${seed.rdn},${parentDn}`;
  const name = seed.rdn.replace(/^[^=]+=/, "");
  const isAccount = seed.cls === "user" || seed.cls === "computer";
  return {
    distinguishedName: dn,
    name,
    objectClass: seed.cls,
    samAccountName: seed.sam ?? null,
    displayName: seed.display ?? null,
    description: seed.desc ?? null,
    userPrincipalName:
      seed.cls === "user" && seed.sam ? `${seed.sam}@corp.example.com` : null,
    mail: seed.display && seed.sam ? `${seed.sam}@example.com` : null,
    objectGuid: null,
    whenCreated: "2024-03-11T09:14:22Z",
    whenChanged: "2026-07-02T16:40:05Z",
    enabled: isAccount ? (seed.enabled ?? true) : null,
  };
}

function index(seeds: Seed[], parentDn: string) {
  const rows = seeds.map((s) => seedRow(s, parentDn));
  BY_PARENT.set(parentDn, rows);
  seeds.forEach((s, i) => {
    if (s.children) index(s.children, rows[i]!.distinguishedName);
  });
}
index(FOREST, NC);

function childrenOf(dn: string): DirectoryRow[] {
  return BY_PARENT.get(dn) ?? [];
}

function isContainerClass(cls?: string | null) {
  const c = String(cls ?? "").toLowerCase();
  return (
    c.includes("organizationalunit") ||
    c.includes("container") ||
    c.includes("builtin") ||
    c.includes("domain")
  );
}

function matchesFilter(row: DirectoryRow, filter?: string) {
  const c = String(row.objectClass ?? "").toLowerCase();
  switch (filter) {
    case "user":
      return c === "user";
    case "group":
      return c === "group";
    case "computer":
      return c === "computer";
    case "ou":
      return isContainerClass(row.objectClass);
    default:
      return true;
  }
}

function allRows(): DirectoryRow[] {
  return [...BY_PARENT.values()].flat();
}

/** Routes a Tauri command name to demo data. Unknown commands throw, loudly. */
export async function demoInvoke<T>(
  cmd: string,
  args: Record<string, unknown> = {},
): Promise<T> {
  await new Promise((r) => setTimeout(r, 90)); // enough latency to see loading states
  const one = <V,>(v: V) => v as unknown as T;

  switch (cmd) {
    case "sidecar_ping":
      return one({ ok: true, demo: true });
    case "connect_domain":
    case "connect_saved_connection":
      return one(DEMO_SESSION);
    case "list_sessions":
      return one([DEMO_SESSION]);
    case "disconnect_domain":
      return one(null);
    case "get_children":
      return one(
        childrenOf(String(args.searchBase ?? NC)).filter((r) =>
          isContainerClass(r.objectClass),
        ),
      );
    case "list_contents":
      return one(
        childrenOf(String(args.searchBase ?? NC)).filter((r) =>
          matchesFilter(r, args.filter as string),
        ),
      );
    case "search_directory": {
      const q = String(args.query ?? "").toLowerCase();
      const base = String(args.searchBase ?? NC);
      return one(
        allRows()
          .filter((r) => r.distinguishedName.endsWith(base))
          .filter((r) => matchesFilter(r, args.kind as string))
          .filter(
            (r) =>
              !q ||
              r.name.toLowerCase().includes(q) ||
              (r.samAccountName ?? "").toLowerCase().includes(q) ||
              (r.description ?? "").toLowerCase().includes(q),
          ),
      );
    }
    case "get_object": {
      const dn = String(args.identity ?? "");
      const row = allRows().find((r) => r.distinguishedName === dn);
      if (!row) throw new Error(`No such object: ${dn}`);
      const detail: ObjectDetail = {
        summary: row,
        attributes: {
          cn: row.name,
          distinguishedName: row.distinguishedName,
          objectClass: row.objectClass ?? null,
          sAMAccountName: row.samAccountName ?? null,
          displayName: row.displayName ?? null,
          description: row.description ?? null,
          userPrincipalName: row.userPrincipalName ?? null,
          mail: row.mail ?? null,
          whenCreated: row.whenCreated ?? null,
          whenChanged: row.whenChanged ?? null,
          objectCategory: `CN=Person,CN=Schema,CN=Configuration,${NC}`,
          instanceType: "4",
          uSNCreated: "12704",
          uSNChanged: "40911",
          memberOf:
            row.objectClass === "user"
              ? [`CN=Domain Users,CN=Users,${NC}`]
              : null,
        },
      };
      return one(detail);
    }
    case "get_group_membership": {
      const dn = String(args.identity ?? "");
      const parent = dn.split(",").slice(1).join(",");
      return one(childrenOf(parent).filter((r) => r.objectClass === "group"));
    }
    case "get_group_members": {
      const dn = String(args.identity ?? "");
      const parent = dn.split(",").slice(1).join(",");
      return one(
        childrenOf(parent).filter((r) => r.objectClass === "user").slice(0, 4),
      );
    }
    case "get_operations_masters":
      return one([
        { role: "PDC Emulator", holder: "DC01", ownerDn: null },
        { role: "RID Master", holder: "DC01", ownerDn: null },
        { role: "Infrastructure Master", holder: "DC01", ownerDn: null },
        { role: "Domain Naming Master", holder: "DC01", ownerDn: null },
        { role: "Schema Master", holder: "DC01", ownerDn: null },
      ]);
    case "get_service_accounts":
      return one([]);
    case "reset_computer_account":
      throw new Error(
        "Demo mode is read-only - this would change a real directory. Connect to a domain controller to use it.",
      );
    case "get_root_dse":
      return one({
        defaultNamingContext: NC,
        dnsHostName: "dc01.corp.example.com",
        forestFunctionality: "7",
      });
    case "list_saved_connections":
      return one([]);
    case "migrate_saved_connection_secrets":
      return one({ migrated: 0, failed: [] });
    case "get_sidecar_log":
      return one([
        "[sidecar] Ready (PID 0000)",
        "[sidecar] Loading PSOpenAD (first use)...",
        "[sidecar] LDAP: 192.0.2.5:389 trying LDAP:389 Simple (5000ms) as DEMO\\user",
        "[sidecar] LDAP: 192.0.2.5:389 failed: The operation has timed out.",
        "[sidecar] LDAP: 192.0.2.5:389 trying StartTLS:389 Simple (5000ms) as DEMO\\user",
        "[sidecar] LDAP: 192.0.2.5:389 bound via StartTLS:389 Simple",
        "[sidecar] (demo mode - this is sample output, not a real sidecar)",
      ]);
    case "clear_sidecar_log":
      return one(null);
    case "copy_object":
    case "set_account_enabled":
    case "move_object":
    case "rename_object":
    case "remove_object":
    case "new_object":
    case "set_attributes":
    case "add_group_member":
    case "remove_group_member":
      throw new Error(
        "Demo mode is read-only - this would change a real directory. Connect to a domain controller to use it.",
      );
    case "get_account_options":
      return one({
        identity: String(args.identity ?? ""),
        userAccountControl: 512,
        flags: {
          disabled: false, homeDirRequired: false, passwordNotRequired: false,
          passwordNeverExpires: false, smartcardRequired: false,
          trustedForDelegation: false, notDelegated: false,
          useDesKeyOnly: false, dontRequirePreauth: false,
        },
        locked: false,
        mustChangePassword: false,
        passwordLastSet: "2026-07-02T16:40:05Z",
        accountExpires: null,
      });
    case "set_account_options":
      throw new Error(
        "Demo mode is read-only - this would change a real directory. Connect to a domain controller to use it.",
      );
    case "get_protection":
      return one({ identity: String(args.identity ?? ""), protected: false });
    case "set_protection":
      throw new Error(
        "Demo mode is read-only - this would change a real directory. Connect to a domain controller to use it.",
      );
    case "get_log_options":
      return one({ verbose: false, includePwsh: false });
    case "set_log_options":
      return one({ verbose: Boolean(args.verbose), includePwsh: Boolean(args.include_pwsh) });
    case "set_account_password":
      return one({ ok: true, identity: String(args.identity ?? ""), channel: "demo" });
    default:
      throw new Error(`Demo mode has no handler for "${cmd}".`);
  }
}
