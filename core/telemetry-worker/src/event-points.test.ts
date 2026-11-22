import assert from "node:assert/strict";
import { test } from "node:test";
import { EVENT_POINTS_MAX, eventPoints, OTHER_TYPES, writeEventPoints } from "./event-points.ts";

const row = (path: string, type: string, payload_bytes = 10) => ({ path, type, payload_bytes });

void test("one point for each path and type, with the count and the summed payload bytes", () => {
  const { points, dropped } = eventPoints([
    row("/agents/a", "x", 10),
    row("/agents/a", "y", 5),
    row("/agents/a", "x", 30),
    row("/agents/b", "x", 7),
  ]);
  assert.equal(dropped, 0);
  assert.deepEqual(points, [
    { indexes: ["/agents/a"], blobs: ["event.committed", "/agents/a", "x"], doubles: [2, 40] },
    { indexes: ["/agents/a"], blobs: ["event.committed", "/agents/a", "y"], doubles: [1, 5] },
    { indexes: ["/agents/b"], blobs: ["event.committed", "/agents/b", "x"], doubles: [1, 7] },
  ]);
});

void test("past the cap, the quietest types of a path fold into one (other) point of that path", () => {
  // the busy type of each path keeps its own point; 300 quiet types fold
  const rows = [
    ...Array.from({ length: 5 }, () => row("/a", "busy")),
    ...Array.from({ length: 5 }, () => row("/b", "busy")),
    ...Array.from({ length: 150 }, (_, index) => row("/a", `quiet-${index}`, 1)),
    ...Array.from({ length: 150 }, (_, index) => row("/b", `quiet-${index}`, 1)),
  ];
  const { points, dropped } = eventPoints(rows);
  assert.equal(points.length, EVENT_POINTS_MAX);
  assert.equal(dropped, 0);
  // 199 groups stay whole, and the 103 quietest, all of /b, fold into one point
  const other = points.filter((each) => each.blobs[2] === OTHER_TYPES);
  assert.deepEqual(other, [
    { indexes: ["/b"], blobs: ["event.committed", "/b", OTHER_TYPES], doubles: [103, 103] },
  ]);
  const counted = points.reduce((sum, each) => sum + each.doubles[0]!, 0);
  const bytes = points.reduce((sum, each) => sum + each.doubles[1]!, 0);
  assert.equal(counted, rows.length);
  assert.equal(bytes, 10 * 10 + 300);
  assert.equal(points[0]!.blobs[2], "busy");
});

void test("past the cap and the fold, the quietest paths are dropped and counted", () => {
  const rows = Array.from({ length: 250 }, (_, index) => [
    row(`/p${index}`, "x"),
    row(`/p${index}`, "y"),
  ]).flat();
  const { points, dropped } = eventPoints(rows);
  assert.equal(points.length, EVENT_POINTS_MAX);
  assert.ok(points.every((each) => each.blobs[2] === OTHER_TYPES));
  assert.ok(points.every((each) => each.doubles[0] === 2));
  assert.equal(dropped, 2 * 50);
});

void test("a write that throws loses its point with one warning, and never throws", (t) => {
  const warn = t.mock.method(console, "warn", () => {});
  const written: unknown[] = [];
  writeEventPoints(
    {
      writeDataPoint: (each) => {
        if (written.length >= 1) throw new Error("too many data points");
        written.push(each);
      },
    },
    [row("/a", "x"), row("/a", "x"), row("/a", "y"), row("/b", "z")],
  );
  assert.equal(written.length, 1);
  assert.equal(warn.mock.callCount(), 1);
  const [warning] = warn.mock.calls[0]!.arguments as [{ event: string; count: number }];
  assert.equal(warning.event, "telemetry.event-points-dropped");
  assert.equal(warning.count, 2);
});

void test("a batch under the cap writes every point and warns nothing", (t) => {
  const warn = t.mock.method(console, "warn", () => {});
  const written: unknown[] = [];
  writeEventPoints({ writeDataPoint: (each) => void written.push(each) }, [row("/a", "x")]);
  assert.equal(written.length, 1);
  assert.equal(warn.mock.callCount(), 0);
});
