// client-mark.ts — WHO ASKS, AS A PICTURE: the tile beside the mind's own mark on the consent page
// and on a device's sign-in. A person reads "Claude Code" faster from its mark than from its name.
//
// A CLIENT SAYS ITS OWN NAME AND LOGO, so a picture proves nothing: the page's words say whether
// the name is verified, and where the access goes. That is why this file is careful about which
// picture it shows:
//   a built-in mark   for a client we know, by the host its access goes to, or by its name
//   the client's logo only for a client whose domain is verified (its client ID is a document on
//                     that domain), and only from that domain, over https
//   its initials      for everybody else
// The marks are Simple Icons' (https://simpleicons.org, CC0), each in its brand's colour, or in
// the page's own colour where the brand's is black. Simple Icons has none for OpenAI: its mark
// here is the blossom as OpenAI draws it (the path of https://developers.openai.com/favicon.svg),
// in one colour and with no wordmark, and it names OpenAI's own clients and nothing else. Visual
// Studio Code has no free mark, so it shows its initials.
//
// The list of a person's sign-ins (the keys page) draws the same tile, small:
//   clientTile(client, { small: true })

const text = (value: string) =>
  value.replace(/[&<>"']/g, (character) => `&#${character.charCodeAt(0)};`);

const MARKS = {
  claude: {
    fill: "#D97757",
    path: "m4.7144 15.9555 4.7174-2.6471.079-.2307-.079-.1275h-.2307l-.7893-.0486-2.6956-.0729-2.3375-.0971-2.2646-.1214-.5707-.1215-.5343-.7042.0546-.3522.4797-.3218.686.0608 1.5179.1032 2.2767.1578 1.6514.0972 2.4468.255h.3886l.0546-.1579-.1336-.0971-.1032-.0972L6.973 9.8356l-2.55-1.6879-1.3356-.9714-.7225-.4918-.3643-.4614-.1578-1.0078.6557-.7225.8803.0607.2246.0607.8925.686 1.9064 1.4754 2.4893 1.8336.3643.3035.1457-.1032.0182-.0728-.164-.2733-1.3539-2.4467-1.445-2.4893-.6435-1.032-.17-.6194c-.0607-.255-.1032-.4674-.1032-.7285L6.287.1335 6.6997 0l.9957.1336.419.3642.6192 1.4147 1.0018 2.2282 1.5543 3.0296.4553.8985.2429.8318.091.255h.1579v-.1457l.1275-1.706.2368-2.0947.2307-2.6957.0789-.7589.3764-.9107.7468-.4918.5828.2793.4797.686-.0668.4433-.2853 1.8517-.5586 2.9021-.3643 1.9429h.2125l.2429-.2429.9835-1.3053 1.6514-2.0643.7286-.8196.85-.9046.5464-.4311h1.0321l.759 1.1293-.34 1.1657-1.0625 1.3478-.8804 1.1414-1.2628 1.7-.7893 1.36.0729.1093.1882-.0183 2.8535-.607 1.5421-.2794 1.8396-.3157.8318.3886.091.3946-.3278.8075-1.967.4857-2.3072.4614-3.4364.8136-.0425.0304.0486.0607 1.5482.1457.6618.0364h1.621l3.0175.2247.7892.522.4736.6376-.079.4857-1.2142.6193-1.6393-.3886-3.825-.9107-1.3113-.3279h-.1822v.1093l1.0929 1.0686 2.0035 1.8092 2.5075 2.3314.1275.5768-.3218.4554-.34-.0486-2.2039-1.6575-.85-.7468-1.9246-1.621h-.1275v.17l.4432.6496 2.3436 3.5214.1214 1.0807-.17.3521-.6071.2125-.6679-.1214-1.3721-1.9246L14.38 17.959l-1.1414-1.9428-.1397.079-.674 7.2552-.3156.3703-.7286.2793-.6071-.4614-.3218-.7468.3218-1.4753.3886-1.9246.3157-1.53.2853-1.9004.17-.6314-.0121-.0425-.1397.0182-1.4328 1.9672-2.1796 2.9446-1.7243 1.8456-.4128.164-.7164-.3704.0667-.6618.4008-.5889 2.386-3.0357 1.4389-1.882.929-1.0868-.0062-.1579h-.0546l-6.3385 4.1164-1.1293.1457-.4857-.4554.0608-.7467.2307-.2429 1.9064-1.3114Z",
  },
  cursor: {
    fill: "currentColor",
    path: "M11.503.131 1.891 5.678a.84.84 0 0 0-.42.726v11.188c0 .3.162.575.42.724l9.609 5.55a1 1 0 0 0 .998 0l9.61-5.55a.84.84 0 0 0 .42-.724V6.404a.84.84 0 0 0-.42-.726L12.497.131a1.01 1.01 0 0 0-.996 0M2.657 6.338h18.55c.263 0 .43.287.297.515L12.23 22.918c-.062.107-.229.064-.229-.06V12.335a.59.59 0 0 0-.295-.51l-9.11-5.257c-.109-.063-.064-.23.061-.23",
  },
  openai: {
    fill: "currentColor",
    // the blossom alone: the box it fills in OpenAI's drawing, which has a disc around it
    box: "4 3.93 15.5 15.5",
    path: "M9.94494 9.59163V8.13227C9.94494 8.00935 9.99105 7.91713 10.0985 7.85575L13.0327 6.16599C13.4321 5.93558 13.9083 5.8281 14.3998 5.8281C16.2432 5.8281 17.4108 7.25677 17.4108 8.77751C17.4108 8.885 17.4108 9.00792 17.3953 9.13083L14.3537 7.34884C14.1694 7.24135 13.985 7.24135 13.8007 7.34884L9.94494 9.59163ZM16.7963 15.2755V11.7883C16.7963 11.5732 16.704 11.4196 16.5197 11.3121L12.664 9.0693L13.9236 8.34725C14.0311 8.28587 14.1234 8.28587 14.2308 8.34725L17.165 10.037C18.0099 10.5287 18.5782 11.5732 18.5782 12.587C18.5782 13.7544 17.887 14.8298 16.7963 15.2753V15.2755ZM9.03861 12.2031L7.77896 11.4658C7.67146 11.4045 7.62535 11.3122 7.62535 11.1893V7.8098C7.62535 6.16613 8.88501 4.92176 10.5902 4.92176C11.2354 4.92176 11.8344 5.13689 12.3415 5.52089L9.31526 7.27218C9.13097 7.37968 9.03875 7.53328 9.03875 7.74841V12.2033L9.03861 12.2031ZM11.75 13.77L9.94494 12.7562V10.6056L11.75 9.59178L13.5549 10.6056V12.7562L11.75 13.77ZM12.9098 18.44C12.2645 18.44 11.6655 18.2249 11.1585 17.8409L14.1847 16.0896C14.369 15.9821 14.4612 15.8285 14.4612 15.6134V11.1585L15.7363 11.8958C15.8438 11.9572 15.8899 12.0494 15.8899 12.1723V15.5519C15.8899 17.1955 14.6148 18.44 12.9098 18.44ZM9.26901 15.0144L6.33486 13.3246C5.4899 12.833 4.92161 11.7885 4.92161 10.7746C4.92161 9.59177 5.62824 8.53183 6.71886 8.0863V11.5887C6.71886 11.8039 6.81109 11.9575 6.99538 12.065L10.8359 14.2923L9.57621 15.0144C9.46872 15.0758 9.37649 15.0758 9.26901 15.0144ZM9.10013 17.5337C7.36426 17.5337 6.08919 16.2279 6.08919 14.6149C6.08919 14.492 6.1046 14.3691 6.11988 14.2462L9.1461 15.9975C9.33039 16.105 9.51483 16.105 9.69912 15.9975L13.5549 13.7702V15.2295C13.5549 15.3524 13.5088 15.4446 13.4013 15.506L10.4671 17.1958C10.0677 17.4262 9.59148 17.5337 9.09999 17.5337H9.10013ZM12.9098 19.3616C14.7685 19.3616 16.32 18.0406 16.6735 16.2893C18.3939 15.8438 19.5 14.2308 19.5 12.5872C19.5 11.5118 19.0391 10.4673 18.2096 9.71454C18.2864 9.39192 18.3326 9.0693 18.3326 8.74682C18.3326 6.55014 16.5505 4.90634 14.4921 4.90634C14.0774 4.90634 13.6779 4.96772 13.2785 5.10605C12.5872 4.43011 11.6347 4 10.5902 4C8.7314 4 7.17996 5.32103 6.8265 7.07232C5.10605 7.51786 4 9.13083 4 10.7745C4 11.8498 4.4608 12.8944 5.29035 13.6471C5.21354 13.9697 5.16743 14.2923 5.16743 14.6148C5.16743 16.8114 6.94941 18.4552 9.00792 18.4552C9.42261 18.4552 9.82204 18.3939 10.2215 18.2556C10.9127 18.9315 11.8651 19.3616 12.9098 19.3616Z",
  },
  zed: {
    fill: "#084CCF",
    path: "M2.25 1.5a.75.75 0 0 0-.75.75v16.5H0V2.25A2.25 2.25 0 0 1 2.25 0h20.095c1.002 0 1.504 1.212.795 1.92L10.764 14.298h3.486V12.75h1.5v1.922a1.125 1.125 0 0 1-1.125 1.125H9.264l-2.578 2.578h11.689V9h1.5v9.375a1.5 1.5 0 0 1-1.5 1.5H5.185L2.562 22.5H21.75a.75.75 0 0 0 .75-.75V5.25H24v16.5A2.25 2.25 0 0 1 21.75 24H1.655C.653 24 .151 22.788.86 22.08L13.19 9.75H9.75v1.5h-1.5V9.375A1.125 1.125 0 0 1 9.375 8.25h5.314l2.625-2.625H5.625V15h-1.5V5.625a1.5 1.5 0 0 1 1.5-1.5h13.19L21.438 1.5z",
  },
  windsurf: {
    fill: "currentColor",
    path: "M23.55 5.067c-1.2038-.002-2.1806.973-2.1806 2.1765v4.8676c0 .972-.8035 1.7594-1.7597 1.7594-.568 0-1.1352-.286-1.4718-.7659l-4.9713-7.1003c-.4125-.5896-1.0837-.941-1.8103-.941-1.1334 0-2.1533.9635-2.1533 2.153v4.8957c0 .972-.7969 1.7594-1.7596 1.7594-.57 0-1.1363-.286-1.4728-.7658L.4076 5.1598C.2822 4.9798 0 5.0688 0 5.2882v4.2452c0 .2147.0656.4228.1884.599l5.4748 7.8183c.3234.462.8006.8052 1.3509.9298 1.3771.313 2.6446-.747 2.6446-2.0977v-4.893c0-.972.7875-1.7593 1.7596-1.7593h.003a1.798 1.798 0 0 1 1.4718.7658l4.9723 7.0994c.4135.5905 1.05.941 1.8093.941 1.1587 0 2.1515-.9645 2.1515-2.153v-4.8948c0-.972.7875-1.7594 1.7596-1.7594h.194a.22.22 0 0 0 .2204-.2202v-4.622a.22.22 0 0 0-.2203-.2203Z",
  },
  gemini: {
    fill: "#8E75B2",
    path: "M11.04 19.32Q12 21.51 12 24q0-2.49.93-4.68.96-2.19 2.58-3.81t3.81-2.55Q21.51 12 24 12q-2.49 0-4.68-.93a12.3 12.3 0 0 1-3.81-2.58 12.3 12.3 0 0 1-2.58-3.81Q12 2.49 12 0q0 2.49-.96 4.68-.93 2.19-2.55 3.81a12.3 12.3 0 0 1-3.81 2.58Q2.49 12 0 12q2.49 0 4.68.96 2.19.93 3.81 2.55t2.55 3.81",
  },
  opencode: {
    fill: "currentColor",
    path: "M22 24H2V0h20zM17 4.8H7v14.4h10z",
  },
};

/** The mark that a word stands for: the scheme of a client's own redirect, or the first word of
 *  the name it gives. */
const MARK_BY_WORD: Record<string, keyof typeof MARKS> = {
  claude: "claude",
  cursor: "cursor",
  codex: "openai",
  chatgpt: "openai",
  openai: "openai",
  zed: "zed",
  windsurf: "windsurf",
  "google gemini": "gemini",
  gemini: "gemini",
  opencode: "opencode",
};

/** The built-in mark of a client we know, and which one. First by what a client cannot claim for
 *  another: its verified domain, and where its access goes. Else by the name it gives, at the
 *  name's start alone, so "Not Codex" and "My ChatGPT helper" get initials. */
export function knownMarkOf(client: {
  name: string;
  redirectUri: string;
  redirectHost: string;
  clientDomain?: string;
}): keyof typeof MARKS | null {
  const host = client.redirectHost.toLowerCase();
  const domain = (client.clientDomain || "").toLowerCase();
  const anthropic = /(^|\.)claude\.(ai|com)$/;
  const openai = /(^|\.)(chatgpt\.com|openai\.com)$/;
  if (anthropic.test(domain) || anthropic.test(host)) return "claude";
  if (openai.test(domain) || openai.test(host)) return "openai";
  const scheme = /^(cursor|zed|windsurf):/i.exec(client.redirectUri)?.[1]?.toLowerCase();
  if (scheme) return MARK_BY_WORD[scheme] ?? null;
  const named =
    /^(claude|cursor|codex|chatgpt|openai|zed|windsurf|google gemini|gemini|opencode)\b/i
      .exec(client.name.trim())?.[1]
      ?.toLowerCase();
  return (named && MARK_BY_WORD[named]) || null;
}

/** The client's own logo, when it may be shown: the client's domain is verified, and the logo is
 *  on that domain (or under it), over https. Its origin is what the page's policy must allow. */
export function shownLogoOf(client: { logoUri?: string; clientDomain?: string }) {
  if (!client.logoUri || !client.clientDomain) return null;
  let logo: URL;
  try {
    logo = new URL(client.logoUri);
  } catch {
    return null;
  }
  const domain = client.clientDomain.toLowerCase();
  const onDomain = logo.hostname === domain || logo.hostname.endsWith(`.${domain}`);
  if (logo.protocol !== "https:" || !onDomain || logo.username || logo.password) return null;
  return { href: logo.href, origin: logo.origin };
}

/** The client's tile, as HTML for a plain page (plain-page.css `.tile`): the size of the mind's
 *  own mark beside it, or `small` for a row of a list. */
export function clientTile(
  client: {
    name: string;
    redirectUri: string;
    redirectHost: string;
    logoUri?: string;
    clientDomain?: string;
  },
  { small = false }: { small?: boolean } = {},
): string {
  const tile = small ? "tile small" : "tile";
  const known = knownMarkOf(client);
  if (known)
    return `<div class="${tile}" data-client-mark="known" data-client="${known}"><svg viewBox="${"box" in MARKS[known] ? MARKS[known].box : "0 0 24 24"}" xmlns="http://www.w3.org/2000/svg" fill="${MARKS[known].fill}"><path d="${MARKS[known].path}"/></svg></div>`;
  const logo = shownLogoOf(client);
  if (logo)
    return `<div class="${tile}" data-client-mark="logo"><img src="${text(logo.href)}" alt="" referrerpolicy="no-referrer"></div>`;
  // the first two letters or digits of the name
  const initials = [...client.name.replace(/[^\p{L}\p{N}]/gu, "")].slice(0, 2).join("");
  return `<div class="${tile}" data-client-mark="initials">${text(initials.toUpperCase() || "?")}</div>`;
}
