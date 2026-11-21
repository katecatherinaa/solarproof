/**
 * Account lockout — brute-force protection for login endpoints.
 *
 * After MAX_ATTEMPTS failed logins within WINDOW_SECONDS, the account is
 * locked for LOCKOUT_SECONDS. Lockout state is stored in Redis so it is
 * shared across all serverless instances.
 *
 * Keys used in Redis:
 *   login_attempts:<email>  — INCR counter with TTL = WINDOW_SECONDS
 *   lockout:<email>         — flag with TTL = LOCKOUT_SECONDS
 *
 * Issue #115.
 */

import { getRedisConnection } from '@/lib/redis'

/** Number of consecutive failures before the account is locked. */
export const MAX_ATTEMPTS = 5
/** Sliding window for counting failures (seconds). */
export const WINDOW_SECONDS = 15 * 60 // 15 minutes
/** Duration of the lockout (seconds). */
export const LOCKOUT_SECONDS = 15 * 60 // 15 minutes

function attemptsKey(email: string): string {
  return `login_attempts:${email}`
}

function lockoutKey(email: string): string {
  return `lockout:${email}`
}

/**
 * Returns true when the account identified by `email` is currently locked out.
 *
 * Fails open: if Redis is unavailable, returns `false` so that login is not
 * blocked by an infrastructure outage.
 */
export async function isAccountLocked(email: string): Promise<boolean> {
  try {
    const redis = getRedisConnection()
    const locked = await redis.exists(lockoutKey(email))
    return locked === 1
  } catch (error) {
    console.error('[account-lockout] isAccountLocked failed, failing open:', error)
    return false
  }
}

/**
 * Record one failed login attempt for `email`.
 *
 * - Increments the failure counter; initialises it with a TTL on first call.
 * - When the count reaches MAX_ATTEMPTS, sets the lockout key and returns
 *   `true` to signal that the caller should trigger the lockout notification.
 *
 * @returns `true` if the account was just locked (threshold crossed this call).
 *
 * Fails open: if Redis is unavailable, returns `false` (and logs the error)
 * so that login is not blocked by an infrastructure outage.
 */
export async function recordFailedAttempt(email: string): Promise<boolean> {
  try {
    const redis = getRedisConnection()
    const key = attemptsKey(email)

    // Increment the counter atomically.
    const count = await redis.incr(key)

    // Set the TTL on the first increment so the window is anchored to the
    // first failure rather than reset on every failure.
    if (count === 1) {
      await redis.expire(key, WINDOW_SECONDS)
    }

    if (count >= MAX_ATTEMPTS) {
      // Lock the account and let the caller send the notification email.
      await redis.set(lockoutKey(email), '1', 'EX', LOCKOUT_SECONDS)
      return true
    }

    return false
  } catch (error) {
    console.error('[account-lockout] recordFailedAttempt failed, failing open:', error)
    return false
  }
}

/**
 * Reset the failure counter for `email` after a successful login.
 */
export async function resetFailedAttempts(email: string): Promise<void> {
  const redis = getRedisConnection()
  await redis.del(attemptsKey(email))
}

/**
 * Admin operation: immediately unlock an account.
 *
 * Removes both the lockout flag and the failure counter so the user may
 * attempt to log in again immediately.
 */
export async function unlockAccount(email: string): Promise<void> {
  const redis = getRedisConnection()
  await redis.del(lockoutKey(email), attemptsKey(email))
}

/**
 * Returns the remaining lockout TTL in seconds, or 0 if not locked.
 */
export async function lockoutRemainingSeconds(email: string): Promise<number> {
  const redis = getRedisConnection()
  const ttl = await redis.ttl(lockoutKey(email))
  return ttl > 0 ? ttl : 0
}
