// src/deployment/processor.ts — THE DEPLOYMENT'S PROCESSOR: the entity lifecycle, where the open run
// stands, and THE RUN, a saga driven from state at head as core/lib README "A multi-step run" lays
// out. A request opens a run while no other is open and the deployment lives; any other request is
// settled `refused` as it is processed. At head, a run that no work of this incarnation drives gets
// ONE driver in `runInBackground`: it lands `attempt-started`, runs one attempt (durable-object.ts,
// run.ts) and settles the run as the attempt ended. Nothing retries here: the caller runs a `failed`
// or `unavailable` run again. An attempt that dies with its incarnation leaves the run open for the
// next pass, up to RUN_ATTEMPTS, and Alchemy's state makes a repeated apply converge. Pure: the
// attempt is the host's, so a unit test constructs the processor with `new` (processor.test.ts).
import type { z } from "zod";
import type { PlatformFailureKind } from "iterate/platform-retry";
import type {
  ConsumedEvent,
  EmittedEventInput,
  ProcessEventArgs,
  ProcessorContract,
  ReduceArgs,
} from "iterate/stream/processor";
import type { ItxEntrypointScope } from "../iterate-context.ts";
import { EntityLifecycleProcessor } from "../project/entity-lifecycle.ts";
import type {
  DeploymentContract,
  DeploymentReleaseStaged,
  DeploymentResourceApplied,
  DeploymentRunPlanned,
  DeploymentRunRequested,
  DeploymentRunSettled,
  DeploymentState,
} from "./contract.ts";

/** The most attempts one run makes, which bounds a run whose attempts keep dying with their
 *  incarnation. Under the engine's five deaths (core/lib stream/processor.ts MAX_DEATHS), so such a
 *  run is still revived to settle `failed`. */
const RUN_ATTEMPTS = 4;

export type DeploymentRun = NonNullable<DeploymentState["run"]>;
/** The facts the deployment's log holds, and the facts its processor appends, as the contract
 *  spells them. */
type DeploymentEvent = ConsumedEvent<typeof DeploymentContract>;
type Emitted = EmittedEventInput<typeof DeploymentContract>;
type Args = ProcessEventArgs<DeploymentState, DeploymentEvent, Emitted>;

/** A step as the attempt reports it: the processor adds the request's offset, the attempt and the
 *  key (`#stepFact`). */
export type DeploymentStepFact =
  | {
      type: "events.iterate.com/deployment/release-staged";
      payload: z.input<typeof DeploymentReleaseStaged>;
    }
  | {
      type: "events.iterate.com/deployment/run-planned";
      payload: z.input<typeof DeploymentRunPlanned>;
    }
  | {
      type: "events.iterate.com/deployment/resource-applied";
      payload: z.input<typeof DeploymentResourceApplied>;
    };

/** How one attempt ended (docs/engineering-invariants.md, "Failures and retries"), each `error`
 *  already masked by the attempt: a success, a refusal (an expected outcome), a failure (any other
 *  error: our own defect, or an answer of Cloudflare's), or the platform's failure of `kind`. The
 *  run settles with the same status. */
export type AttemptOutcome =
  | { status: "succeeded"; url?: string }
  | { status: "refused" | "failed"; error: string }
  | { status: "unavailable"; kind: PlatformFailureKind; error: string };

/** What the run needs of the facet that hosts it: ONE attempt, which reports each step as it lands
 *  and answers every failure as an outcome, masked. A rejection is the host's own defect. */
export type DeploymentRunDeps = {
  attempt(
    run: { requestOffset: number; request: DeploymentRunRequested; attempt: number },
    report: (fact: DeploymentStepFact) => Promise<unknown>,
  ): Promise<AttemptOutcome>;
};

export class DeploymentProcessor extends EntityLifecycleProcessor<DeploymentState> {
  readonly #path: () => string;
  readonly #deps: DeploymentRunDeps;
  /** The driver this incarnation runs. The durable ground is `state.run`, which the next at-head
   *  pass drives again. */
  #driving?: Promise<void>;

  constructor(
    contract: ProcessorContract<DeploymentState>,
    getItx: () => ItxEntrypointScope & Disposable,
    path: () => string,
    effects: ConstructorParameters<typeof EntityLifecycleProcessor>[3],
    deps: DeploymentRunDeps,
  ) {
    super(contract, getItx, path, effects);
    this.#path = path;
    this.#deps = deps;
  }

  override reduce(args: ReduceArgs<DeploymentState, DeploymentEvent>): DeploymentState | undefined {
    const { state, event } = args;
    const { run } = state;
    /** A step of the open run's attempt moves it on; a step of another request or attempt is
     *  history. */
    const step = (
      { requestOffset, attempt }: { requestOffset: number; attempt: number },
      to: DeploymentRun["step"],
    ) =>
      run?.requestOffset === requestOffset && run.attempt === attempt
        ? { ...state, run: { ...run, step: to, stepOffset: event.offset } }
        : undefined;
    switch (event.type) {
      case "events.iterate.com/deployment/run-requested":
        // One run at a time, while the deployment lives: processEvent settles any other request.
        if (run || state.creation?.status !== "created" || state.deletion) return undefined;
        return {
          ...state,
          target: { accountId: event.payload.accountId, configId: event.payload.configId },
          run: {
            requestOffset: event.offset,
            request: event.payload,
            attempt: 0,
            step: "requested",
            stepOffset: event.offset,
          },
        };
      case "events.iterate.com/deployment/attempt-started": {
        const { requestOffset, attempt } = event.payload;
        if (run?.requestOffset !== requestOffset || attempt <= run.attempt) return undefined;
        return { ...state, run: { ...run, attempt, step: "started", stepOffset: event.offset } };
      }
      case "events.iterate.com/deployment/release-staged":
        return step(event.payload, "staged");
      case "events.iterate.com/deployment/run-planned":
        return step(event.payload, "planned");
      case "events.iterate.com/deployment/resource-applied":
        return step(event.payload, "applying");
      case "events.iterate.com/deployment/run-settled": {
        // Any status closes the run. The URL is a deploy's: one that succeeded sets it (or keeps the
        // last one, when its output named none), and a destroy that succeeded clears it.
        const { requestOffset, status, url } = event.payload;
        if (run?.requestOffset !== requestOffset) return undefined;
        const { kind } = run.request;
        if (status !== "succeeded" || kind === "plan") return { ...state, run: null };
        return { ...state, run: null, url: kind === "deploy" ? url || state.url : null };
      }
      default:
        return super.reduce(args);
    }
  }

  override processEvent(args: Args): undefined {
    super.processEvent(args);
    const { state, event, delivery, append, blockProcessorWhile, runInBackground } = args;
    // A REQUEST THAT THE REDUCE DID NOT OPEN is settled while it is processed, and the cursor waits
    // for the settlement: no state remembers the request, so no later pass could settle it.
    if (
      event?.type === "events.iterate.com/deployment/run-requested" &&
      state.run?.requestOffset !== event.offset
    )
      blockProcessorWhile(() =>
        this.#settle(append, event.offset, {
          status: "refused",
          attempts: 0,
          error: state.run
            ? `a ${state.run.request.kind} run is open since offset ${state.run.requestOffset}: follow it to its settlement, then ask again`
            : state.deletion
              ? "the deployment's deletion was asked"
              : "the deployment is not created",
        }),
      );
    if (!delivery.caughtUp || !state.run || this.#driving) return;
    const driving = this.#drive(state.run, state.deletion, append).finally(() => {
      this.#driving = undefined;
    });
    this.#driving = driving;
    runInBackground(() => driving);
  }

  /** Resolves when the driver this incarnation runs has ended, however it ended (the engine reports
   *  a failure): the deletion's teardown waits it out before it destroys. */
  async driven(): Promise<void> {
    await this.#driving?.catch(() => undefined);
  }

  /** THE RUN as state at head left it: settled at once when its deletion was asked or its attempts
   *  are spent, else ONE attempt, and the run settled as that attempt ended. */
  async #drive(
    run: DeploymentRun,
    deletion: DeploymentState["deletion"],
    append: Args["append"],
  ): Promise<void> {
    const { requestOffset, request } = run;
    if (deletion)
      return this.#settle(append, requestOffset, {
        status: "refused",
        attempts: run.attempt,
        error: "the deployment's deletion was asked",
      });
    if (run.attempt >= RUN_ATTEMPTS)
      return this.#settle(append, requestOffset, {
        status: "failed",
        attempts: run.attempt,
        error: `gave up after ${run.attempt} attempts, none of which settled the run`,
      });
    // A run found mid-attempt: that attempt ended before it settled the run, with its incarnation
    // or before a fact of its driver landed.
    const retrying = `attempt ${run.attempt} ended before it settled the run`;
    const attempt = run.attempt + 1;
    await append({
      type: "events.iterate.com/deployment/attempt-started",
      idempotencyKey: this.idempotencyKey(`attempt-started:${requestOffset}:${attempt}`),
      // a keyed payload holds no key without a value: a repeated append is compared with the
      // stored JSON, which has none
      payload: run.attempt > 0 ? { requestOffset, attempt, retrying } : { requestOffset, attempt },
    });
    const outcome = await this.#deps
      .attempt({ requestOffset, request, attempt }, (fact) =>
        append(this.#stepFact(fact, requestOffset, attempt)),
      )
      .catch((error: unknown): AttemptOutcome => ({
        status: "failed",
        error: `the attempt threw: ${error instanceof Error ? error.message : String(error)}`,
      }));
    if (outcome.status === "succeeded")
      return this.#settle(
        append,
        requestOffset,
        // no `url` key without a URL, as above
        outcome.url
          ? { status: "succeeded", attempts: attempt, url: outcome.url }
          : { status: "succeeded", attempts: attempt },
      );
    return this.#settle(append, requestOffset, {
      status: outcome.status,
      attempts: attempt,
      error:
        outcome.status === "unavailable"
          ? `the platform failed, so run it again: ${outcome.error}`
          : outcome.error,
    });
  }

  /** A step's fact as it lands: the attempt's payload with the request's offset and the attempt,
   *  keyed `<fact>:<requestOffset>:<attempt>`. A resource's key also names the resource and its
   *  status, since a replaced resource lands two facts. */
  #stepFact(fact: DeploymentStepFact, requestOffset: number, attempt: number): Emitted {
    const step = { requestOffset, attempt };
    const name = fact.type.slice(fact.type.lastIndexOf("/") + 1);
    const idempotencyKey = this.idempotencyKey(`${name}:${requestOffset}:${attempt}`);
    // One case for each fact, so that each payload stays matched to its type.
    switch (fact.type) {
      case "events.iterate.com/deployment/release-staged":
        return { type: fact.type, idempotencyKey, payload: { ...fact.payload, ...step } };
      case "events.iterate.com/deployment/run-planned":
        return { type: fact.type, idempotencyKey, payload: { ...fact.payload, ...step } };
      case "events.iterate.com/deployment/resource-applied": {
        const { fqn, status } = fact.payload;
        const payload = { ...fact.payload, ...step };
        return { type: fact.type, idempotencyKey: `${idempotencyKey}:${fqn}:${status}`, payload };
      }
    }
  }

  /** The run's one settlement, keyed by its request, then one `deployment.run-settled` line: info
   *  for a success, else warn. None is reported as an issue: Cloudflare's own answers settle
   *  `failed` too, and a report would page on each. */
  async #settle(
    append: Args["append"],
    requestOffset: number,
    settlement: Omit<DeploymentRunSettled, "requestOffset">,
  ): Promise<void> {
    await append({
      type: "events.iterate.com/deployment/run-settled",
      idempotencyKey: this.idempotencyKey(`run-settled:${requestOffset}`),
      payload: { requestOffset, ...settlement },
    });
    const log = settlement.status === "succeeded" ? console.info : console.warn;
    log({ event: "deployment.run-settled", path: this.#path(), requestOffset, ...settlement });
  }
}
