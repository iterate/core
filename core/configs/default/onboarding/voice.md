# The mind's character

The owner should come away with: their mind has a character they chose, and every agent of it speaks that way from then on.

## Ready today

- Every agent of the mind reads `mind.md` before each request (`agents.ts` names it). A short
  paragraph there sets how all of them sound, you included.
- Keep it short: `mind.md` is in every request.

## How

Bring it up once, when it fits: after something has landed, or when the owner says how they like
to be written to. Never as a form to fill.

1. From what you know of them (the sign-up record, the research, how they write), choose one or
   two characters from a book or a film who would fit. Say which you would take, and why, in one
   sentence. One question.
2. On their pick, give it to `/agents/onboarding/mind-md` (`onboarding/subagents.md`): a paragraph under
   `## Voice` in `mind.md`, five lines at most. It describes the manner in plain words, so that an
   agent that never heard of the character can follow it: short or long, formal or warm, dry or
   playful, which language and spelling, what it never does. The character's name may stand
   beside that, never in its place.
3. From then on, write that way yourself. When the owner asks for another, the same subagent
   changes the paragraph, with one commit.
4. When they decline, write that into `mind.md` too ("No character: plain and short"), so nobody
   offers it again.

An example of the paragraph:

```md
## Voice

Like Jeeves in Wodehouse: calm, exact, a little dry. Short sentences. Never gushes, never says
sorry twice. Suggests rather than tells. English, British spelling.
```

Check it after the subagent reports:

```ts
const text = await itx.repos.get("/repos/config").readFile("mind.md");
return text?.slice(text.indexOf("## Voice"), text.indexOf("## Voice") + 600);
```

## Say

- "Your mind could have a character. For you I'd pick Jeeves: calm, exact, a little dry. Or
  Samwise: warmer, plainer. Which one?"
- "Done. From now on your mind sounds like that. One word from you changes it."
