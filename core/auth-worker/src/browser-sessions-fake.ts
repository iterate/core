// THE `browser_sessions` TABLE IN MEMORY, for the units whose D1 is a stand-in that matches SQL
// (./cookies.ts writes and reads it). It answers the statements of ./cookies.ts about a passkey's
// sessions, and nothing else: `statementOf` is null for any other SQL, so a test's own stand-in
// answers that. A session of another kind is tested on SQLite (./test-support.ts).
type Row = {
  id: string;
  user_id: string;
  key_id: string;
  user_agent: string;
  created_at: number;
  last_seen_at: number;
  expires_at: number;
  ended_at: number | null;
};

export function browserSessionsFake(
  keyLive: (key: string, userId: string) => boolean = () => true,
) {
  const rows = new Map<string, Row>();
  const live = (row: Row, now: number) =>
    row.ended_at === null && row.expires_at > now && keyLive(row.key_id, row.user_id);
  const statementOf = (sql: string, bound: unknown[]) => {
    if (!sql.includes("browser_sessions")) return null;
    const answer = (): unknown[] => {
      const [a, b, c, d, e, f] = bound as [string, string, string, string, number, number];
      if (sql.trimStart().startsWith("insert")) {
        rows.set(a, {
          id: a,
          user_id: b,
          key_id: c,
          user_agent: d,
          created_at: e,
          last_seen_at: e,
          expires_at: f,
          ended_at: null,
        });
        return [];
      }
      if (sql.trimStart().startsWith("delete")) return [];
      if (sql.includes("set last_seen_at")) {
        const row = rows.get(a);
        if (row && row.last_seen_at < (bound[2] as number)) row.last_seen_at = bound[1] as number;
        return [];
      }
      if (sql.includes("set ended_at")) {
        const now = bound[1] as number;
        const ended = [...rows.values()].filter(
          (row) =>
            row.user_id === a &&
            row.ended_at === null &&
            row.expires_at > now &&
            (!sql.includes("and id = ?3") || row.id === bound[2]) &&
            (!sql.includes("and id != ?3") || row.id !== bound[2]),
        );
        for (const row of ended) row.ended_at = now;
        return ended.map(({ id }) => ({ id }));
      }
      if (sql.includes("where s.id = ?1")) {
        const row = rows.get(a);
        return row && row.user_id === b && live(row, bound[2] as number)
          ? [{ method: "passkey", last_seen_at: row.last_seen_at }]
          : [];
      }
      if (sql.includes("where s.user_id = ?1"))
        return [...rows.values()]
          .filter((row) => row.user_id === a && live(row, bound[1] as number))
          .sort((x, y) => y.created_at - x.created_at)
          .map((row) => ({
            id: row.id,
            method: "passkey",
            userAgent: row.user_agent,
            createdAt: row.created_at,
            lastSeenAt: row.last_seen_at,
          }));
      throw new Error(`not expected: ${sql}`);
    };
    return {
      first: async () => answer()[0] ?? null,
      all: async () => ({ results: answer() }),
      run: async () => ({ meta: { changes: answer().length } }),
      results: () => ({ results: answer() }),
    };
  };
  return { rows, statementOf };
}
