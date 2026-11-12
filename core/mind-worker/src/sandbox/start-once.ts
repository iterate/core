// One start of a sandbox at a time. A start asked for while another runs waits for that one, then
// gets `follow` with its own options, so what it asked for (its secret list) is not dropped.

export function startOnce<Options>(
  start: (options: Options) => Promise<void>,
  follow: (options: Options) => Promise<void>,
): (options: Options) => Promise<void> {
  let running: Promise<void> | undefined;
  return (options) => {
    if (running) return running.then(() => follow(options));
    running = start(options).finally(() => (running = undefined));
    return running;
  };
}
