"use client";
import { useKeyboardHints } from "@/lib/keyboard-hints";
import { serverMessage } from "@/lib/i18n-errors";
import { LOCALE_TAG } from "@/lib/locale-tag";
import { useT } from "./i18n";
import { Select } from "./select";
import { CommentComposer, CommentBody } from "./comment-composer";
import type { CommentNode } from "@/lib/comment-content";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { Editor } from "@tiptap/core";
import type { Transaction } from "@tiptap/pm/state";
import {
  ChatCircle,
  Check,
  ArrowCounterClockwise,
  Smiley,
  PencilSimple,
  Trash,
  X,
  Link,
  Plus,
} from "@phosphor-icons/react";
import { parsePageLocation, pageLocationHash } from "@/lib/page-location";
import { leaveTo } from "@/lib/history-nav";
import { api, Avatar, Modal } from "./ui";
import EmojiPicker from "./emoji-picker";
import { readCommentDrafts, saveCommentDrafts } from "@/lib/comment-drafts";
import { flushOpenDocuments } from "@/lib/document-flush";
import { CommentQuote } from "./comment-quote";
import { BLOCK_MOVE_META } from "@/lib/document-blocks";
import {
  editorCommentBinding,
  relocatedCommentAnchors,
  selectedCommentAnchor,
  setCommentHighlights,
} from "@/lib/inline-comment-plugin";
import { commentRange } from "@/lib/comment-positions";
import {
  COMMENT_MARGIN_EVENT,
  COMMENT_MARGIN_KEY,
  MARGIN_GAP,
  MARGIN_ROOM,
  marginLayout,
  sameMarginLayout,
  type MarginItem,
} from "@/lib/comment-margin";
import type {
  InlineThread,
  CommentAnchor,
  InlineMessage,
} from "@/lib/inline-comment-types";

// The width the page's column could take: its parent's, less the panels
// beside it in a row (the page comments).
function pageRoom(content: HTMLElement) {
  const parent = content.parentElement;
  if (!parent) return 0;
  const style = getComputedStyle(parent);
  let width =
    parent.clientWidth -
    (parseFloat(style.paddingLeft) || 0) -
    (parseFloat(style.paddingRight) || 0);
  if (style.display.endsWith("flex") && !style.flexDirection.startsWith("column"))
    for (const el of Array.from(parent.children))
      if (el !== content && el instanceof HTMLElement) {
        const s = getComputedStyle(el);
        if (s.position !== "absolute" && s.position !== "fixed" && s.display !== "none")
          width -= el.getBoundingClientRect().width;
      }
  return width;
}

const markOf = (editor: Editor, id: string) =>
  editor.view.dom.querySelector<HTMLElement>(
    `[data-comment-thread="${CSS.escape(id)}"]`,
  );

// Text comments on passages of a document. Where the page has room (see
// MARGIN_ROOM), the threads stand beside the text as in Google Docs: each
// card at the height of its passage, the open one exactly there and the
// others out of its way (lib/comment-margin.ts); a new comment starts
// there too. The button below the text opens the list of all threads.
// On narrower pages, phones and in record dialogs, list, thread and new
// comment share the panel below the text.
export function InlineComments({
  editor,
  pageId,
  rowId,
  generation,
  userId,
}: {
  editor: Editor | null;
  pageId: string;
  rowId?: string;
  generation: string;
  userId: string;
}) {
  const t = useT();
  const keyHints = useKeyboardHints();
  const panel = useRef<HTMLElement | null>(null);
  const tools = useRef<HTMLDivElement | null>(null);
  const marginBox = useRef<HTMLElement | null>(null);
  const cards = useRef(new Map<string, HTMLElement>());
  const linkedThread = useRef<string | null>(null);
  const scrolledThread = useRef<string | null>(null);
  // A card to bring into view once it stands beside the text: its passage
  // (a link, the list) or the card itself (a new comment).
  const reveal = useRef<{ id: string; to: "mark" | "card" } | null>(null);
  const [copied, setCopied] = useState(false);
  const [loadedActive, setLoadedActive] = useState<string | null | undefined>(
    undefined,
  );
  const draftKey = `flowplan-comment-drafts:${userId}:${pageId}:${rowId || "page"}`;
  const [threads, setThreads] = useState<InlineThread[]>([]),
    [active, setActive] = useState<string | null>(null),
    [open, setOpen] = useState(false),
    [filter, setFilter] = useState("open");
  const [draft, setDraft] = useState<{
      anchor: CommentAnchor;
      threadId: string;
      messageId: string;
    } | null>(null),
    [body, setBody] = useState(() => readCommentDrafts(draftKey).body);
  const [bodyContent, setBodyContent] = useState<CommentNode | null>(
    () => readCommentDrafts(draftKey).content || null,
  );
  const [replyDrafts, setReplyDrafts] = useState<
    Record<string, { id: string; body: string; content?: CommentNode | null }>
  >(() => readCommentDrafts(draftKey).replies);
  const [draftStorageFailed, setDraftStorageFailed] = useState(false);
  useEffect(() => {
    setDraftStorageFailed(
      !saveCommentDrafts(draftKey, body, replyDrafts, bodyContent),
    );
  }, [draftKey, body, replyDrafts, bodyContent]);
  const reply = active ? replyDrafts[active]?.body || "" : "";
  function setReply(value: string, content?: CommentNode | null) {
    if (active)
      setReplyDrafts((prev) => ({
        ...prev,
        [active]: {
          id: prev[active]?.id || crypto.randomUUID(),
          body: value,
          content,
        },
      }));
  }
  const [editing, setEditing] = useState<{
      message: InlineMessage;
      body: string;
      content?: CommentNode | null;
    } | null>(null),
    [reaction, setReaction] = useState<string | null>(null),
    [deleting, setDeleting] = useState<InlineMessage | null>(null);
  const [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [hint, setHint] = useState(false),
    [revision, setRevision] = useState(0);
  // Room for the column beside the text (measured, see pageRoom), and where
  // its cards stand: `tops` now, `placed` before the last layout (a card
  // only glides to a new place once it stood somewhere).
  const [room, setRoom] = useState(false);
  const roomRef = useRef(false);
  const [layout, setLayout] = useState<{
    tops: Record<string, number>;
    placed: Record<string, number>;
  }>({ tops: {}, placed: {} });
  const mounted = useRef(true),
    inflight = useRef<AbortController | null>(null);
  const refresh = useCallback(
    async (force = false) => {
      if (inflight.current && !force) return;
      inflight.current?.abort();
      const controller = new AbortController();
      inflight.current = controller;
      const timeout = setTimeout(() => controller.abort(), 8000);
      try {
        const response = await fetch(
          `/api/threads?page=${pageId}${rowId ? `&row=${rowId}` : ""}${active ? `&thread=${active}` : ""}`,
          { cache: "no-store", signal: controller.signal },
        );
        const data = await response.json();
        if (!response.ok)
          throw new Error(
            serverMessage(data.error) || t("Kommentare konnten nicht geladen werden.", "Comments could not be loaded."),
          );
        if (mounted.current && inflight.current === controller) {
          setThreads(data);
          setLoadedActive(active);
        }
      } catch (e) {
        if (
          mounted.current &&
          inflight.current === controller &&
          !controller.signal.aborted
        ) {
          setThreads([]);
          setError((e as Error).message);
        }
      } finally {
        clearTimeout(timeout);
        if (inflight.current === controller) inflight.current = null;
      }
    },
    [pageId, rowId, active],
  );
  useEffect(() => {
    mounted.current = true;
    void refresh(true);
    const interval = setInterval(() => {
      if (navigator.onLine && !document.hidden) void refresh();
    }, 5000);
    return () => {
      mounted.current = false;
      inflight.current?.abort();
      clearInterval(interval);
    };
  }, [refresh]);
  // Room beside the text: in the main area (not in a record dialog or a
  // split view), from MARGIN_ROOM of width for the page, less the page
  // comments beside it.
  useLayoutEffect(() => {
    const content = tools.current?.closest<HTMLElement>(".page-content");
    let off = false;
    try {
      off = localStorage.getItem(COMMENT_MARGIN_KEY) === "0";
    } catch {}
    if (
      off ||
      !content ||
      !content.closest(".main") ||
      content.closest(".modal") ||
      typeof ResizeObserver === "undefined"
    )
      return;
    const measure = () => {
      // Split view: each pane's scroll box keeps to its text.
      const fits =
        !content.closest(".split-row.split-active") &&
        pageRoom(content) >= MARGIN_ROOM;
      roomRef.current = fits;
      setRoom(fits);
    };
    measure();
    const resize = new ResizeObserver(measure),
      panels = new MutationObserver(measure);
    resize.observe(content);
    if (content.parentElement) {
      resize.observe(content.parentElement);
      panels.observe(content.parentElement, { childList: true });
    }
    return () => {
      resize.disconnect();
      panels.disconnect();
      roomRef.current = false;
    };
  }, []);
  const anchorRange = (anchor: CommentAnchor) => {
    const binding = editor && editorCommentBinding(editor);
    return binding ? commentRange(binding, anchor, generation) : null;
  };
  // The cards beside the text, in document order: the open threads, an
  // open thread that is resolved, and the new comment.
  const beside: { id: string; from: number; thread?: InlineThread }[] = [];
  if (room) {
    for (const th of threads)
      if ((!th.resolved || th.id === active) && th.id !== draft?.threadId) {
        const r = anchorRange(th.anchor);
        if (r) beside.push({ id: th.id, from: r.from, thread: th });
      }
    const r = draft && anchorRange(draft.anchor);
    if (draft && r) beside.push({ id: draft.threadId, from: r.from });
    beside.sort((a, b) => a.from - b.from);
  }
  const besideIds = new Set(beside.map((b) => b.id));
  const marginShown = beside.length > 0;
  const focus = draft ? draft.threadId : active;
  const draftBeside = !!draft && besideIds.has(draft.threadId);
  const threadBeside = !!active && besideIds.has(active);
  // What the panel below the text shows besides the list: the open thread
  // and the new comment unless they stand beside the text.
  const panelThread = !!active && !threadBeside;
  const panelDraft = !!draft && !draftBeside;
  const panelShown = open || (room && (panelThread || panelDraft));
  useEffect(() => {
    if (!editor) return;
    // Beside the text the new comment's passage is marked as well.
    const marked =
      room && draft
        ? [
            ...threads.filter((th) => th.id !== draft.threadId),
            { id: draft.threadId, anchor: draft.anchor, resolved: false } as unknown as InlineThread,
          ]
        : threads;
    setCommentHighlights(
      editor,
      marked,
      room ? (draft ? draft.threadId : active) : open ? active : null,
    );
  }, [editor, threads, active, open, room, draft]);
  // Every card at its passage (lib/comment-margin.ts); measured after each
  // render and whenever the text or a card changes its size.
  const layoutRef = useRef(() => {});
  layoutRef.current = () => {
    const box = marginBox.current;
    if (!box || !editor || editor.isDestroyed) return;
    const base = box.getBoundingClientRect().top;
    const items: MarginItem[] = [];
    for (const b of beside) {
      const card = cards.current.get(b.id);
      if (!card) continue;
      const mark = markOf(editor, b.id);
      // A passage out of sight (a folded heading or toggle): no card.
      if (mark && !mark.getClientRects().length) continue;
      let top = mark?.getBoundingClientRect().top;
      if (top === undefined)
        try {
          top = editor.view.coordsAtPos(
            Math.min(b.from, editor.state.doc.content.size),
          ).top;
        } catch {
          continue;
        }
      items.push({ id: b.id, anchor: top - base, height: card.offsetHeight });
    }
    const tops = marginLayout(items, focus, MARGIN_GAP);
    setLayout((prev) =>
      sameMarginLayout(prev.tops, tops) ? prev : { tops, placed: prev.tops },
    );
  };
  useLayoutEffect(() => {
    if (marginShown) layoutRef.current();
  });
  const order = beside.map((b) => b.id).join(" ");
  useEffect(() => {
    if (!marginShown || !editor || typeof ResizeObserver === "undefined")
      return;
    let frame = 0;
    const schedule = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => layoutRef.current());
    };
    const observer = new ResizeObserver(schedule);
    observer.observe(editor.view.dom);
    for (const card of cards.current.values()) observer.observe(card);
    window.addEventListener("resize", schedule);
    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
      window.removeEventListener("resize", schedule);
    };
  }, [marginShown, editor, order]);
  // The table of contents gives way to the column (document-outline.tsx).
  useEffect(() => {
    window.dispatchEvent(new Event(COMMENT_MARGIN_EVENT));
  }, [marginShown]);
  useEffect(() => {
    const target = reveal.current;
    if (!target || !editor) return;
    if (!roomRef.current || target.id !== focus) {
      reveal.current = null;
      return;
    }
    const card = cards.current.get(target.id),
      mark = markOf(editor, target.id);
    if (!card || layout.tops[target.id] === undefined) return;
    reveal.current = null;
    if (target.to === "card") card.scrollIntoView({ block: "nearest" });
    else (mark || card).scrollIntoView({ block: "center" });
  });
  useEffect(() => {
    const navigate = () => {
      const target = parsePageLocation(location.hash);
      if (
        target?.pageId === pageId &&
        (target.rowId || undefined) === rowId &&
        target.threadId
      ) {
        linkedThread.current = target.threadId;
        scrolledThread.current = null;
        reveal.current = { id: target.threadId, to: "mark" };
        setActive(target.threadId);
        // Beside the text the thread opens at its passage.
        if (!roomRef.current) setOpen(true);
        setDraft(null);
        setEditing(null);
        setError("");
      } else if (linkedThread.current) {
        linkedThread.current = null;
        setOpen(false);
        setActive(null);
      }
    };
    navigate();
    window.addEventListener("hashchange", navigate);
    return () => window.removeEventListener("hashchange", navigate);
  }, [pageId, rowId]);
  useEffect(() => {
    if (
      panelShown &&
      panelThread &&
      active &&
      linkedThread.current === active &&
      loadedActive === active &&
      scrolledThread.current !== active
    ) {
      panel.current?.scrollIntoView({ block: "start" });
      scrolledThread.current = active;
    }
  }, [panelShown, panelThread, active, loadedActive]);
  // A thread opened from a link: back to the entry it was opened from, or
  // in place (lib/history-nav.ts).
  function leaveLink() {
    const target = parsePageLocation(location.hash);
    if (
      target?.pageId === pageId &&
      (target.rowId || undefined) === rowId &&
      target.threadId
    ) {
      linkedThread.current = null;
      leaveTo(pageLocationHash({ pageId, rowId }), "replace");
    }
  }
  // The X and the panel button close the whole panel: list, thread and
  // new comment (its text stays as a draft, lib/comment-drafts.ts). What
  // stands beside the text stays there.
  function close() {
    setOpen(false);
    setHint(false);
    setError("");
    if (!room || panelDraft) setDraft(null);
    if (!room || panelThread) {
      setActive(null);
      setEditing(null);
      leaveLink();
    }
  }
  // Beside the text: a click in the text away from the open thread's
  // passage closes it, as in Google Docs.
  function deactivate() {
    if (!active || !besideIds.has(active)) return;
    setActive(null);
    setEditing(null);
    setError("");
    leaveLink();
  }
  // A new comment on the selection; `blockFallback` (shortcut, toolbar and
  // text menu) takes the current block when nothing is selected, the
  // panel's "New" asks for a selection instead.
  function begin(blockFallback = true) {
    if (!editor) return;
    setHint(false);
    if (!blockFallback && editor.state.selection.empty) {
      setDraft(null);
      setActive(null);
      setError("");
      setHint(true);
      setOpen(true);
      return;
    }
    try {
      const anchor = selectedCommentAnchor(editor, generation),
        threadId = crypto.randomUUID();
      setDraft({ anchor, threadId, messageId: crypto.randomUUID() });
      if (roomRef.current) reveal.current = { id: threadId, to: "card" };
      else setOpen(true);
      setActive(null);
      setError("");
    } catch (e) {
      setError((e as Error).message);
      setOpen(true);
    }
  }
  // Blocks moved up, down or by dragging take their comments along (#314):
  // Yjs inserts a moved block anew, so the passage gets a fresh anchor,
  // here at once and on the server (thread.reanchor). A new comment beside
  // the text moves along without the server.
  function relocate(transaction: Transaction) {
    if (!editor) return;
    let moved = relocatedCommentAnchors(editor, transaction, generation);
    const own = draft && moved.find((m) => m.id === draft.threadId);
    if (own) {
      setDraft((d) =>
        d && d.threadId === own.id
          ? { ...d, anchor: { ...own.anchor, quote: d.anchor.quote } }
          : d,
      );
      moved = moved.filter((m) => m !== own);
    }
    if (!moved.length) {
      // Highlights left by the structural change come back.
      if (transaction.docChanged && transaction.getMeta(BLOCK_MOVE_META))
        setThreads((prev) => [...prev]);
      return;
    }
    const anchors = new Map(moved.map((m) => [m.id, m.anchor]));
    setThreads((prev) =>
      prev.map((t) => {
        const anchor = anchors.get(t.id);
        // The list shows a shortened quote; the stored one stays whole.
        return anchor ? { ...t, anchor: { ...anchor, quote: t.anchor.quote } } : t;
      }),
    );
    void (async () => {
      try {
        await flushOpenDocuments();
        for (const m of moved)
          await api("/api/command", {
            action: "thread.reanchor",
            pageId,
            rowId,
            threadId: m.id,
            anchor: m.anchor,
          });
      } catch {
        // The next refresh shows what the server kept.
      }
      void refresh(true);
    })();
  }
  const relocateRef = useRef(relocate);
  relocateRef.current = relocate;
  const beginRef = useRef(begin);
  beginRef.current = begin;
  const deactivateRef = useRef(deactivate);
  deactivateRef.current = deactivate;
  const draftId = useRef<string | null>(null);
  draftId.current = draft?.threadId ?? null;
  useEffect(() => {
    if (!editor) return;
    const create = () => beginRef.current(true),
      show = (event: Event) => {
        const id = (event as CustomEvent<string>).detail;
        // The new comment's own passage (marked beside the text).
        if (id === draftId.current) return;
        setActive(id);
        if (!roomRef.current) setOpen(true);
        setDraft(null);
        setHint(false);
      },
      away = (event: MouseEvent) => {
        if (
          roomRef.current &&
          !(event.target as Element | null)?.closest?.("[data-comment-thread]")
        )
          deactivateRef.current();
      },
      update = ({ transaction }: { transaction: Transaction }) => {
        setRevision((n) => n + 1);
        relocateRef.current(transaction);
      };
    const dom = editor.view.dom;
    dom.addEventListener("comment-create", create);
    dom.addEventListener("comment-open", show);
    dom.addEventListener("click", away);
    editor.on("transaction", update);
    return () => {
      dom.removeEventListener("comment-create", create);
      dom.removeEventListener("comment-open", show);
      dom.removeEventListener("click", away);
      editor.off("transaction", update);
    };
  }, [editor]);
  const thread = threads.find((t) => t.id === active);
  async function act(action: string, data: Record<string, unknown>) {
    setBusy(true);
    setError("");
    try {
      await api("/api/command", {
        action,
        pageId,
        rowId,
        threadId: active,
        ...data,
      });
      await refresh(true);
      return true;
    } catch (e) {
      setError((e as Error).message);
      void refresh(true);
      return false;
    } finally {
      setBusy(false);
    }
  }
  // A thread from the list; beside the text the page goes to its passage.
  function navigate(id: string) {
    setActive(id);
    setDraft(null);
    setEditing(null);
    setError("");
    if (roomRef.current) reveal.current = { id, to: "mark" };
  }
  function range(t: InlineThread) {
    return anchorRange(t.anchor);
  }
  function goToText(t: InlineThread) {
    const r = range(t);
    if (r && editor) {
      const node = editor.state.doc.nodeAt(r.from),
        chain = editor.chain().focus();
      if (node?.isBlock && r.to === r.from + node.nodeSize)
        chain.setNodeSelection(r.from);
      else chain.setTextSelection(r);
      chain.scrollIntoView().run();
    }
  }
  // revision updates the availability of anchors when remote text changes.
  void revision;
  const errorBeside = room && (draftBeside || threadBeside);
  const errorLine = error && (
    <p className="inline-comment-error" role="alert">
      {error}
    </p>
  );
  const storageLine = draftStorageFailed && (
    <p role="status">
      {t("Dein Entwurf bleibt im geöffneten Editor. Der Browser konnte ihn für einen Seitenwechsel nicht sichern.", "Your draft stays in the open editor. The browser could not keep it for a page change.")}
    </p>
  );
  // The new comment: in the panel, or beside the text (`beside`) without
  // the note below, as the passage is marked in the text.
  const draftForm = (beside: boolean) =>
    draft && (
      <form
        className="inline-comment-new"
        onSubmit={async (e) => {
          e.preventDefault();
          if (busy || !body.trim()) return;
          setBusy(true);
          setError("");
          try {
            await flushOpenDocuments();
            if (
              await act("thread.create", {
                ...draft,
                body,
                content: bodyContent,
              })
            ) {
              setActive(draft.threadId);
              setDraft(null);
              setBody("");
              setBodyContent(null);
            }
          } catch (err) {
            setError((err as Error).message);
          } finally {
            setBusy(false);
          }
        }}
      >
        <blockquote>
          <CommentQuote quote={draft.anchor.quote} />
        </blockquote>
        <CommentComposer
          label={t("Kommentar zur Textstelle", "Comment on the passage")}
          pageId={pageId}
          rowId={rowId}
          body={body}
          content={bodyContent}
          autoFocus
          disabled={busy}
          onChange={(text, content) => {
            setBody(text);
            setBodyContent(content);
          }}
        />
        <div className="inline-comment-actions">
          <button
            className="button primary"
            disabled={busy || !body.trim()}
          >
            {t("Kommentar senden", "Send comment")}
          </button>
          <button
            type="button"
            className="button"
            disabled={busy}
            onClick={() => setDraft(null)}
          >
            {t("Abbrechen", "Cancel")}
          </button>
        </div>
        {!beside && (
          <p className="muted">
            {t("Die markierte Textstelle wird beim Speichern erneut geprüft. Bei Änderungen bleibt dein Entwurf erhalten.", "The marked passage is checked again when saving. If it changed, your draft is kept.")}
          </p>
        )}
      </form>
    );
  // The open thread: in the panel with the way back to the list, its
  // passage and a jump there; beside the text (`beside`) only the thread,
  // as its passage is next to it.
  const threadView = (thread: InlineThread, beside: boolean) => (
    <>
      {!beside && (
        <>
          <button
            className="text-button"
            onClick={() => {
              setActive(null);
              setEditing(null);
            }}
          >
            {t("← Alle Textkommentare", "← All text comments")}
          </button>
          <blockquote>
            <CommentQuote quote={thread.anchor.quote} />
          </blockquote>
        </>
      )}
      <div className="inline-comment-actions">
        <button
          className={beside ? "icon-button" : "text-button"}
          aria-label={beside ? (copied ? t("Link kopiert", "Link copied") : t("Kommentarlink kopieren", "Copy comment link")) : undefined}
          title={beside ? (copied ? t("Link kopiert", "Link copied") : t("Kommentarlink kopieren", "Copy comment link")) : undefined}
          onClick={async () => {
            try {
              await navigator.clipboard.writeText(
                `${location.origin}/${pageLocationHash({ pageId, rowId, threadId: thread.id })}`,
              );
              setCopied(true);
              setTimeout(() => setCopied(false), 2500);
            } catch {
              setError(
                t("Der Link konnte nicht kopiert werden. Bitte erlaube den Zugriff auf die Zwischenablage.", "The link could not be copied. Please allow access to the clipboard."),
              );
            }
          }}
        >
          {beside ? (
            copied ? <Check /> : <Link />
          ) : (
            <>
              <Link /> {copied ? t("Link kopiert", "Link copied") : t("Kommentarlink kopieren", "Copy comment link")}
            </>
          )}
        </button>
        {!beside && (
          <>
            <button
              className="text-button"
              disabled={!range(thread)}
              onClick={() => goToText(thread)}
            >
              {t("Zur Textstelle", "Go to passage")}
            </button>
            {!range(thread) && (
              <span className="muted">{t("Textstelle nicht mehr verfügbar", "Passage no longer available")}</span>
            )}
          </>
        )}
        {thread.canResolve && (
          <button
            className="button compact"
            disabled={busy}
            onClick={() =>
              void act("thread.resolve", {
                version: thread.version,
                resolved: !thread.resolved,
              })
            }
          >
            {thread.resolved ? <ArrowCounterClockwise /> : <Check />}
            {thread.resolved ? t("Wieder öffnen", "Reopen") : t("Thread erledigen", "Resolve thread")}
          </button>
        )}
      </div>
      {thread.messages.map((m) => (
        <article className="inline-comment-message" key={m.id}>
          <Avatar name={m.name} small />
          <div>
            <strong>{m.name}</strong>
            <small>
              {new Date(
                m.created_at.replace(" ", "T") + "Z",
              ).toLocaleString(LOCALE_TAG)}
              {m.edited_at && !m.deleted ? t(" · bearbeitet", " · edited") : ""}
              {m.author_id === null ? t(" · importiert", " · imported") : ""}
            </small>
            {editing?.message.id === m.id ? (
              <form
                onSubmit={async (e) => {
                  e.preventDefault();
                  if (busy || !editing.body.trim()) return;
                  if (
                    await act("thread.edit", {
                      messageId: m.id,
                      version: editing.message.version,
                      body: editing.body,
                      content: editing.content,
                    })
                  )
                    setEditing(null);
                }}
              >
                <CommentComposer
                  key={m.id}
                  label={t("Kommentartext bearbeiten", "Edit comment text")}
                  pageId={pageId}
                  rowId={rowId}
                  body={editing.body}
                  content={editing.content}
                  disabled={busy}
                  autoFocus
                  onChange={(body, content) =>
                    setEditing({ ...editing, body, content })
                  }
                />
                <button
                  className="button"
                  disabled={busy || !editing.body.trim()}
                >
                  {t("Änderung speichern", "Save change")}
                </button>
                <button
                  type="button"
                  className="text-button"
                  onClick={() => setEditing(null)}
                >
                  {t("Bearbeitung abbrechen", "Cancel editing")}
                </button>
              </form>
            ) : m.deleted ? (
              <p>{t("Kommentar gelöscht", "Comment deleted")}</p>
            ) : (
              <CommentBody content={m.content} body={m.body} />
            )}
            {!m.deleted && (
              <div className="inline-comment-actions">
                {m.reactions.map((r) => (
                  <button
                    className="reaction-button"
                    aria-pressed={r.mine}
                    title={r.names.join(", ")}
                    aria-label={t(`${r.emoji} ${r.count} Reaktionen`, `${r.emoji} ${r.count} reactions`)}
                    key={r.emoji}
                    disabled={busy}
                    onClick={() =>
                      void act("thread.react", {
                        messageId: m.id,
                        emoji: r.emoji,
                        active: !r.mine,
                      })
                    }
                  >
                    {r.emoji} {r.count}
                  </button>
                ))}
                <button
                  className="icon-button"
                  aria-label={t("Emoji-Reaktion hinzufügen", "Add emoji reaction")}
                  disabled={busy}
                  onClick={() => setReaction(m.id)}
                >
                  <Smiley />
                </button>
                {m.author_id === userId && (
                  <>
                    <button
                      className="icon-button"
                      aria-label={t("Kommentar bearbeiten", "Edit comment")}
                      disabled={busy}
                      onClick={() =>
                        setEditing({
                          message: m,
                          body: m.body,
                          content: m.content,
                        })
                      }
                    >
                      <PencilSimple />
                    </button>
                    <button
                      className="icon-button"
                      aria-label={t("Kommentar löschen", "Delete comment")}
                      disabled={busy}
                      onClick={() => setDeleting(m)}
                    >
                      <Trash />
                    </button>
                  </>
                )}
              </div>
            )}
          </div>
        </article>
      ))}
      {thread.resolved ? (
        <p className="muted">{t("Dieser Thread ist erledigt.", "This thread is resolved.")}</p>
      ) : (
        <form
          onSubmit={async (e) => {
            e.preventDefault();
            if (busy || !reply.trim()) return;
            if (
              await act("thread.reply", {
                messageId: replyDrafts[thread.id]?.id,
                body: reply,
                content: replyDrafts[thread.id]?.content,
              })
            ) {
              setReply("");
              setReplyDrafts((prev) => ({
                ...prev,
                [thread.id]: { id: crypto.randomUUID(), body: "" },
              }));
            }
          }}
        >
          <CommentComposer
            key={thread.id}
            label={t("Antwort", "Reply||noun")}
            pageId={pageId}
            rowId={rowId}
            body={reply}
            content={replyDrafts[thread.id]?.content}
            disabled={busy}
            onChange={setReply}
          />
          <button
            className="button primary"
            disabled={busy || !reply.trim()}
          >
            {t("Antwort senden", "Send reply")}
          </button>
        </form>
      )}
    </>
  );
  // Beside the text a comment box shows its formatting tools only while it
  // has the focus (app/globals.css). A button pressed in the open card keeps
  // the focus where it is, or the tools would fold away under the pointer
  // and the click would miss the button that moved up.
  const keepFocus = (e: React.MouseEvent) => {
    if ((e.target as Element).closest("button")) e.preventDefault();
  };
  // A closed card beside the text: who wrote, the first comment and how
  // many replies follow; a click opens the thread.
  const closedCard = (thread: InlineThread) => {
    const first = thread.messages.find((m) => !m.deleted),
      name = first?.name ?? thread.messages[0]?.name ?? "",
      replies = Math.max(0, thread.messageCount - 1);
    return (
      <button
        type="button"
        className="inline-margin-card"
        onClick={() => {
          setActive(thread.id);
          setDraft(null);
          setEditing(null);
          setError("");
        }}
      >
        <span className="inline-margin-card-head">
          <Avatar name={name} small />
          <strong>{name}</strong>
        </span>
        <span className="inline-margin-card-text">
          {first?.body || t("Kommentar gelöscht", "Comment deleted")}
        </span>
        {replies > 0 && (
          <small>
            {replies === 1 ? t("1 Antwort", "1 reply") : t(`${replies} Antworten`, `${replies} replies`)}
          </small>
        )}
      </button>
    );
  };
  return (
    <>
      {marginShown && (
        <div className="inline-comment-margin-host">
          <aside
            ref={marginBox}
            className="inline-comment-margin"
            aria-label={t("Textkommentare neben dem Text", "Text comments beside the text")}
          >
            {beside.map((b) => {
              const top = layout.tops[b.id],
                focused = b.id === focus;
              return (
                <div
                  key={b.id}
                  ref={(el) => {
                    if (el) cards.current.set(b.id, el);
                    else cards.current.delete(b.id);
                  }}
                  className={`inline-margin-slot${focused ? " focused" : ""}`}
                  style={
                    top === undefined
                      ? { visibility: "hidden" }
                      : {
                          transform: `translate3d(${focused ? -8 : 0}px, ${top}px, 0)`,
                          transition: b.id in layout.placed ? undefined : "none",
                        }
                  }
                >
                  {b.id === draft?.threadId ? (
                    <section
                      className="inline-margin-card active"
                      onMouseDown={keepFocus}
                      aria-label={t("Neuer Textkommentar", "New text comment")}
                    >
                      {errorLine}
                      {storageLine}
                      {draftForm(true)}
                    </section>
                  ) : focused && b.thread ? (
                    <section
                      className="inline-margin-card active"
                      onMouseDown={keepFocus}
                      aria-label={t("Textkommentar", "Text comment")}
                    >
                      {errorLine}
                      {storageLine}
                      {b.thread.complete ? (
                        threadView(b.thread, true)
                      ) : (
                        <p role="status">{t("Thread wird geladen …", "Loading thread …")}</p>
                      )}
                    </section>
                  ) : (
                    b.thread && closedCard(b.thread)
                  )}
                </div>
              );
            })}
          </aside>
        </div>
      )}
      {/* One button, one panel (#314): the threads, and "New" in the
          panel for a comment on the selection. */}
      <div className="inline-comment-tools" ref={tools}>
        <button
          className="button compact"
          aria-expanded={panelShown}
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => (panelShown ? close() : setOpen(true))}
        >
          <ChatCircle /> {t("Textkommentare (", "Text comments (")}{threads.filter((t) => !t.resolved).length})
        </button>
      </div>
      {panelShown && (
        <section
          ref={panel}
          className="inline-comment-panel"
          aria-label={t("Textkommentare", "Text comments")}
        >
          <header>
            <h3>{t("Textkommentare", "Text comments")}</h3>
            <span className="inline-comment-header-actions">
              <button
                className="button compact"
                aria-label={t("Neuer Textkommentar", "New text comment")}
                aria-expanded={!!draft}
                title={t("Markierte Textstelle oder markierten Block kommentieren", "Comment on the selected passage or block") + keyHints.suffix("Mod+Alt+M")}
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => begin(false)}
              >
                <Plus /> {t("Neu", "New")}
              </button>
              <button
                className="icon-button"
                aria-label={t("Textkommentare schließen", "Close text comments")}
                onClick={close}
              >
                <X />
              </button>
            </span>
          </header>
          {hint && (
            <p className="inline-comment-hint" role="status">
              {t("Markiere zuerst im Text die Stelle oder den Block, den du kommentieren willst, und klicke dann auf „Neu“.", "First select the passage or block you want to comment on, then click “New”.")}
            </p>
          )}
          {storageLine}
          {!errorBeside && errorLine}
          {panelDraft && draftForm(false)}
          {panelThread && !thread ? (
            <p role="status">
              {loadedActive === active
                ? t("Dieser Kommentar ist nicht mehr verfügbar oder gehört zu einer anderen Seite.", "This comment is no longer available or belongs to another page.")
                : t("Thread wird geladen …", "Loading thread …")}
            </p>
          ) : panelThread && thread && !thread.complete ? (
            <p role="status">{t("Thread wird geladen …", "Loading thread …")}</p>
          ) : panelThread && thread ? (
            threadView(thread, false)
          ) : (
            <>
              <label>
                {t("Anzeigen", "Show")}
                <Select
                  value={filter}
                  onChange={(e) => setFilter(e.target.value)}
                >
                  <option value="open">{t("Offene Threads", "Open threads")}</option>
                  <option value="resolved">{t("Erledigte Threads", "Resolved threads")}</option>
                  <option value="all">{t("Alle Threads", "All threads")}</option>
                </Select>
              </label>
              {threads
                .filter(
                  (thread) =>
                    filter === "all" ||
                    (filter === "resolved" ? thread.resolved : !thread.resolved),
                )
                .map((thread) => (
                  <button
                    className="inline-thread-link"
                    key={thread.id}
                    aria-current={thread.id === active || undefined}
                    onClick={() => navigate(thread.id)}
                  >
                    <blockquote>
                      <CommentQuote quote={thread.anchor.quote} />
                    </blockquote>
                    <span>
                      {thread.messages.find((m) => !m.deleted)?.body ||
                        t("Kommentar gelöscht", "Comment deleted")}
                    </span>
                    <small>
                      {thread.messageCount} {t("Beiträge", "posts")}
                      {!range(thread) ? t(" · Textstelle nicht mehr verfügbar", " · passage no longer available") : ""}
                    </small>
                  </button>
                ))}
              {!threads.length && !draft && !hint && (
                <p className="muted">
                  {t("Noch keine Textkommentare. Markiere Text oder einen Block und klicke auf „Neu“.", "No text comments yet. Select text or a block and click “New”.")}
                </p>
              )}
            </>
          )}
        </section>
      )}
      <Modal
        open={!!reaction}
        onClose={() => setReaction(null)}
        title={t("Emoji-Reaktion", "Emoji reaction")}
      >
        <EmojiPicker
          allowSymbols={false}
          onSelect={async (emoji) => {
            if (
              await act("thread.react", {
                messageId: reaction,
                emoji,
                active: true,
              })
            )
              setReaction(null);
          }}
        />
        {error && <p role="alert">{error}</p>}
      </Modal>
      <Modal
        open={!!deleting}
        onClose={() => setDeleting(null)}
        title={t("Kommentar löschen", "Delete comment")}
      >
        <p>
          {t("Der Kommentar wird entfernt. Antworten bleiben im Thread erhalten.", "The comment is removed. Replies stay in the thread.")}
        </p>
        <button
          className="button danger"
          disabled={busy}
          onClick={async () => {
            if (
              deleting &&
              (await act("thread.deleteMessage", {
                messageId: deleting.id,
                version: deleting.version,
              }))
            )
              setDeleting(null);
          }}
        >
          {t("Kommentar endgültig löschen", "Delete comment permanently")}
        </button>
      </Modal>
    </>
  );
}
