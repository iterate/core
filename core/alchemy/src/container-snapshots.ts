// container-snapshots.ts — A DESTROY THAT FINISHES WHEN CLOUDFLARE KEEPS A SANDBOX'S SNAPSHOTS.
// A sandbox that saved itself (`ctx.container.snapshotContainer()`) leaves its snapshot in the
// account's container registry, under `<account>/cloudchamber-snapshots/<id>`. Alchemy's container
// application deletes those tags before the application. Cloudflare's registry refuses that DELETE
// with HTTP 403, with every credential its API makes (`pull`, `push`), under tokens that hold
// "Cloudchamber Write" and "Workers Containers Write"; the same credentials delete a tag in an
// ordinary image repository. Alchemy's provider then fails, and the whole destroy with it.
//
// THAT REFUSAL IS AN EXPECTED OUTCOME: the application is deleted all the same, and the destroy
// says, for each snapshot repository, that it stays in the account and how many tags it holds.
// Cloudflare keeps the snapshots after their application is deleted, and no API that we know of
// removes them. Any other failure fails the destroy, as Alchemy's provider would. A deploy is not
// touched.
import * as Cloudflare from "@alchemy.run/cloudflare";
import {
  listApplicationDurableObjects,
  listSnapshotImages,
} from "@alchemy.run/cloudflare/Containers/ContainerSnapshots";
import * as Containers from "@distilled.cloud/cloudflare/containers";
import * as Provider from "alchemy/Provider";
import type { ProviderError } from "alchemy/Provider";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { z } from "zod";
import { eachLineOnce } from "./realtime.ts";

type ApplicationService = Provider.ProviderService<Cloudflare.Containers.DurableObjectApplication>;
type Application = Parameters<ApplicationService["delete"]>[0]["output"];

/** One snapshot repository that the registry would not delete, and how many of its tags this
 *  application's Durable Objects saved. One repository may hold the snapshots of several
 *  applications. */
export type Leftover = { repository: string; tags: number };

/** The registry's refusal of a snapshot tag's DELETE, as Alchemy gives it
 *  (`ContainerSnapshotCleanupError`, "Container registry DELETE … returned HTTP 403"). A registry
 *  that cannot be reached, or another status, is not it. */
export const isSnapshotRefusal = (error: unknown) => SnapshotRefusal.safeParse(error).success;
const SnapshotRefusal = z.object({
  _tag: z.literal("ContainerSnapshotCleanupError"),
  message: z.string().regex(/^Container registry DELETE \S+ returned HTTP 403$/),
});

export const leftoverLine = ({ repository, tags }: Leftover) =>
  `${repository} keeps ${tags} tags of this mind's sandbox snapshots: Cloudflare's container registry refuses to delete them, and keeps them after the container application is deleted. They hold copies of the sandboxes' files. The repository may also hold other applications' snapshots.`;

/** Alchemy's provider `base` of a container application, whose `delete` deletes the application
 *  when the registry refuses a snapshot (`isSnapshotRefusal`), and says `leftoverLine` for each
 *  snapshot repository that `calls.leftovers` names, read before the application goes.
 *
 *  Alchemy registers this provider for two modes (`ProviderLayer.dual`), and its engine calls the
 *  variant in `modes` (`providerForMode`), not the registered service's own `delete`: so the live
 *  variant is wrapped too. The local variant has no registry and stays as it is. */
export function snapshotRefusalProvider(
  base: ApplicationService,
  calls: {
    leftovers: (application: Application) => Effect.Effect<ReadonlyArray<Leftover>, ProviderError>;
    deleteContainerApplication: (input: {
      accountId: string;
      applicationId: string;
    }) => Effect.Effect<unknown, ProviderError>;
  },
  say: (line: string) => void,
): ApplicationService {
  const wrap = (service: ApplicationService): ApplicationService => ({
    ...service,
    delete: (input) =>
      service.delete(input).pipe(
        Effect.catchIf(isSnapshotRefusal, () =>
          Effect.gen(function* () {
            const left = yield* calls.leftovers(input.output);
            yield* calls
              .deleteContainerApplication({
                accountId: input.output.accountId,
                applicationId: input.output.applicationId,
              })
              .pipe(
                Effect.catchIf(
                  (error) => error._tag === "ContainerApplicationNotFound",
                  () => Effect.void,
                ),
              );
            for (const leftover of left) say(leftoverLine(leftover));
          }),
        ),
      ),
  });
  const wrapped = wrap(base);
  if (!base.modes) return wrapped;
  return { ...wrapped, modes: { ...base.modes, live: Effect.map(base.modes.live, wrap) } };
}

/** The snapshot repositories of an application's Durable Objects, with their tag counts. */
const leftoversOf = (application: Application) =>
  Effect.gen(function* () {
    const objects = yield* listApplicationDurableObjects(
      application.accountId,
      application.applicationId,
    );
    const tags = yield* listSnapshotImages(application.accountId, objects);
    const counts = new Map<string, number>();
    for (const { repository } of tags) counts.set(repository, (counts.get(repository) ?? 0) + 1);
    return [...counts].map(([repository, count]) => ({ repository, tags: count }));
  });

/** The stack's provider of container applications: put it over `Cloudflare.providers()`, which it
 *  overrides for this type. */
export const ContainerSnapshotProviders = () =>
  Provider.effect(
    Cloudflare.Containers.DurableObjectApplication,
    Effect.gen(function* () {
      // the deploy's Cloudflare credentials and HTTP client, which Alchemy's own calls use
      const context = yield* Effect.context<Containers.CloudflareOpContext>();
      return snapshotRefusalProvider(
        yield* Cloudflare.Containers.DurableObjectApplication.Provider,
        {
          leftovers: (application) => leftoversOf(application).pipe(Effect.provideContext(context)),
          deleteContainerApplication: (input) =>
            Containers.deleteContainerApplication(input).pipe(Effect.provideContext(context)),
        },
        eachLineOnce(console.log),
      );
    }),
  ).pipe(Layer.provide(Cloudflare.Containers.DurableObjectApplicationProvider()));
