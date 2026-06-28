// Generates a unique, randomized incident "brief" for each solo game: a sector, a threat
// actor, tooling, and a consistent set of IOCs (indicators of compromise). The narrator
// weaves these in so every game is distinct and internally consistent, and so the story
// references the same attacker IP / C2 domain / account throughout.

const pick = (a) => a[Math.floor(Math.random() * a.length)];
const ri = (lo, hi) => lo + Math.floor(Math.random() * (hi - lo + 1));
const sample = (a, n) => {
  const c = [...a];
  const out = [];
  while (out.length < n && c.length) out.push(c.splice(Math.floor(Math.random() * c.length), 1)[0]);
  return out;
};

const SECTORS = [
  "a regional hospital network", "a county water utility", "a fintech startup", "a state university",
  "a logistics & freight company", "a municipal government", "a mid-market e-commerce retailer",
  "a biotech research firm", "a rural electric co-op", "a managed services provider (MSP)",
  "an online gaming studio", "a regional insurance carrier", "a defense subcontractor",
  "a SaaS HR-software vendor", "a community credit union", "an oil & gas pipeline operator",
];
const ACTORS = [
  "a financially-motivated intrusion crew", "a suspected state-aligned group", "a ransomware affiliate",
  "an initial-access broker", "a hacktivist collective", "an opportunistic commodity-malware operator",
  "a double-extortion ransomware gang", "an insider who sold their credentials",
];
const TOOLING = [
  "a Cobalt Strike beacon", "a Sliver implant", "a custom PowerShell loader", "Qakbot",
  "a Go-based RAT", "Mimikatz", "a living-off-the-land toolkit (certutil, wmic, rundll32)",
  "AsyncRAT", "BumbleBee", "Impacket's wmiexec", "a SOCKS proxy over a compromised host",
];
const ATTACK = [
  "T1566 Phishing", "T1190 Exploit Public-Facing Application", "T1059.001 PowerShell",
  "T1021.001 Remote Desktop Protocol", "T1486 Data Encrypted for Impact", "T1071.001 Web Protocols (C2)",
  "T1547 Boot/Logon Autostart", "T1003 OS Credential Dumping", "T1567.002 Exfil to Cloud Storage",
  "T1505.003 Web Shell", "T1078 Valid Accounts", "T1219 Remote Access Software",
];
const HOST_PREFIX = ["WKSTN", "HR", "FIN", "DC01", "SQL", "VPN", "BUILD", "LAB", "OPS", "WEB", "CITRIX", "BACKUP"];
const ACCOUNTS = ["svc-backup", "j.doe", "m.smith", "helpdesk", "sqlsvc", "oracle", "k.patel", "r.nguyen", "adm-temp", "scanner"];
const C2_WORDS = ["cdn-edge", "update-sync", "cloud-metric", "mail-relay", "telemetry-hub", "api-gw", "static-assets", "analytics-cdn", "ntp-pool", "vault-sync", "patch-mirror"];

function randIP() {
  return `${ri(11, 223)}.${ri(0, 255)}.${ri(0, 255)}.${ri(1, 254)}`;
}
function randDomain() {
  const tld = pick([".com", ".net", ".io", ".xyz", ".live", ".cloud", ".top", ".app"]);
  const suf = pick(["", "-svc", "-prod", "-cdn", "-01", "-edge"]);
  return `${pick(C2_WORDS)}${suf}${tld}`;
}
function randHash() {
  const h = "0123456789abcdef";
  let s = "";
  for (let i = 0; i < 64; i++) s += h[Math.floor(Math.random() * 16)];
  return s;
}

export function buildScenario(chainNames = [], theme = "") {
  return {
    sector: theme && theme.trim() ? theme.trim() : pick(SECTORS),
    actor: pick(ACTORS),
    tooling: pick(TOOLING),
    chain: chainNames, // the real attack-card technique names (hidden from the player)
    iocs: {
      ip: randIP(),
      c2: randDomain(),
      port: pick([443, 8443, 53, 4444, 8080, 1080, 9001, 3389, 445, 5985]),
      hash: randHash(),
      account: pick(ACCOUNTS),
      host: `${pick(HOST_PREFIX)}-${String(ri(1, 99)).padStart(2, "0")}`,
      cve: `CVE-20${ri(19, 25)}-${ri(1000, 49999)}`,
      attack: sample(ATTACK, 3),
    },
  };
}

// Compact, human/LLM-readable facts block (also used to fill offline fallbacks).
export function scenarioFacts(sc) {
  if (!sc) return "";
  const i = sc.iocs;
  return [
    `Sector: ${sc.sector}. Threat actor: ${sc.actor}. Tooling: ${sc.tooling}.`,
    `IOCs (stay consistent with these): attacker IP ${i.ip}, C2 ${i.c2}:${i.port}, ` +
      `SHA-256 ${i.hash.slice(0, 18)}…, compromised account "${i.account}", host ${i.host}, ` +
      `${i.cve}, ATT&CK ${i.attack.join(" / ")}.`,
  ].join("\n");
}
