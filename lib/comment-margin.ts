// Text comments beside the text, as in Google Docs (components/inline-comments.tsx).
// The layout follows Liveblocks' AnchoredThreads
// (@liveblocks/react-tiptap, Apache-2.0, Copyright 2021-present Liveblocks),
// rewritten here: every card wants to sit at the height of its passage
// (`anchor`). The focused card (the open thread or the new comment) gets
// exactly that height. The cards after it go down, each below the one
// before it, and the cards before it go up, each above the one after it.
// Without a focused card, all cards flow down from the first.
// `items` come in document order; the result maps each id to its top.
export type MarginItem = { id: string; anchor: number; height: number };

export function marginLayout(
  items: MarginItem[],
  focus: string | null,
  gap: number,
): Record<string, number> {
  const tops: Record<string, number> = {};
  const at = focus ? items.findIndex((item) => item.id === focus) : -1;
  let bottom = -Infinity;
  if (at >= 0) {
    tops[items[at].id] = items[at].anchor;
    bottom = items[at].anchor + items[at].height;
  }
  for (let i = at + 1; i < items.length; i++) {
    const top = Math.max(items[i].anchor, bottom + gap);
    tops[items[i].id] = top;
    bottom = top + items[i].height;
  }
  let next = at >= 0 ? items[at].anchor : 0;
  for (let i = at - 1; i >= 0; i--) {
    const top = Math.min(items[i].anchor, next - gap - items[i].height);
    tops[items[i].id] = top;
    next = top;
  }
  return tops;
}

// Whether two layouts put every card at the same place (to half a pixel).
export function sameMarginLayout(
  a: Record<string, number>,
  b: Record<string, number>,
) {
  const keys = Object.keys(a);
  return (
    keys.length === Object.keys(b).length &&
    keys.every((k) => k in b && Math.abs(a[k] - b[k]) < 0.5)
  );
}

// The page needs this much width for the text and the column beside it
// (app/globals.css: 65 px padding, at least 560 px of text, 32 px gap,
// a 272 px card and 24 px to the edge). Narrower pages, phones and record
// dialogs keep the comment panel below the text.
export const MARGIN_ROOM = 960;
// Space between two cards.
export const MARGIN_GAP = 12;
// Sent on the window when the column appears or goes, so the table of
// contents can give way to it (components/document-outline.tsx).
export const COMMENT_MARGIN_EVENT = "flowplan:comment-margin";
// "0" in this browser keeps the panel below the text on wide pages too (the
// browser tests of the panel use it).
export const COMMENT_MARGIN_KEY = "flowplan.commentMargin";
