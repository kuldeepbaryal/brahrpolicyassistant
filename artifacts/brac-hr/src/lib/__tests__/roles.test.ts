import { beforeEach, describe, expect, it } from "vitest";
import { MemoryDb, StorageError, type UserStore } from "../db";
import { RoleService, type Actor } from "../roles";

process.env.MOCK_MODE = "true";

const actor: Actor = { sub: "actor-1", email: "actor@brac.net", name: "Actor" };

function makeService(opts: { store?: UserStore; adminEmails?: string[]; seedAdminEmails?: string[] } = {}) {
  const store = opts.store ?? new MemoryDb();
  const service = new RoleService({
    store: () => store,
    adminEmails: () => opts.adminEmails ?? [],
    seedAdminEmails: () => opts.seedAdminEmails ?? [],
  });
  return { store, service };
}

async function addUser(store: UserStore, sub: string, email: string, role: "admin" | "user") {
  await store.upsertUser({ sub, email, name: email.split("@")[0] }, role);
}

describe("effective role precedence", () => {
  it("env allowlist always wins, even without a DB record", async () => {
    const { service } = makeService({ adminEmails: ["boss@brac.net"] });
    expect(await service.isAdmin({ sub: "x", email: "boss@brac.net" })).toBe(true);
    expect(await service.isAdmin({ sub: "x", email: "BOSS@brac.net " })).toBe(true);
  });

  it("seed list always wins, even over a demoted DB record", async () => {
    const { store, service } = makeService({ seedAdminEmails: ["seed@brac.net"] });
    await addUser(store, "u1", "seed@brac.net", "user"); // demoted after seeding
    expect(await service.isAdmin({ sub: "u1", email: "seed@brac.net" })).toBe(true);
    await addUser(store, "u2", "other@brac.net", "user");
    expect(await service.isAdmin({ sub: "u2", email: "other@brac.net" })).toBe(false);
  });

  it("with no record yet, the seed list applies", async () => {
    const { service } = makeService({ seedAdminEmails: ["seed@brac.net"] });
    expect(await service.isAdmin({ sub: "new", email: "seed@brac.net" })).toBe(true);
    expect(await service.isAdmin({ sub: "new", email: "other@brac.net" })).toBe(false);
  });

  it("storage errors fall back to the allowlist and seed list", async () => {
    const broken = {
      getUser: async () => {
        throw new StorageError("unavailable", "boom");
      },
    } as unknown as UserStore;
    const { service } = makeService({ store: broken, adminEmails: ["boss@brac.net"], seedAdminEmails: ["seed@brac.net"] });
    expect(await service.isAdmin({ sub: "x", email: "boss@brac.net" })).toBe(true);
    expect(await service.isAdmin({ sub: "x", email: "seed@brac.net" })).toBe(true);
    expect(await service.isAdmin({ sub: "x", email: "other@brac.net" })).toBe(false);
  });
});

describe("initial role on first sign-in", () => {
  it("seeds admins from the seed list and allowlist, others are users", () => {
    const { service } = makeService({ adminEmails: ["boss@brac.net"], seedAdminEmails: ["seed@brac.net"] });
    expect(service.initialRoleFor("seed@brac.net")).toBe("admin");
    expect(service.initialRoleFor(" SEED@brac.net ")).toBe("admin");
    expect(service.initialRoleFor("boss@brac.net")).toBe("admin");
    expect(service.initialRoleFor("staff@brac.net")).toBe("user");
  });

  it("upsert preserves an existing role (seed never re-applies)", async () => {
    const { store, service } = makeService({ seedAdminEmails: ["seed@brac.net"] });
    await addUser(store, "u1", "seed@brac.net", service.initialRoleFor("seed@brac.net"));
    await store.setUserRole("u1", "user");
    await store.upsertUser({ sub: "u1", email: "seed@brac.net", name: "Seed" }, service.initialRoleFor("seed@brac.net"));
    expect((await store.getUser("u1"))!.role).toBe("user");
  });
});

describe("changeRole", () => {
  let store: MemoryDb;
  let service: RoleService;

  beforeEach(() => {
    ({ store, service } = makeService() as { store: MemoryDb; service: RoleService });
  });

  it("returns not_found for unknown users", async () => {
    expect(await service.changeRole(actor, "ghost", "admin")).toEqual({ ok: false, error: "not_found" });
  });

  it("promotes and writes an audit entry atomically", async () => {
    await addUser(store, "u1", "a@brac.net", "admin");
    await addUser(store, "u2", "b@brac.net", "user");
    const res = await service.changeRole(actor, "u2", "admin");
    expect(res).toEqual({ ok: true, changed: true });
    expect((await store.getUser("u2"))!.role).toBe("admin");
    const audit = await store.listRoleChanges(10);
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ targetSub: "u2", fromRole: "user", toRole: "admin", actorSub: actor.sub });
  });

  it("no-op change is not audited", async () => {
    await addUser(store, "u1", "a@brac.net", "admin");
    const res = await service.changeRole(actor, "u1", "admin");
    expect(res).toEqual({ ok: true, changed: false });
    expect(await store.listRoleChanges(10)).toHaveLength(0);
  });

  it("blocks demoting the last remaining admin (nothing written)", async () => {
    await addUser(store, "u1", "a@brac.net", "admin");
    await addUser(store, "u2", "b@brac.net", "user");
    const res = await service.changeRole(actor, "u1", "user");
    expect(res).toEqual({ ok: false, error: "last_admin", reverted: false });
    expect((await store.getUser("u1"))!.role).toBe("admin");
    expect(await store.listRoleChanges(10)).toHaveLength(0);
  });

  it("allows demoting the last admin when they are env-allowlisted", async () => {
    ({ store, service } = makeService({ adminEmails: ["a@brac.net"] }) as { store: MemoryDb; service: RoleService });
    await addUser(store, "u1", "a@brac.net", "admin");
    const res = await service.changeRole(actor, "u1", "user");
    expect(res).toEqual({ ok: true, changed: true });
    expect((await store.getUser("u1"))!.role).toBe("user");
  });

  it("propagates a conflict StorageError when the target vanishes between read and write", async () => {
    const inner = new MemoryDb();
    await addUser(inner, "u1", "a@brac.net", "admin");
    await addUser(inner, "u2", "b@brac.net", "user");
    const flaky = new Proxy(inner, {
      get(target, prop, receiver) {
        if (prop === "changeUserRole") {
          return async () => {
            // Simulate the conditional write losing its precondition
            // (record deleted after the pre-check read).
            throw new StorageError("conflict", "ConditionalCheckFailed");
          };
        }
        return Reflect.get(target, prop, receiver);
      },
    }) as unknown as UserStore;
    const svc = new RoleService({ store: () => flaky, adminEmails: () => [], seedAdminEmails: () => [] });
    await expect(svc.changeRole(actor, "u2", "admin")).rejects.toMatchObject({
      name: "StorageError",
      code: "conflict",
    });
    // Nothing was changed or audited.
    expect((await inner.getUser("u2"))!.role).toBe("user");
    expect(await inner.listRoleChanges(10)).toHaveLength(0);
  });

  it("propagates generic storage failures untouched", async () => {
    const broken = new Proxy(new MemoryDb(), {
      get(target, prop, receiver) {
        if (prop === "listUsers") {
          return async () => {
            throw new StorageError("unavailable", "boom");
          };
        }
        return Reflect.get(target, prop, receiver);
      },
    }) as unknown as UserStore;
    const svc = new RoleService({ store: () => broken, adminEmails: () => [], seedAdminEmails: () => [] });
    await expect(svc.changeRole(actor, "u1", "admin")).rejects.toMatchObject({
      name: "StorageError",
      code: "unavailable",
    });
  });

  it("detects a concurrent double-demotion and reverts (audited)", async () => {
    // Force the race deterministically: both changeRole calls read the user
    // list (both see 2 admins) before either write lands.
    const inner = new MemoryDb();
    await addUser(inner, "u1", "a@brac.net", "admin");
    await addUser(inner, "u2", "b@brac.net", "admin");

    let release: () => void;
    const barrier = new Promise<void>((r) => (release = r));
    let pendingReads = 0;
    const gated = new Proxy(inner, {
      get(target, prop, receiver) {
        if (prop === "listUsers") {
          return async () => {
            const users = await inner.listUsers();
            // Snapshot the records (real storage reads are snapshots, while
            // MemoryDb returns live references that would leak later writes
            // into an already-taken read).
            const snapshot = users.map((u) => ({ ...u }));
            // Gate only the two pre-check reads; post-write verification reads pass through.
            if (pendingReads < 2) {
              pendingReads++;
              if (pendingReads === 2) release!();
              await barrier;
            }
            return snapshot;
          };
        }
        return Reflect.get(target, prop, receiver);
      },
    }) as unknown as UserStore;

    const raceService = new RoleService({ store: () => gated, adminEmails: () => [], seedAdminEmails: () => [] });
    const [r1, r2] = await Promise.all([
      raceService.changeRole(actor, "u1", "user"),
      raceService.changeRole(actor, "u2", "user"),
    ]);

    const results = [r1, r2];
    // At least one demotion must have been rejected/reverted…
    expect(results.some((r) => !r.ok && r.error === "last_admin" && r.reverted)).toBe(true);
    // …and the table must never be left with zero admins.
    const after = await inner.listUsers();
    expect(after.some((u) => u.role === "admin")).toBe(true);
    // Every successful demotion and every revert is audited.
    const audit = await inner.listRoleChanges(10);
    expect(audit.length).toBeGreaterThanOrEqual(2);
    expect(audit.some((a) => a.fromRole === "user" && a.toRole === "admin")).toBe(true);
  });
});
