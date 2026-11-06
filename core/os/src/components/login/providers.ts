/** One way to sign in through another identity provider: `key` is what a link's `provider_hint`
 *  names it by; `label`, the button's own words where the name alone says too little. */
export type SignInProvider = {
  key: string;
  name: string;
  href: string;
  logo: string;
  label?: string;
};
