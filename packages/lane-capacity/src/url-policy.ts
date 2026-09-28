type Ipv4 = [number, number, number, number];
type Ipv6 = [number, number, number, number, number, number, number, number];

function parseIpv4(hostname: string): Ipv4 | null {
  const parts = hostname.split(".");
  if (parts.length !== 4) return null;
  const bytes: number[] = [];
  for (const part of parts) {
    if (!/^(?:0|[1-9]\d{0,2})$/.test(part)) return null;
    const value = Number(part);
    if (value > 255) return null;
    bytes.push(value);
  }
  return bytes as Ipv4;
}

function parseIpv6(hostname: string): Ipv6 | null {
  const input = hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (!input.includes(":") || input.includes("%") || input.split("::").length > 2) return null;

  const parseSide = (side: string): number[] | null => {
    if (!side) return [];
    const parts = side.split(":");
    const output: number[] = [];
    for (let index = 0; index < parts.length; index += 1) {
      const part = parts[index]!;
      if (part.includes(".")) {
        if (index !== parts.length - 1) return null;
        const ipv4 = parseIpv4(part);
        if (!ipv4) return null;
        output.push((ipv4[0] << 8) | ipv4[1], (ipv4[2] << 8) | ipv4[3]);
      } else {
        if (!/^[0-9a-f]{1,4}$/.test(part)) return null;
        output.push(Number.parseInt(part, 16));
      }
    }
    return output;
  };

  const halves = input.split("::");
  const left = parseSide(halves[0] ?? "");
  const right = parseSide(halves[1] ?? "");
  if (!left || !right) return null;
  if (halves.length === 1) return left.length === 8 ? left as Ipv6 : null;
  if (left.length + right.length >= 8) return null;
  return [...left, ...Array(8 - left.length - right.length).fill(0), ...right] as Ipv6;
}

function isReservedIpv4(bytes: Ipv4): boolean {
  const [a, b, c] = bytes;
  return a === 0 ||
    a === 10 ||
    (a === 100 && b >= 64 && b <= 127) ||
    a === 127 ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 0 && c === 0) ||
    (a === 192 && b === 0 && c === 2) ||
    (a === 192 && b === 88 && c === 99) ||
    (a === 192 && b === 168) ||
    (a === 198 && (b === 18 || b === 19)) ||
    (a === 198 && b === 51 && c === 100) ||
    (a === 203 && b === 0 && c === 113) ||
    a >= 224;
}

function isReservedIpv6(words: Ipv6): boolean {
  const allZero = words.every((word) => word === 0);
  const loopback = words.slice(0, 7).every((word) => word === 0) && words[7] === 1;
  const ipv4Mapped = words.slice(0, 5).every((word) => word === 0) && words[5] === 0xffff;
  if (ipv4Mapped) {
    return isReservedIpv4([
      words[6] >> 8,
      words[6] & 0xff,
      words[7] >> 8,
      words[7] & 0xff,
    ]);
  }
  return allZero ||
    loopback ||
    (words[0] & 0xfe00) === 0xfc00 ||
    (words[0] & 0xffc0) === 0xfe80 ||
    (words[0] & 0xff00) === 0xff00 ||
    (words[0] === 0x0064 && words[1] === 0xff9b && words[2] === 0x0000 && words[3] === 0x0000 && words[4] === 0x0000 && words[5] === 0x0000) ||
    (words[0] === 0x0064 && words[1] === 0xff9b && words[2] === 0x0001) ||
    (words[0] === 0x0100 && words.slice(1, 4).every((word) => word === 0)) ||
    (words[0] === 0x2001 && words[1] === 0x0000) ||
    (words[0] === 0x2001 && words[1] === 0x0002) ||
    (words[0] === 0x2001 && (words[1] & 0xfff0) === 0x0010) ||
    (words[0] === 0x2001 && (words[1] & 0xfff0) === 0x0020) ||
    (words[0] === 0x2001 && words[1] === 0x0db8) ||
    words[0] === 0x2002 ||
    (words[0] === 0x3fff && (words[1] & 0xf000) === 0x0000);
}

export function isReservedLiteralHost(hostname: string): boolean {
  const host = hostname.replace(/^\[|\]$/g, "").replace(/\.$/, "");
  const ipv4 = parseIpv4(host);
  if (ipv4) return isReservedIpv4(ipv4);
  const ipv6 = parseIpv6(host);
  return ipv6 ? isReservedIpv6(ipv6) : false;
}

/**
 * TOG-7884 (gap G6): injectable hostname-to-addresses hook for the
 * request-time SSRF guard. The default is the worker's real resolver; tests
 * inject a mock. Returning every answer (not just the first) matters: the
 * guard fails closed when ANY answer is forbidden, matching the canonical
 * host predicate (see TOG-549).
 */
export type HostAddressResolver = (hostname: string) => Promise<string[]>;

export async function defaultHostAddressResolver(hostname: string): Promise<string[]> {
  const { lookup } = await import("node:dns/promises");
  const answers = await lookup(hostname, { all: true });
  return answers.map((answer) => answer.address);
}

export type ResolvedHostVerdict =
  | { readonly allowed: true }
  | { readonly allowed: false; readonly reason: "reserved-literal" | "reserved-resolved" };

/**
 * Request-time SSRF verdict for one URL hostname. Literal reserved addresses
 * are refused without touching DNS; literal public IPs are allowed without
 * touching DNS (resolving them would only add failure modes). Any other name
 * is resolved and refused when ANY answer is private/reserved — this is what
 * catches rebinding, split-horizon DNS, and records that changed after config
 * was validated.
 *
 * An unresolvable name is NOT a verdict: it falls through as allowed and the
 * fetch layer below keeps its existing DNS-failure mapping (retryable
 * connect errors on both paths, plus host pinning on the bridge path).
 * Refusing unresolvable names here would reclassify ordinary DNS outages as
 * URL refusals and break the documented `upstream-connect` contract.
 *
 * Never throws: resolver failures fall through, everything else is pure.
 */
export async function checkResolvedHost(
  hostname: string,
  resolveAddresses: HostAddressResolver = defaultHostAddressResolver,
): Promise<ResolvedHostVerdict> {
  const host = hostname.replace(/^\[|\]$/g, "").replace(/\.$/, "");
  if (isReservedLiteralHost(host)) return { allowed: false, reason: "reserved-literal" };
  if (parseIpv4(host) !== null || parseIpv6(host) !== null) return { allowed: true };
  let addresses: string[];
  try {
    addresses = await resolveAddresses(host);
  } catch {
    return { allowed: true };
  }
  for (const address of addresses) {
    if (isReservedLiteralHost(address)) return { allowed: false, reason: "reserved-resolved" };
  }
  return { allowed: true };
}
