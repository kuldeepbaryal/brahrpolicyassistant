/**
 * Role management — the one place that knows "who is an admin and how roles
 * change".
 *
 * Owns:
 *   • Effective-role precedence: env allowlist → DB record → seed list.
 *   • The initial role for a first-time user record (seed behaviour).
 *   • Guarded role changes: last-admin lock-out protection (pre-check plus a
 *     post-write verify-and-revert for concurrent demotions) and the
 *     atomically-written audit event.
 *
 * Callers (routes, auth) use the small interface below and never re-implement
 * any of these rules.
 */
import { config } from "./config";
import { getUserStore, type RoleChangeEvent, type UserRecord, type UserStore } from "./db";

export type Role = "admin" | "user";

export interface Actor {
  sub: string;
  email?: string;
  name?: string;
}

export type ChangeRoleResult =
  /** `changed` is false when the role was already set (no-op, nothing audited). */
  | { ok: true; changed: boolean }
  /** Target user record does not exist. */
  | { ok: false; error: "not_found" }
  /**
   * The change would leave zero manageable admins. `reverted` is false when
   * the pre-check caught it (nothing written); true when a concurrent
   * demotion race was detected after the write and the change was reverted
   * (revert is audited too).
   */
  | { ok: false; error: "last_admin"; reverted: boolean };

export interface RoleServiceDeps {
  store: () => UserStore;
  adminEmails: () => string[];
  seedAdminEmails: () => string[];
  now?: () => number;
}

export class RoleService {
  constructor(private deps: RoleServiceDeps) {}

  private get store(): UserStore {
    return this.deps.store();
  }

  private now(): number {
    return this.deps.now ? this.deps.now() : Date.now();
  }

  /** True when the email is on the env allowlist (fallback, always counts). */
  isAllowlistedAdmin(email: string): boolean {
    return this.deps.adminEmails().includes(email.trim().toLowerCase());
  }

  /** Initial role for a first-time user record. */
  initialRoleFor(email: string): Role {
    const e = email.trim().toLowerCase();
    return this.deps.seedAdminEmails().includes(e) || this.isAllowlistedAdmin(e) ? "admin" : "user";
  }

  /**
   * Effective admin status. Precedence: the env allowlist always counts
   * (prevents lock-out if the table is lost); otherwise the DB record role
   * wins; with no record yet, the seed list applies. Errors reading the
   * record fall back to the allowlist only.
   */
  async isAdmin(user: { sub: string; email: string }): Promise<boolean> {
    if (this.isAllowlistedAdmin(user.email)) return true;
    try {
      const rec = await this.store.getUser(user.sub);
      if (rec) return rec.role === "admin";
      return this.initialRoleFor(user.email) === "admin";
    } catch {
      return false;
    }
  }

  /** All users, most recently signed-in first. */
  listUsers(): Promise<UserRecord[]> {
    return this.store.listUsers();
  }

  /**
   * Change a user's role with lock-out protection and an audit trail.
   *
   * Contract: domain outcomes (not_found, last_admin, no-op) are returned as
   * ChangeRoleResult values; storage failures propagate as thrown
   * StorageError ("conflict" when the target record vanished between the
   * read and the conditional write, "permission_denied" / "not_provisioned" /
   * "unavailable" otherwise). Adapters map thrown errors to 5xx-style
   * responses and result values to domain-specific statuses.
   */
  async changeRole(actor: Actor, targetSub: string, role: Role): Promise<ChangeRoleResult> {
    const users = await this.store.listUsers();
    const target = users.find((u) => u.sub === targetSub);
    if (!target) return { ok: false, error: "not_found" };

    const isDemotion = target.role === "admin" && role === "user";

    // Lock-out guard: never demote the last remaining admin (env-allowlisted
    // admins don't count here since they can't be managed from this page).
    if (isDemotion) {
      const adminCount = users.filter((u) => u.role === "admin").length;
      if (adminCount <= 1 && !this.isAllowlistedAdmin(target.email)) {
        return { ok: false, error: "last_admin", reverted: false };
      }
    }

    if (target.role === role) {
      // No-op: role already set — nothing to change or audit.
      return { ok: true, changed: false };
    }

    const auditFor = (fromRole: Role, toRole: Role): RoleChangeEvent => ({
      actorSub: actor.sub,
      actorEmail: actor.email ?? "",
      actorName: actor.name ?? "",
      targetSub: target.sub,
      targetEmail: target.email,
      targetName: target.name,
      fromRole,
      toRole,
      createdAt: this.now(),
    });

    // Atomic: role update + audit event persist together, or neither does.
    await this.store.changeUserRole(targetSub, role, auditFor(target.role, role));

    // Concurrency guard: two simultaneous demotions could both pass the
    // pre-check above. Re-verify after the write and revert (also audited)
    // if the table was left with no admins at all. Allowlisted targets are
    // exempt (matching the pre-check): they stay admin via the env allowlist,
    // so demoting their DB record can never cause lock-out.
    if (isDemotion && !this.isAllowlistedAdmin(target.email)) {
      const after = await this.store.listUsers();
      if (!after.some((u) => u.role === "admin")) {
        await this.store.changeUserRole(targetSub, "admin", auditFor("user", "admin"));
        return { ok: false, error: "last_admin", reverted: true };
      }
    }

    return { ok: true, changed: true };
  }
}

/* ─────────────────────────── default instance ─────────────────────────── */

const globalForRoles = globalThis as unknown as { __bracHrRoles?: RoleService };

export function getRoleService(): RoleService {
  if (!globalForRoles.__bracHrRoles) {
    globalForRoles.__bracHrRoles = new RoleService({
      store: getUserStore,
      adminEmails: () => config.adminEmails,
      seedAdminEmails: () => config.seedAdminEmails,
    });
  }
  return globalForRoles.__bracHrRoles;
}
