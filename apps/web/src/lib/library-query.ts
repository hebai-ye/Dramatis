import type { Card, Persona, WorldBook } from '@dramatis/core';

export type LibrarySort = 'name' | 'updated';

function filterItems<T extends { name: string; updatedAt: string }>(
  items: readonly T[],
  query: string,
  sort: LibrarySort,
  fields: (item: T) => readonly string[],
): T[] {
  const needle = query.trim().toLowerCase();
  return items
    .filter((item) => needle === '' || fields(item).some((field) => field.toLowerCase().includes(needle)))
    .sort((left, right) =>
      sort === 'updated' ? right.updatedAt.localeCompare(left.updatedAt) : left.name.localeCompare(right.name),
    );
}

export function filterPersonas(items: readonly Persona[], query: string, sort: LibrarySort): Persona[] {
  return filterItems(items, query, sort, (item) => [item.name, item.description]);
}

export function filterCards(items: readonly Card[], query: string, sort: LibrarySort): Card[] {
  return filterItems(items, query, sort, (item) => [
    item.name,
    item.nickname,
    item.creator,
    item.description,
    item.personality,
    ...item.tags,
  ]);
}

export function filterWorldBooks(items: readonly WorldBook[], query: string, sort: LibrarySort): WorldBook[] {
  return filterItems(items, query, sort, (item) => [
    item.name,
    ...item.entries.flatMap((entry) => [entry.title, entry.content, ...entry.keys]),
  ]);
}

export function countAttachedIds(ids: readonly string[], items: readonly { id: string }[]): number {
  const existing = new Set(items.map((item) => item.id));
  return new Set(ids.filter((id) => existing.has(id))).size;
}
