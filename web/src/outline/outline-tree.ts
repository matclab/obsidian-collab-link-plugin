// The outline as a tree (ADR-0062): headings nested by level, each at its
// depth in the tree (not its level), folded by key — a heading's raw text,
// level and occurrence, as a heading asked for (PV6) — never by rank. Pure.

/** A heading of the outline: its rank in the list shown, its key. */
export interface TreeItem {
  index: number;
  level: number;
  text: string;
  key: string;
}

export interface TreeNode {
  item: TreeItem;
  /** From 1, in the tree. */
  depth: number;
  children: TreeNode[];
  /** Every heading under it, at any depth. */
  descendants: number;
}

/** Each heading's key: what `targetOf` names it by, in one pass. */
export function keysOf(
  headings: readonly { source: string; level: number }[],
): string[] {
  const seen = new Map<string, number>();
  return headings.map(({ source, level }) => {
    const named = JSON.stringify([source, level]);
    const occurrence = seen.get(named) ?? 0;
    seen.set(named, occurrence + 1);
    return JSON.stringify({ source, level, occurrence });
  });
}

/** The items as a tree: each under the last one of a lower level. */
export function nest(items: readonly TreeItem[]): TreeNode[] {
  const roots: TreeNode[] = [];
  const open: TreeNode[] = [];
  for (const item of items) {
    while (
      open.length > 0 &&
      (open[open.length - 1] as TreeNode).item.level >= item.level
    )
      open.pop();
    const node: TreeNode = {
      item,
      depth: open.length + 1,
      children: [],
      descendants: 0,
    };
    for (const ancestor of open) ancestor.descendants++;
    const parent = open[open.length - 1];
    if (parent) parent.children.push(node);
    else roots.push(node);
    open.push(node);
  }
  return roots;
}

function* walk(nodes: readonly TreeNode[]): Generator<TreeNode> {
  for (const node of nodes) {
    yield node;
    yield* walk(node.children);
  }
}

/** The deepest depth, 0 for no heading. */
export function treeDepth(roots: readonly TreeNode[]): number {
  let deepest = 0;
  for (const node of walk(roots)) deepest = Math.max(deepest, node.depth);
  return deepest;
}

/** The heading to mark for `current` (PV7): itself if shown, else its
 * closest shown ancestor; none if it is not in the tree. */
export function shownCurrent(
  roots: readonly TreeNode[],
  collapsed: ReadonlySet<string>,
  current: number | undefined,
): number | undefined {
  if (current === undefined) return undefined;
  const find = (
    nodes: readonly TreeNode[],
    shown: number | undefined,
  ): number | undefined => {
    for (const node of nodes) {
      const here = shown ?? node.item.index;
      if (node.item.index === current) return here;
      const hidden = shown ?? (collapsed.has(node.item.key) ? here : undefined);
      const found = find(node.children, hidden);
      if (found !== undefined) return found;
    }
    return undefined;
  };
  return find(roots, undefined);
}

/** « Levels k » (PV5): every heading with children at depth k or deeper
 * folded, the others unfolded. */
export function collapseToDepth(
  roots: readonly TreeNode[],
  depth: number,
): Set<string> {
  const collapsed = new Set<string>();
  for (const node of walk(roots))
    if (node.depth >= depth && node.children.length > 0)
      collapsed.add(node.item.key);
  return collapsed;
}

/** Alt+click (PV4): every heading with children at `depth` folded, or
 * unfolded; the others as in `collapsed`, which is left as it was. */
export function setDepthCollapsed(
  roots: readonly TreeNode[],
  collapsed: ReadonlySet<string>,
  depth: number,
  collapse: boolean,
): Set<string> {
  const next = new Set(collapsed);
  for (const node of walk(roots)) {
    if (node.depth !== depth || node.children.length === 0) continue;
    if (collapse) next.add(node.item.key);
    else next.delete(node.item.key);
  }
  return next;
}
