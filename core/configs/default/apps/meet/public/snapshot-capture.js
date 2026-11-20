// snapshot-capture.js — ONE PICTURE FOR THE AGENT, from this page's own camera or screen
// (../app.ts `POST /snapshot<AGENT>`, ../../../call/snapshot.ts). It reads one frame from the
// page's own MediaStreamTrack (ImageCapture), so a screen shared from a tab in the background still
// gives one; else from a visible <video>, while the tab is visible. It never opens a camera or a
// picker, and never takes another person's video.

/** Grab ONE JPEG frame from a local MediaStream, scaled to at most `maxWidth` px wide. */
async function captureTrackFrame(
  stream,
  {
    maxWidth = 1280,
    quality = 0.8,
    fallbackVideo = null,
    visibilityState = document.visibilityState,
  } = {},
) {
  const track = stream?.getVideoTracks?.()[0];
  if (!track || track.readyState !== "live") {
    return { ok: false, reason: "this page shares no live video track now" };
  }
  let frame = null;
  let how = "track";
  if (typeof ImageCapture === "function") {
    try {
      frame = await new ImageCapture(track).grabFrame();
    } catch {
      frame = null;
    }
  }
  if (!frame) {
    if (visibilityState !== "visible") {
      return {
        ok: false,
        reason:
          "this browser can read a frame only while the tab is visible, and it is in the background",
      };
    }
    if (!fallbackVideo?.videoWidth) {
      return { ok: false, reason: "video frame is not ready yet" };
    }
    frame = fallbackVideo;
    how = "preview";
  }
  const srcWidth = frame.videoWidth ?? frame.width ?? 0;
  const srcHeight = frame.videoHeight ?? frame.height ?? 0;
  if (!srcWidth || !srcHeight) {
    frame.close?.();
    return { ok: false, reason: "video frame had zero dimensions" };
  }
  const scale = Math.min(1, maxWidth / srcWidth);
  const width = Math.max(1, Math.round(srcWidth * scale));
  const height = Math.max(1, Math.round(srcHeight * scale));
  const canvas = Object.assign(document.createElement("canvas"), { width, height });
  const ctx = canvas.getContext("2d");
  if (!ctx) {
    frame.close?.();
    return { ok: false, reason: "2d canvas context unavailable" };
  }
  ctx.drawImage(frame, 0, 0, width, height);
  frame.close?.();
  const blob = await new Promise((resolve) => canvas.toBlob(resolve, "image/jpeg", quality));
  if (track.readyState !== "live" || !blob || !blob.size) {
    return { ok: false, reason: "the track ended while the frame was drawn" };
  }
  return { ok: true, blob, width, height, how };
}

/** Capture ONE frame from `stream` while `checkAllowed()` holds, and POST it (or a decline) to `url`. */
export async function sendSnapshot({
  url,
  requestId,
  page,
  stream,
  checkAllowed,
  fallbackVideo = null,
  fetchImpl = fetch,
}) {
  const baseHeaders = { "x-request": requestId, "x-page": page };
  const decline = async (reason) => {
    await fetchImpl(url, {
      method: "POST",
      headers: { ...baseHeaders, "x-declined": String(reason).slice(0, 200) },
    }).catch(() => {});
    return { ok: false, reason };
  };
  if (!checkAllowed()) return decline('consent ("Let the agent look") is off');
  const captured = await captureTrackFrame(stream, { fallbackVideo });
  if (!captured.ok) return decline(captured.reason);
  if (!checkAllowed()) return decline('consent ("Let the agent look") turned off while capturing');
  const response = await fetchImpl(url, {
    method: "POST",
    headers: {
      ...baseHeaders,
      "content-type": "image/jpeg",
      "x-length": String(captured.blob.size),
      "x-width": String(captured.width),
      "x-height": String(captured.height),
    },
    body: captured.blob,
  }).catch(() => null);
  return {
    ok: Boolean(response?.ok),
    status: response?.status ?? 0,
    width: captured.width,
    height: captured.height,
    bytes: captured.blob.size,
    how: captured.how,
  };
}
