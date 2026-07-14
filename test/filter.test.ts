import { describe, it, expect } from 'vitest';
import { makeCommitRecencyFilter, makeRecencyFilter } from '../src/filter.js';

describe('makeRecencyFilter()', () => {
  it('should return a stateful filter which discards items older than the most recent one seen', () => {
    interface FakeEntry {
      type: string;
      someDateKey: number;
    }

    function sgv(date: number): FakeEntry {
      return { type: 'sgv', someDateKey: date };
    }

    const filter = makeRecencyFilter<FakeEntry>(item => item.someDateKey);

    expect(filter([2, 3, 4].map(sgv))).toHaveLength(3);

    expect(filter([2, 3, 4].map(sgv))).toHaveLength(0);

    const filtered = filter([2, 3, 4, 8, 6, 7, 5].map(sgv));
    expect(filtered).toHaveLength(4);
    const dates = filtered.map(f => f.someDateKey);
    for (const val of [5, 6, 7, 8]) {
      expect(dates).toContain(val);
    }
  });

  it('can start from a known committed timestamp', () => {
    const filter = makeCommitRecencyFilter<{ at: number }>(item => item.at, 10);
    const selected = filter.select([{ at: 9 }, { at: 10 }, { at: 11 }]);

    expect(selected).toEqual([{ at: 11 }]);
    filter.commit(selected);
    expect(filter.lastCommittedTime()).toBe(11);
  });
});
