import { keySortedForPrint } from "iterate/expression";

export class Connections {
  readonly #live = new Map<string, { connection: Promise<unknown>; holdsSocket: boolean }>();

  memoized<T>(key: unknown[], holdsSocket: boolean, open: () => Promise<T>): Promise<T> {
    const memoKey = JSON.stringify(key, keySortedForPrint);
    let connection = this.#live.get(memoKey)?.connection as Promise<T> | undefined;
    if (!connection) {
      connection = open();
      this.#live.set(memoKey, { connection, holdsSocket });
      connection.catch(() => this.#live.delete(memoKey));
    }
    return connection;
  }

  // An open socket keeps the actor resident, like a borrowed stub; an HTTP client does not.
  holdsOpenSocket(): boolean {
    return [...this.#live.values()].some((c) => c.holdsSocket);
  }

  // A close that throws is only logged: the far end is any server a caller connected to.
  release(): void {
    for (const [memoKey, { connection }] of this.#live)
      void connection
        .then((c) => {
          const held = c as { close?: () => unknown; [Symbol.dispose]?: () => void };
          return held.close ? held.close() : held[Symbol.dispose]?.();
        })
        .catch((error: unknown) =>
          console.warn({
            event: "library.connection-close-failed",
            memoKey,
            message: String(error),
          }),
        );
    this.#live.clear();
  }
}
