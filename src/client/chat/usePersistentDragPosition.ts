import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
  type RefObject,
} from "react";

export interface DragPosition {
  x: number;
  y: number;
}

interface DragState {
  pointerId: number;
  startClientX: number;
  startClientY: number;
  startPosition: DragPosition;
  width: number;
  height: number;
}

interface UsePersistentDragPositionOptions<T extends HTMLElement> {
  storageKey: string;
  fallback: () => DragPosition;
  elementRef: RefObject<T | null>;
  active?: boolean;
  shouldStartDrag?: (target: EventTarget | null) => boolean;
}

function isDragPosition(value: unknown): value is DragPosition {
  if (!value || typeof value !== "object") return false;
  const { x, y } = value as Record<string, unknown>;
  return (
    typeof x === "number" &&
    Number.isFinite(x) &&
    typeof y === "number" &&
    Number.isFinite(y)
  );
}

function loadPosition(
  storageKey: string,
  fallback: () => DragPosition,
): DragPosition {
  if (typeof window === "undefined") return fallback();

  try {
    const stored = JSON.parse(
      window.localStorage.getItem(storageKey) ?? "null",
    );
    return isDragPosition(stored) ? stored : fallback();
  } catch {
    return fallback();
  }
}

function clampPosition(
  position: DragPosition,
  width: number,
  height: number,
): DragPosition {
  const maxX = Math.max(0, window.innerWidth - width);
  const maxY = Math.max(0, window.innerHeight - height);

  return {
    x: Math.min(Math.max(0, position.x), maxX),
    y: Math.min(Math.max(0, position.y), maxY),
  };
}

function positionsMatch(a: DragPosition, b: DragPosition) {
  return a.x === b.x && a.y === b.y;
}

/**
 * Keeps a floating element inside the viewport while dragging and persists its
 * resting position. Pointer moves update the DOM directly; React state changes
 * only when a drag completes or the viewport changes.
 */
export function usePersistentDragPosition<T extends HTMLElement>({
  storageKey,
  fallback,
  elementRef,
  active = true,
  shouldStartDrag,
}: UsePersistentDragPositionOptions<T>) {
  const [position, setPosition] = useState(() =>
    loadPosition(storageKey, fallback),
  );
  const positionRef = useRef(position);
  const dragRef = useRef<DragState | null>(null);
  const draggedRef = useRef(false);
  const suppressClickRef = useRef(false);

  const applyPosition = useCallback(
    (nextPosition: DragPosition) => {
      const element = elementRef.current;
      if (!element) return;
      element.style.left = `${nextPosition.x}px`;
      element.style.top = `${nextPosition.y}px`;
    },
    [elementRef],
  );

  const clampCurrentPosition = useCallback(() => {
    const element = elementRef.current;
    if (!element) return;

    const { width, height } = element.getBoundingClientRect();
    const nextPosition = clampPosition(positionRef.current, width, height);
    if (positionsMatch(positionRef.current, nextPosition)) return;

    positionRef.current = nextPosition;
    applyPosition(nextPosition);
    setPosition(nextPosition);
  }, [applyPosition, elementRef]);

  useEffect(() => {
    positionRef.current = position;
    try {
      window.localStorage.setItem(storageKey, JSON.stringify(position));
    } catch {
      // Storage can be disabled; dragging should still work for this session.
    }
  }, [position, storageKey]);

  useEffect(() => {
    if (!active) return;
    clampCurrentPosition();
  }, [active, clampCurrentPosition]);

  useEffect(() => {
    window.addEventListener("resize", clampCurrentPosition);
    return () => window.removeEventListener("resize", clampCurrentPosition);
  }, [clampCurrentPosition]);

  const startDrag = useCallback(
    (pointerId: number, clientX: number, clientY: number) => {
      const element = elementRef.current;
      if (!element) return false;

      const { width, height } = element.getBoundingClientRect();
      dragRef.current = {
        pointerId,
        startClientX: clientX,
        startClientY: clientY,
        startPosition: positionRef.current,
        width,
        height,
      };
      draggedRef.current = false;
      return true;
    },
    [elementRef],
  );

  const moveDrag = useCallback(
    (pointerId: number, clientX: number, clientY: number) => {
      const drag = dragRef.current;
      if (!drag || drag.pointerId !== pointerId) return;

      const deltaX = clientX - drag.startClientX;
      const deltaY = clientY - drag.startClientY;
      if (Math.abs(deltaX) > 3 || Math.abs(deltaY) > 3)
        draggedRef.current = true;

      const nextPosition = clampPosition(
        { x: drag.startPosition.x + deltaX, y: drag.startPosition.y + deltaY },
        drag.width,
        drag.height,
      );
      positionRef.current = nextPosition;
      applyPosition(nextPosition);
    },
    [applyPosition],
  );

  const finishDrag = useCallback((pointerId: number) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== pointerId) return;

    dragRef.current = null;
    if (!draggedRef.current) return;

    suppressClickRef.current = true;
    setPosition(positionRef.current);
  }, []);

  const onPointerDown = useCallback(
    (event: ReactPointerEvent<HTMLElement>) => {
      if (event.button !== 0) return;
      if (shouldStartDrag && !shouldStartDrag(event.target)) return;
      if (!startDrag(event.pointerId, event.clientX, event.clientY)) return;
      event.currentTarget.setPointerCapture?.(event.pointerId);
    },
    [shouldStartDrag, startDrag],
  );

  const onPointerMove = useCallback(
    (event: ReactPointerEvent<HTMLElement>) => {
      moveDrag(event.pointerId, event.clientX, event.clientY);
    },
    [moveDrag],
  );

  const onPointerEnd = useCallback(
    (event: ReactPointerEvent<HTMLElement>) => {
      finishDrag(event.pointerId);
      event.currentTarget.releasePointerCapture?.(event.pointerId);
    },
    [finishDrag],
  );

  const onMouseDown = useCallback(
    (event: ReactMouseEvent<HTMLElement>) => {
      if (event.button !== 0 || dragRef.current) return;
      if (shouldStartDrag && !shouldStartDrag(event.target)) return;
      if (!startDrag(-1, event.clientX, event.clientY)) return;

      const onMouseMove = (moveEvent: MouseEvent) =>
        moveDrag(-1, moveEvent.clientX, moveEvent.clientY);
      const onMouseUp = () => {
        finishDrag(-1);
        window.removeEventListener("mousemove", onMouseMove);
        window.removeEventListener("mouseup", onMouseUp);
      };
      window.addEventListener("mousemove", onMouseMove);
      window.addEventListener("mouseup", onMouseUp);
    },
    [finishDrag, moveDrag, shouldStartDrag, startDrag],
  );

  const consumeDragClick = useCallback(() => {
    if (!suppressClickRef.current) return false;
    suppressClickRef.current = false;
    return true;
  }, []);

  return {
    style: { left: position.x, top: position.y } satisfies CSSProperties,
    dragHandleProps: {
      onPointerDown,
      onPointerMove,
      onPointerUp: onPointerEnd,
      onPointerCancel: onPointerEnd,
    },
    mouseDragHandleProps: { onMouseDown },
    consumeDragClick,
  };
}
