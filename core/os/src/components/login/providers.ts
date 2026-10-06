/** One way to sign in through another identity provider: `key` is what a link's `provider_hint`
 *  names it by. */
export type SignInProvider = { key: string; name: string; href: string; logo: string };
