// request-body.ts — A REQUEST WHOSE BODY THIS INVOCATION READS ITSELF. workerd ends ("neuters") an
// invocation's request body once its answer is sent. A body that went on to another Worker (a
// service binding, a Durable Object, a loaded Worker) is pumped there in a `waitUntil` of this
// invocation (workerd src/workerd/api/http.c++, `handleCancelablePump`). When that Worker answered
// without reading it, the pump still reads after the answer, fails with "Can't read from request
// stream after response has been sent." and the failure is this invocation's uncaught exception
// (workerd#918, workerd#1730). The pump drops a disconnect alone.
//
// So this invocation's own pipe reads the body, and the request that goes on carries the pipe's
// other end. When the body is cut off because the answer was sent, the pipe ENDS the body that went
// on: no Worker can read a body after its answer, so nobody can mistake the end for the whole
// body. Any other failure, such as a client that went away mid-upload, goes on as that error, so a
// cut upload never looks whole. Each is logged as info.
//
// The pipe is a JS TransformStream, not an IdentityTransformStream: workerd cannot pipe the
// readable of one native transform stream into another ("Inter-TransformStream
// ReadableStream.pipeTo() is not implemented."), and the file route pipes an upload into a
// FixedLengthStream for R2. `new Request` refuses a body on GET or HEAD, which carry none.
export function requestWithOwnedBody(request: Request, where: string): Request {
  if (!request.body || request.method === "GET" || request.method === "HEAD") return request;
  const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>();
  request.body.pipeTo(writable, { preventAbort: true }).catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    const afterAnswer = message === "Can't read from request stream after response has been sent.";
    console.info({ event: "request-body-unread", where, afterAnswer, message });
    // neither waits: nothing may read the other end any more
    (afterAnswer ? writable.close() : writable.abort(error)).catch(() => {});
  });
  // Node (undici) needs `duplex` for a streamed body; RequestInit does not declare it
  return new Request(request, { body: readable, duplex: "half" } as RequestInit);
}
