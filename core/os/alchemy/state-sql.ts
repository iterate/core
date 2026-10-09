// alchemy/state-sql.ts — ALCHEMY'S STATE IN A DURABLE OBJECT'S SQLITE: the `State` service over
// `ctx.storage.sql`, so a stack's state lives in the Durable Object that runs it (./engine.ts).
// Like the engine, it imports nothing of iterate. Two tables, as Alchemy's own PostgresState keeps
// them: one row per resource and one per stack output, each the JSON of Alchemy's state encoding.
// Every method is one synchronous `sql.exec`, so each write is atomic under Alchemy's concurrent
// apply. A row that does not parse is a StateStoreError, never "missing": a missing row would plan
// the resource's re-creation. This file goes once Alchemy ships a Durable Object state store of its
// own.
import { STATE_STORE_VERSION } from "alchemy/State/HttpStateApi";
import { State, StateStoreError, type StateService } from "alchemy/State/State";
import { encodeState, reviveState } from "alchemy/State/StateEncoding";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

/** The `State` layer a Durable Object passes to Alchemy's Stack. */
export const sqlState = (sql: StateSql) =>
  Layer.succeed(State)(Effect.succeed(sqlStateService(sql)));

/** The part of `SqlStorage` the store uses, so node:sqlite stands in for it in state-sql.test.ts. */
export type StateSql = {
  exec(query: string, ...bindings: unknown[]): { toArray(): Record<string, unknown>[] };
};

function sqlStateService(sql: StateSql): StateService {
  sql.exec(`create table if not exists alchemy_resource_state (
    stack text not null, stage text not null, fqn text not null, value text not null,
    updated_at integer not null, primary key (stack, stage, fqn)) without rowid`);
  sql.exec(`create table if not exists alchemy_stack_output (
    stack text not null, stage text not null, value text not null,
    updated_at integer not null, primary key (stack, stage)) without rowid`);

  const run = <A>(label: string, f: () => A) =>
    Effect.try({
      try: f,
      catch: (cause) =>
        new StateStoreError({
          message: `durable object sqlite state: ${label} failed`,
          cause: cause instanceof Error ? cause : new Error(String(cause)),
        }),
    });
  const encode = (value: unknown) => JSON.stringify(encodeState(value));
  // Alchemy's own stores read their rows the same way (State/LocalState.ts): JSON, revived
  // (Redacted, Duration and Date), as the engine wrote it
  const decode = (value: unknown) => JSON.parse(String(value), reviveState);
  /** The value of the query's single row, or undefined when it has none. */
  const single = (query: string, ...bindings: unknown[]) => {
    const [row] = sql.exec(query, ...bindings).toArray();
    return row && decode(row.value);
  };

  return {
    id: "durable-object-sqlite",
    getVersion: () => Effect.succeed(STATE_STORE_VERSION),
    // a stack with an output and no resources still lists, as PostgresState lists it
    listStacks: () =>
      run("listStacks", () =>
        sql
          .exec(
            `select stack from alchemy_resource_state
             union select stack from alchemy_stack_output order by stack`,
          )
          .toArray()
          .map((row) => String(row.stack)),
      ),
    listStages: (stack) =>
      run("listStages", () =>
        sql
          .exec(
            `select stage from alchemy_resource_state where stack = ?
             union select stage from alchemy_stack_output where stack = ? order by stage`,
            stack,
            stack,
          )
          .toArray()
          .map((row) => String(row.stage)),
      ),
    get: ({ stack, stage, fqn }) =>
      run("get", () =>
        single(
          `select value from alchemy_resource_state where stack = ? and stage = ? and fqn = ?`,
          stack,
          stage,
          fqn,
        ),
      ),
    // as LocalState finds them: each row of the stage, decoded, by its status
    getReplacedResources: ({ stack, stage }) =>
      run("getReplacedResources", () =>
        sql
          .exec(
            `select value from alchemy_resource_state where stack = ? and stage = ?`,
            stack,
            stage,
          )
          .toArray()
          .map((row) => decode(row.value))
          .filter((state) => state.status === "replaced"),
      ),
    set: ({ stack, stage, fqn, value }) =>
      run("set", () => {
        sql.exec(
          `insert into alchemy_resource_state (stack, stage, fqn, value, updated_at)
           values (?, ?, ?, ?, ?)
           on conflict (stack, stage, fqn) do update
             set value = excluded.value, updated_at = excluded.updated_at`,
          stack,
          stage,
          fqn,
          encode(value),
          Date.now(),
        );
        return value;
      }),
    delete: ({ stack, stage, fqn }) =>
      run("delete", () => {
        sql.exec(
          `delete from alchemy_resource_state where stack = ? and stage = ? and fqn = ?`,
          stack,
          stage,
          fqn,
        );
      }),
    deleteStack: ({ stack, stage }) =>
      run("deleteStack", () => {
        if (!stage) {
          sql.exec(`delete from alchemy_resource_state where stack = ?`, stack);
          sql.exec(`delete from alchemy_stack_output where stack = ?`, stack);
          return;
        }
        sql.exec(`delete from alchemy_resource_state where stack = ? and stage = ?`, stack, stage);
        sql.exec(`delete from alchemy_stack_output where stack = ? and stage = ?`, stack, stage);
      }),
    list: ({ stack, stage }) =>
      run("list", () =>
        sql
          .exec(
            `select fqn from alchemy_resource_state where stack = ? and stage = ?`,
            stack,
            stage,
          )
          .toArray()
          .map((row) => String(row.fqn)),
      ),
    getOutput: ({ stack, stage }) =>
      run("getOutput", () =>
        single(
          `select value from alchemy_stack_output where stack = ? and stage = ?`,
          stack,
          stage,
        ),
      ),
    setOutput: ({ stack, stage, value }) =>
      run("setOutput", () => {
        sql.exec(
          `insert into alchemy_stack_output (stack, stage, value, updated_at) values (?, ?, ?, ?)
           on conflict (stack, stage) do update
             set value = excluded.value, updated_at = excluded.updated_at`,
          stack,
          stage,
          encode(value),
          Date.now(),
        );
        return value;
      }),
  };
}
