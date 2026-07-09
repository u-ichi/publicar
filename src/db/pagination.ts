export type TimeIdCursor = {
  time: string;
  id: string;
};

export function clampPageLimit(limit: number): number {
  return Math.min(Math.max(limit, 1), 100);
}

export function parseTimeIdCursor(cursor: string | undefined | null): TimeIdCursor | null {
  if (!cursor) {
    return null;
  }
  const [time, id] = cursor.split("|");
  return { time, id: id as string };
}

export function formatTimeIdCursor(time: string, id: string): string {
  return `${time}|${id}`;
}
