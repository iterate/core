# Contexts and facets

This code decides what keeps a context Durable Object and the facets it hosts running, so what they bill. [Context residency](../../docs/residency.md) names the seven mechanisms that prevent, end or record that, and the tests that pin each: read it before changing how long a context or facet stays running, what wakes it, its alarms, its claims or what its birth resets.

## Roots that wrap a binding

A root keeps the binding's own names and options where capnweb can carry them (`itx.images`, `itx.cfArtifacts`). The platform answers a returned `RpcTarget` with the expression that made it and replays that expression on every later verb (`dispatch.ts`, `itxAnswerDetachedFromSession`). So a builder is a plan: it holds its arguments and touches the binding when a terminal verb runs. A root whose builders take large arguments resolves at the edge for a capnweb session (`rpc.ts`, `statelessResolverOf`), so a context's Durable Object never replays them. capnweb ends a call's stream and stub arguments when the call returns: lock the stream, and `dup()` the stub, when it arrives. [images.ts](images.ts) is the worked example.
