import { test } from "node:test";
import assert from "node:assert/strict";
import { marginLayout, sameMarginLayout } from "../lib/comment-margin";

const item = (id: string, anchor: number, height = 50) => ({ id, anchor, height });

test("without a focused card the cards flow down from their passages", () => {
  assert.deepEqual(
    marginLayout([item("a", 0), item("b", 20), item("c", 300)], null, 10),
    { a: 0, b: 60, c: 300 },
  );
});

test("the focused card sits at its passage and pushes the others out of its way", () => {
  // b is open: it stays at 20, a goes up above it, c and d go down below it.
  assert.deepEqual(
    marginLayout(
      [item("a", 0), item("b", 20, 100), item("c", 40), item("d", 400)],
      "b",
      10,
    ),
    { a: -40, b: 20, c: 130, d: 400 },
  );
});

test("cards before the focused one move up only as far as needed", () => {
  assert.deepEqual(
    marginLayout([item("a", 0), item("b", 200), item("c", 210)], "c", 10),
    { a: 0, b: 150, c: 210 },
  );
});

test("an unknown focus lays the cards out as without one", () => {
  assert.deepEqual(
    marginLayout([item("a", 5), item("b", 10)], "gone", 0),
    { a: 5, b: 55 },
  );
});

test("layouts compare to half a pixel", () => {
  assert.ok(sameMarginLayout({ a: 1, b: 2 }, { a: 1.3, b: 2 }));
  assert.ok(!sameMarginLayout({ a: 1 }, { a: 2 }));
  assert.ok(!sameMarginLayout({ a: 1 }, { a: 1, b: 2 }));
});
