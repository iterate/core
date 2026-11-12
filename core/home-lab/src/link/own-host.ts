/** A name of this machine itself, as the launcher prints them: `localhost`, a label under it, or
 *  the loopback address. */
export const isOwnHost = (hostname: string) =>
  hostname === "localhost" ||
  hostname.endsWith(".localhost") ||
  hostname === "127.0.0.1" ||
  hostname === "[::1]";
