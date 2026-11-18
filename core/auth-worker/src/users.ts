/** THE PERSON OF AN ADDRESS, made at the first proof of it: a mailed code, for a person who is no
 *  member (./email-sign-in.ts), or a proof that opens a member's first passkey (./enrolment.ts).
 *  `email` is trimmed and lower-cased by its caller. One batch, so two first proofs at once
 *  resolve to one person. */
export async function userOf(
  db: D1Database,
  email: string,
): Promise<{ id: string; email: string }> {
  const [, found] = await db.batch<{ id: string; email: string }>([
    db
      .prepare("insert into users (id, email) values (?1, ?2) on conflict (email) do nothing")
      .bind(`user_${crypto.randomUUID().replaceAll("-", "")}`, email),
    db.prepare("select id, email from users where email = ?1").bind(email),
  ]);
  const user = found?.results[0];
  if (!user) throw new Error("the person's row was not kept");
  return user;
}
