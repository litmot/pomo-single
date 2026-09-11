import type { Task } from "./types";

/** 落とし先の当たり所。行の上下の端は挿入、中央は入れ子 */
export type DropZone = "before" | "after" | "into";

export interface DropTarget {
  id: string;
  zone: DropZone;
}

/** 移動先。`parentId` が null なら最上位、`afterId` の直後 (null なら先頭) */
export interface Move {
  parentId: string | null;
  afterId: string | null;
}

/** 子を持つタスクは 1 階層の決まりでサブタスクにできない */
export function canNest(tasks: Task[], id: string | null): boolean {
  return id !== null && !tasks.some((t) => t.parentId === id);
}

/**
 * 落とした場所から、新しい親と差し込み位置を決める。
 *
 * 端に落とせば「落とした行と同じ階層」に入るので、サブタスクを最上位の行の
 * 端に落とせば親タスクへ戻る。中央に落とせばその行のサブタスクになる。
 *
 * 動かせない組み合わせ (自分自身、見つからない行) は null を返す。
 */
export function resolveDrop(
  tasks: Task[],
  draggedId: string,
  target: DropTarget,
): Move | null {
  const dragged = tasks.find((t) => t.id === draggedId);
  const to = tasks.find((t) => t.id === target.id);
  if (!dragged || !to || dragged.id === to.id) return null;

  if (target.zone === "into") {
    if (!canNest(tasks, to.id) && !tasks.some((t) => t.parentId === to.id)) return null;
    // 末尾に足す。既にある内訳の順番は動かさない
    const children = tasks.filter((t) => t.parentId === to.id && t.id !== dragged.id);
    return { parentId: to.id, afterId: children[children.length - 1]?.id ?? null };
  }

  const parentId = to.parentId ?? null;
  const siblings = tasks.filter(
    (t) => (t.parentId ?? null) === parentId && t.id !== dragged.id,
  );
  const index = siblings.findIndex((t) => t.id === to.id);

  if (target.zone === "after") return { parentId, afterId: to.id };
  return { parentId, afterId: index > 0 ? siblings[index - 1].id : null };
}
