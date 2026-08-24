"use client";

// The drag surface of /timeline: mainline on the left, undated column on the right.
//
// Local state is the optimistic copy of the board; the server's copy arrives as
// props and wins whenever nothing is in flight. A drop writes ONE row (the moved
// event's order_key + placement), so a failed save reverts to the server board
// rather than trying to patch a half-applied reorder.

import {
  DndContext,
  DragOverlay,
  KeyboardSensor,
  PointerSensor,
  closestCorners,
  useDroppable,
  useSensor,
  useSensors,
  type Announcements,
  type DragEndEvent,
  type DragOverEvent,
  type DragStartEvent,
} from "@dnd-kit/core";
import {
  SortableContext,
  arrayMove,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import {
  useEffect,
  useMemo,
  useRef,
  useState,
  useTransition,
  type CSSProperties,
} from "react";

import {
  PRECISION_LABELS,
  type OccurredPrecision,
  type TimelineContainer,
  type TimelineEventCard,
} from "../../lib/timeline-contract";
import { moveEventAction } from "./actions";

/** Both lists, as rendered. */
interface Board {
  mainline: TimelineEventCard[];
  pending: TimelineEventCard[];
}

/**
 * Badge colours per precision. Written out in full: Tailwind only sees class
 * literals, so these must never be assembled by concatenation.
 */
const PRECISION_BADGE: Record<OccurredPrecision, string> = {
  exact: "border-emerald-200 bg-emerald-50 text-emerald-800",
  day: "border-sky-200 bg-sky-50 text-sky-800",
  month: "border-violet-200 bg-violet-50 text-violet-800",
  range: "border-amber-200 bg-amber-50 text-amber-800",
  unknown: "border-neutral-300 bg-neutral-100 text-neutral-600",
};

/** Column headings, also used as the drag announcements' drop-target names. */
const CONTAINER_TITLES: Record<TimelineContainer, string> = {
  mainline: "Mainline",
  pending: "Date undecided",
};

function findContainer(board: Board, id: string): TimelineContainer | null {
  if (id === "mainline" || id === "pending") return id;
  if (board.mainline.some((c) => c.id === id)) return "mainline";
  if (board.pending.some((c) => c.id === id)) return "pending";
  return null;
}

function cardById(board: Board, id: string): TimelineEventCard | undefined {
  return (
    board.mainline.find((c) => c.id === id) ?? board.pending.find((c) => c.id === id)
  );
}

/** Shallow copy so the two arrays can be replaced independently. */
function copy(board: Board): Board {
  return { mainline: [...board.mainline], pending: [...board.pending] };
}

const ANNOUNCEMENTS: Announcements = {
  onDragStart: ({ active }) =>
    `Picked up event ${active.data.current?.title ?? active.id}.`,
  onDragOver: ({ active, over }) =>
    over
      ? `Event ${active.data.current?.title ?? active.id} moved next to ${
          over.data.current?.title ?? over.id
        }.`
      : undefined,
  onDragEnd: ({ active, over }) =>
    over
      ? `Event ${active.data.current?.title ?? active.id} was dropped.`
      : `Event ${active.data.current?.title ?? active.id} was not dropped anywhere and returned to its place.`,
  onDragCancel: ({ active }) =>
    `Drag cancelled; event ${active.data.current?.title ?? active.id} returned to its place.`,
};

export function TimelineBoard({
  mainline,
  pending,
}: {
  mainline: TimelineEventCard[];
  pending: TimelineEventCard[];
}) {
  const serverBoard = useMemo<Board>(
    () => ({ mainline, pending }),
    [mainline, pending],
  );
  const [board, setBoard] = useState<Board>(serverBoard);
  const boardRef = useRef<Board>(serverBoard);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isSaving, startTransition] = useTransition();

  /** Update local state and the ref the drag handlers read synchronously. */
  function commit(next: Board): void {
    boardRef.current = next;
    setBoard(next);
  }

  // The server's board wins whenever nothing local is in flight — that is how a
  // saved move, a failed move, and another tab's edit all converge.
  useEffect(() => {
    if (activeId !== null || isSaving) return;
    boardRef.current = serverBoard;
    setBoard(serverBoard);
  }, [serverBoard, activeId, isSaving]);

  const sensors = useSensors(
    // A few pixels of slop so a plain click still reaches the card.
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  function handleDragStart(event: DragStartEvent): void {
    setActiveId(String(event.active.id));
    setError(null);
  }

  /** Cross-list hover: move the card between lists so the drop preview is real. */
  function handleDragOver(event: DragOverEvent): void {
    const { active, over } = event;
    if (over === null) return;

    const current = boardRef.current;
    const id = String(active.id);
    const overId = String(over.id);
    const from = findContainer(current, id);
    const to = findContainer(current, overId);
    if (from === null || to === null || from === to) return;

    const card = cardById(current, id);
    if (card === undefined) return;
    // A dated event belongs on the mainline by its dating — refuse the preview
    // too, so the UI never suggests a move the server would reject.
    if (to === "pending" && card.anchored) return;

    const target = current[to];
    const overIndex = target.findIndex((c) => c.id === overId);
    const translated = active.rect.current.translated;
    const below =
      overIndex >= 0 &&
      translated !== null &&
      translated.top > over.rect.top + over.rect.height / 2;
    const insertAt = overIndex >= 0 ? overIndex + (below ? 1 : 0) : target.length;

    const next = copy(current);
    next[from] = next[from].filter((c) => c.id !== id);
    next[to] = [...target.slice(0, insertAt), card, ...target.slice(insertAt)];
    commit(next);
  }

  function handleDragEnd(event: DragEndEvent): void {
    const { active, over } = event;
    setActiveId(null);

    const current = boardRef.current;
    const id = String(active.id);

    if (over === null) {
      commit(serverBoard); // dropped outside both lists
      return;
    }

    const container = findContainer(current, id);
    if (container === null) {
      commit(serverBoard);
      return;
    }

    // Same-list reorder (cross-list moves already happened in handleDragOver).
    let next = current;
    const items = current[container];
    const overId = String(over.id);
    const oldIndex = items.findIndex((c) => c.id === id);
    const overIndex =
      overId === container ? items.length - 1 : items.findIndex((c) => c.id === overId);
    if (oldIndex !== -1 && overIndex !== -1 && oldIndex !== overIndex) {
      next = copy(current);
      next[container] = arrayMove(items, oldIndex, overIndex);
      commit(next);
    }

    const finalItems = next[container];
    const at = finalItems.findIndex((c) => c.id === id);
    if (at === -1) {
      commit(serverBoard);
      return;
    }
    const beforeId = at > 0 ? finalItems[at - 1].id : null;
    const afterId = at < finalItems.length - 1 ? finalItems[at + 1].id : null;

    // Landed exactly where the server already has it: nothing to write.
    const server = serverBoard[container];
    const serverAt = server.findIndex((c) => c.id === id);
    if (
      serverAt === at &&
      (serverAt > 0 ? server[serverAt - 1].id : null) === beforeId &&
      (serverAt < server.length - 1 ? server[serverAt + 1].id : null) === afterId
    ) {
      return;
    }

    startTransition(async () => {
      const result = await moveEventAction({
        eventId: id,
        target: container,
        beforeId,
        afterId,
      });
      if (!result.ok) {
        setError(result.error);
        commit(serverBoard);
      }
    });
  }

  function handleDragCancel(): void {
    setActiveId(null);
    commit(serverBoard);
  }

  const activeCard = activeId === null ? undefined : cardById(board, activeId);

  return (
    <DndContext
      // Fixed id: dnd-kit otherwise derives the drag instructions' element id
      // from a module-level counter, which starts over on the server and lands
      // on a different number in the browser — a hydration mismatch on every
      // card's aria-describedby.
      id="fairjudge-timeline"
      sensors={sensors}
      collisionDetection={closestCorners}
      accessibility={{
        announcements: ANNOUNCEMENTS,
        screenReaderInstructions: {
          draggable:
            "Press Space to pick up an event card, the arrow keys to move it, Space again to drop it, and Escape to cancel.",
        },
      }}
      onDragStart={handleDragStart}
      onDragOver={handleDragOver}
      onDragEnd={handleDragEnd}
      onDragCancel={handleDragCancel}
    >
      <div className="grid items-start gap-6 lg:grid-cols-[minmax(0,1fr)_22rem]">
        <Column
          id="mainline"
          hint="Ordered by your drags; events with a date anchor start here."
          items={board.mainline}
          numbered
          emptyText="The mainline is empty. Drag an event over from the undated column, or import events that carry dates."
        />
        <Column
          id="pending"
          hint="Events with no date anchor that are not on the mainline yet."
          items={board.pending}
          emptyText="Nothing undecided — every event is on the mainline."
        />
      </div>

      <DragOverlay>
        {activeCard ? <EventCard card={activeCard} dragging /> : null}
      </DragOverlay>

      <div aria-live="polite" className="mt-4 min-h-5 text-sm">
        {error !== null && <span className="text-rose-600">{error}</span>}
        {error === null && isSaving && (
          <span className="text-neutral-500">Saving the order…</span>
        )}
      </div>
    </DndContext>
  );
}

function Column({
  id,
  hint,
  items,
  emptyText,
  numbered = false,
}: {
  id: TimelineContainer;
  hint: string;
  items: TimelineEventCard[];
  emptyText: string;
  numbered?: boolean;
}) {
  // `data.title` is what the drag announcements read out when the pointer is
  // over the empty part of a column rather than over a card.
  const { setNodeRef, isOver } = useDroppable({
    id,
    data: { title: CONTAINER_TITLES[id] },
  });

  return (
    <section className="flex flex-col gap-3">
      <header className="flex flex-col gap-1">
        <h2 className="text-base font-semibold text-neutral-900">
          {CONTAINER_TITLES[id]}
          <span className="ml-2 text-sm font-normal text-neutral-500">
            {items.length}
          </span>
        </h2>
        <p className="text-xs text-neutral-500">{hint}</p>
      </header>

      <div
        ref={setNodeRef}
        className={`flex min-h-32 flex-col gap-3 rounded-xl border border-dashed p-3 transition-colors ${
          isOver ? "border-neutral-400 bg-neutral-50" : "border-neutral-200"
        }`}
      >
        <SortableContext
          items={items.map((c) => c.id)}
          strategy={verticalListSortingStrategy}
        >
          {items.map((card, index) => (
            <SortableEventCard
              key={card.id}
              card={card}
              index={numbered ? index + 1 : undefined}
            />
          ))}
        </SortableContext>

        {items.length === 0 && (
          <p className="m-auto max-w-xs text-center text-sm text-neutral-400">
            {emptyText}
          </p>
        )}
      </div>
    </section>
  );
}

function SortableEventCard({
  card,
  index,
}: {
  card: TimelineEventCard;
  index?: number;
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } =
    useSortable({ id: card.id, data: { title: card.title } });

  // Built by hand instead of pulling in @dnd-kit/utilities: a vertical list only
  // ever needs the translation, and this keeps the dependency list unchanged.
  const style: CSSProperties = {
    transform:
      transform === null
        ? undefined
        : `translate3d(${transform.x}px, ${transform.y}px, 0)`,
    transition: transition ?? undefined,
  };

  return (
    <div ref={setNodeRef} style={style} className={isDragging ? "opacity-40" : undefined}>
      <EventCard card={card} index={index} handleProps={{ ...attributes, ...listeners }} />
    </div>
  );
}

function EventCard({
  card,
  index,
  handleProps,
  dragging = false,
}: {
  card: TimelineEventCard;
  index?: number;
  handleProps?: Record<string, unknown>;
  dragging?: boolean;
}) {
  return (
    <article
      {...handleProps}
      className={`flex cursor-grab touch-none flex-col gap-2 rounded-xl border bg-white p-4 select-none ${
        dragging
          ? "border-neutral-400 shadow-lg"
          : "border-neutral-200 hover:border-neutral-300"
      }`}
    >
      <div className="flex items-start justify-between gap-3">
        <h3 className="text-sm font-medium text-neutral-900">
          {index !== undefined && (
            <span className="mr-2 text-xs text-neutral-400">{index}</span>
          )}
          {card.label !== null && (
            <span className="mr-2 rounded bg-neutral-100 px-1.5 py-0.5 font-mono text-xs text-neutral-600">
              {card.label}
            </span>
          )}
          {card.title}
        </h3>
        <span
          className={`shrink-0 rounded-full border px-2 py-0.5 text-xs ${
            PRECISION_BADGE[card.precision]
          }`}
          title={PRECISION_LABELS[card.precision]}
        >
          {card.dateLabel}
        </span>
      </div>

      {card.summary !== null && (
        <p className="line-clamp-3 text-xs leading-relaxed text-neutral-600">
          {card.summary}
        </p>
      )}
    </article>
  );
}
