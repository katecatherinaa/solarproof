import { NextRequest, NextResponse } from 'next/server'
import { env } from '@/env'

/**
 * Parse a comma-separated list of CIDRs (or bare IPs) into normalized ranges.
 * Bare IPs are treated as single-host ranges (/32 for IPv4, /128 for IPv6).
 */
export function parseAllowlist(raw: string | undefined | null): string[] {
  if (!raw) return []
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
}

/** Convert an IPv4 address string to a 32-bit unsigned integer, or null if invalid. */
function ipv4ToInt(ip: string): number | null {
  const parts = ip.split('.')
  if (parts.length !== 4) return null
  let result = 0
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null
    const n = Number(part)
    if (n < 0 || n > 255) return null
    result = (result << 8) | n
  }
  return result >>> 0
}

/** Convert an IPv6 address string to a 128-bit BigInt, or null if invalid. */
function ipv6ToBigInt(ip: string): bigint | null {
  // Strip zone id if present (e.g. fe80::1%eth0)
  const zoneIdx = ip.indexOf('%')
  if (zoneIdx !== -1) ip = ip.slice(0, zoneIdx)

  // Handle IPv4-mapped suffix like ::ffff:192.168.0.1
  let head = ip
  let tailV4: number | null = null
  const lastColon = ip.lastIndexOf(':')
  if (lastColon !== -1 && ip.indexOf('.', lastColon) !== -1) {
    const v4Part = ip.slice(lastColon + 1)
    tailV4 = ipv4ToInt(v4Part)
    if (tailV4 === null) return null
    head = ip.slice(0, lastColon + 1)
    if (head.endsWith('::')) {
      // keep as is
    } else if (head.endsWith(':')) {
      head = head.slice(0, -1)
    }
  }

  const doubleColonIdx = head.indexOf('::')
  let groups: string[]
  if (doubleColonIdx !== -1) {
    if (head.indexOf('::', doubleColonIdx + 1) !== -1) return null
    const left = head.slice(0, doubleColonIdx)
    const right = head.slice(doubleColonIdx + 2)
    const leftGroups = left.length > 0 ? left.split(':') : []
    const rightGroups = right.length > 0 ? right.split(':') : []
    const total = leftGroups.length + rightGroups.length
    if (total > 8) return null
    const fill = new Array(8 - total).fill('0')
    groups = [...leftGroups, ...fill, ...rightGroups]
  } else {
    groups = head.length > 0 ? head.split(':') : []
  }

  if (tailV4 !== null) {
    // Replace last group with two 16-bit groups from the IPv4
    if (groups.length === 0) return null
    // The last group should be empty (from trailing colon) or we appended v4 separately
    if (groups[groups.length - 1] === '') groups.pop()
    groups.push(((tailV4 >>> 16) & 0xffff).toString(16))
    groups.push((tailV4 & 0xffff).toString(16))
  }

  if (groups.length !== 8) return null

  let result = 0n
  for (const g of groups) {
    if (!/^[0-9a-fA-F]{1,4}$/.test(g)) return null
    result = (result << 16n) | BigInt(parseInt(g, 16))
  }
  return result
}

/** Check whether an IP matches a single CIDR (or bare IP) entry. */
export function ipMatchesCidr(ip: string, cidr: string): boolean {
  const slashIdx = cidr.indexOf('/')
  const rangeIp = slashIdx === -1 ? cidr : cidr.slice(0, slashIdx)
  const prefixStr = slashIdx === -1 ? null : cidr.slice(slashIdx + 1)

  const ipIsV4 = ipv4ToInt(ip) !== null
  const rangeIsV4 = ipv4ToInt(rangeIp) !== null

  if (ipIsV4 && rangeIsV4) {
    const ipInt = ipv4ToInt(ip)!
    const rangeInt = ipv4ToInt(rangeIp)!
    const prefix = prefixStr === null ? 32 : Number(prefixStr)
    if (!Number.isInteger(prefix) || prefix < 0 || prefix > 32) return false
    if (prefix === 0) return true
    const mask = prefix === 32 ? 0xffffffff : (~((1 << (32 - prefix)) - 1)) >>> 0
    return (ipInt & mask) === (rangeInt & mask)
  }

  const ipBig = ipv6ToBigInt(ip)
  const rangeBig = ipv6ToBigInt(rangeIp)
  if (ipBig === null || rangeBig === null) return false
  const prefix = prefixStr === null ? 128 : Number(prefixStr)
  if (!Number.isInteger(prefix) || prefix < 0 || prefix > 128) return false
  if (prefix === 0) return true
  const shift = BigInt(128 - prefix)
  return ipBig >> shift === rangeBig >> shift
}

/** Extract the client IP from request headers. */
export function getClientIp(req: NextRequest): string | null {
  const xff = req.headers.get('x-forwarded-for')
  if (xff) {
    const first = xff.split(',')[0]?.trim()
    if (first) return first
  }
  const realIp = req.headers.get('x-real-ip')
  if (realIp) {
    const trimmed = realIp.trim()
    if (trimmed) return trimmed
  }
  return null
}

/** Check whether an IP is allowed by the given allowlist. Empty allowlist = allow all. */
export function isIpAllowed(ip: string | null, allowlist: string[]): boolean {
  if (allowlist.length === 0) return true
  if (!ip) return false
  return allowlist.some((cidr) => ipMatchesCidr(ip, cidr))
}

/** Validate the admin bearer token and IP allowlist. Returns error response on failure. */
export function requireAdmin(req: NextRequest): NextResponse | null {
  const secret = env.ADMIN_SECRET
  if (!secret) {
    return NextResponse.json({ error: 'Admin interface not configured' }, { status: 503 })
  }

  const allowlist = parseAllowlist(env.ADMIN_IP_ALLOWLIST)
  if (allowlist.length > 0) {
    const ip = getClientIp(req)
    if (!isIpAllowed(ip, allowlist)) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
    }
  }

  const auth = req.headers.get('authorization') ?? ''
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : null
  if (!token || token !== secret) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }
  return null
}