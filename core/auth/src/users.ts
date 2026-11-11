import { codedError } from "iterate/lib";

type UserRecord = { id: string; email: string };

// One batch, so two first sign-ins at once resolve to one person. `unique (provider, user_id)`
// refuses a second subject of one provider for a person, and a refused link reads back as no one.
export async function linkIdentity(
  db: D1Database,
  input: { provider: string; subject: string; email: string },
): Promise<UserRecord> {
  const { provider, subject } = input;
  const email = input.email.trim().toLowerCase();
  const [, , found] = await db.batch([
    db
      .prepare(
        `insert into users (id, email)
         select ?1, ?2
         where not exists (select 1 from identities i where i.provider = ?3 and i.subject = ?4)
         on conflict (email) do nothing`,
      )
      .bind(`user_${crypto.randomUUID().replaceAll("-", "")}`, email, provider, subject),
    db
      .prepare(
        `insert into identities (provider, subject, user_id)
         select ?1, ?2, u.id from users u where u.email = ?3
         on conflict do nothing`,
      )
      .bind(provider, subject, email),
    db
      .prepare(
        `select u.id, u.email from identities i join users u on u.id = i.user_id
         where i.provider = ?1 and i.subject = ?2 limit 1`,
      )
      .bind(provider, subject),
  ]);
  const linked = (found?.results as UserRecord[] | undefined)?.[0];
  if (!linked)
    throw codedError("IDENTITY_CONFLICT", "This email belongs to another linked account.");
  if (linked.email === email) return linked;
  try {
    const { meta } = await db
      .prepare(
        `update users set email = ?1
         where id = ?2
           and (select count(*) from identities i where i.user_id = users.id) = 1
           and not exists (select 1 from identities i where i.user_id = users.id and i.added_at is not null)`,
      )
      .bind(email, linked.id)
      .run();
    return { id: linked.id, email: meta.changes ? email : linked.email };
  } catch (error) {
    // D1 names a constraint failure only in its message.
    if (error instanceof Error && error.message.includes("UNIQUE constraint failed"))
      throw codedError("IDENTITY_CONFLICT", "This email belongs to another account.");
    throw error;
  }
}
