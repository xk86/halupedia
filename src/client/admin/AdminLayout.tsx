import {
  createContext,
  type DragEvent,
  type ReactNode,
  useCallback,
  useContext,
  useMemo,
  useRef,
  useState,
} from "react";
import { cn } from "@/lib/utils";

export const ADMIN_VIEWS = [
  "overview",
  "monitoring",
  "rag",
  "models",
  "prompts",
  "config",
  "exports",
  "articles",
] as const;

export type AdminView = (typeof ADMIN_VIEWS)[number];
export type AdminLayoutMode = "tabs" | "split";
export type AdminTileSpan = "compact" | "half" | "wide" | "full";

interface AdminLayoutState {
  version: 1;
  activeView: AdminView;
  mode: AdminLayoutMode;
  orders: Partial<Record<AdminView, string[]>>;
}

interface AdminTile {
  id: string;
  span?: AdminTileSpan;
  content: ReactNode;
}

const STORAGE_KEY = "halupedia:admin-layout:v1";
const DEFAULT_STATE: AdminLayoutState = {
  version: 1,
  activeView: "overview",
  mode: "tabs",
  orders: {},
};

const SPAN_CLASSES: Record<AdminTileSpan, string> = {
  compact: "lg:col-span-4",
  half: "lg:col-span-6",
  wide: "lg:col-span-8",
  full: "lg:col-span-12",
};

function isAdminView(value: unknown): value is AdminView {
  return ADMIN_VIEWS.includes(value as AdminView);
}

function readLayoutState(): AdminLayoutState {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return DEFAULT_STATE;
    const parsed = JSON.parse(raw) as Partial<AdminLayoutState>;
    return {
      version: 1,
      activeView: isAdminView(parsed.activeView)
        ? parsed.activeView
        : DEFAULT_STATE.activeView,
      mode: parsed.mode === "split" ? "split" : "tabs",
      orders:
        parsed.orders && typeof parsed.orders === "object" ? parsed.orders : {},
    };
  } catch {
    return DEFAULT_STATE;
  }
}

function orderTiles(tiles: AdminTile[], storedOrder: string[]): AdminTile[] {
  const byId = new Map(tiles.map((tile) => [tile.id, tile]));
  const ordered = storedOrder.flatMap((id) => {
    const tile = byId.get(id);
    if (!tile) return [];
    byId.delete(id);
    return [tile];
  });
  return [...ordered, ...byId.values()];
}

function moveId(order: string[], id: string, delta: -1 | 1): string[] {
  const index = order.indexOf(id);
  const target = index + delta;
  if (index < 0 || target < 0 || target >= order.length) return order;
  const next = [...order];
  [next[index], next[target]] = [next[target], next[index]];
  return next;
}

export function useAdminLayout() {
  const [state, setState] = useState<AdminLayoutState>(readLayoutState);

  const persist = useCallback((next: AdminLayoutState) => {
    setState(next);
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
    } catch {}
  }, []);

  const setActiveView = useCallback(
    (activeView: AdminView) => persist({ ...state, activeView }),
    [persist, state],
  );
  const setMode = useCallback(
    (mode: AdminLayoutMode) => persist({ ...state, mode }),
    [persist, state],
  );
  const setOrder = useCallback(
    (view: AdminView, order: string[]) =>
      persist({ ...state, orders: { ...state.orders, [view]: order } }),
    [persist, state],
  );
  const reset = useCallback(() => persist(DEFAULT_STATE), [persist]);

  return { state, setActiveView, setMode, setOrder, reset };
}

interface TileControls {
  draggable: true;
  onDragStart: (event: DragEvent<HTMLElement>) => void;
  onDragEnd: () => void;
  moveEarlier: () => void;
  moveLater: () => void;
  canMoveEarlier: boolean;
  canMoveLater: boolean;
}

const TileOrderContext = createContext<
  ((id: string) => TileControls | null) | null
>(null);

export function useTileControls(id: string): TileControls | null {
  return useContext(TileOrderContext)?.(id) ?? null;
}

export function AdminWorkspace({
  view,
  tiles,
  storedOrder,
  onOrderChange,
}: {
  view: AdminView;
  tiles: AdminTile[];
  storedOrder: string[];
  onOrderChange: (view: AdminView, order: string[]) => void;
}) {
  const ordered = useMemo(
    () => orderTiles(tiles, storedOrder),
    [storedOrder, tiles],
  );
  const order = useMemo(() => ordered.map((tile) => tile.id), [ordered]);
  const draggedId = useRef<string | null>(null);

  const move = useCallback(
    (id: string, delta: -1 | 1) => {
      const next = moveId(order, id, delta);
      if (next !== order) onOrderChange(view, next);
    },
    [onOrderChange, order, view],
  );

  const controlsFor = useCallback(
    (id: string): TileControls | null => {
      const index = order.indexOf(id);
      if (index < 0 || order.length < 2) return null;
      return {
        draggable: true,
        onDragStart: (event) => {
          draggedId.current = id;
          event.dataTransfer.effectAllowed = "move";
          event.dataTransfer.setData("text/plain", id);
        },
        onDragEnd: () => {
          draggedId.current = null;
        },
        moveEarlier: () => move(id, -1),
        moveLater: () => move(id, 1),
        canMoveEarlier: index > 0,
        canMoveLater: index < order.length - 1,
      };
    },
    [move, order],
  );

  return (
    <TileOrderContext.Provider value={controlsFor}>
      <div
        data-admin-workspace={view}
        data-testid={`admin-workspace-${view}`}
        className="grid grid-cols-1 items-start gap-3 lg:grid-cols-12"
      >
        {ordered.map((tile) => (
          <section
            key={tile.id}
            data-admin-tile={tile.id}
            className={cn("min-w-0", SPAN_CLASSES[tile.span ?? "half"])}
            onDragOver={(event) => {
              if (draggedId.current && draggedId.current !== tile.id) {
                event.preventDefault();
                event.dataTransfer.dropEffect = "move";
              }
            }}
            onDrop={(event) => {
              event.preventDefault();
              const source = draggedId.current;
              if (!source || source === tile.id) return;
              const next = order.filter((id) => id !== source);
              const targetIndex = next.indexOf(tile.id);
              next.splice(targetIndex, 0, source);
              onOrderChange(view, next);
              draggedId.current = null;
            }}
          >
            {tile.content}
          </section>
        ))}
      </div>
    </TileOrderContext.Provider>
  );
}
