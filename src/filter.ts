export function makeRecencyFilter<T>(timeFn: (item: T) => number): (items: T[]) => T[] {
  const filter = makeCommitRecencyFilter(timeFn);

  return function (items: T[]): T[] {
    const out = filter.select(items);
    filter.commit(out);
    return out;
  };
}

export interface CommitRecencyFilter<T> {
  select(items: T[]): T[];
  commit(items: T[]): void;
  lastCommittedTime(): number;
}

export function makeCommitRecencyFilter<T>(
  timeFn: (item: T) => number,
  initialLastTime = 0,
): CommitRecencyFilter<T> {
  let lastTime = initialLastTime;

  return {
    select(items: T[]): T[] {
      return items.filter(item => timeFn(item) > lastTime);
    },

    commit(items: T[]): void {
      for (const item of items) {
        lastTime = Math.max(lastTime, timeFn(item));
      }
    },

    lastCommittedTime(): number {
      return lastTime;
    },
  };
}
