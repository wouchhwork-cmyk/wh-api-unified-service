import { describe, expect, it } from 'vitest';
import { splitPersonName } from '@/shared/utils/person-name';

/**
 * Splitting a name on the first space.
 *
 * The edge cases are the point: the naive rule is fine for greeting and sorting,
 * and these tests pin down that it never produces junk — an empty string as a
 * surname, a stray space becoming a name, or a crash on nothing.
 */
describe('splitPersonName', () => {
  it('splits a two-part name', () => {
    expect(splitPersonName('Ada Lovelace')).toEqual({
      firstName: 'Ada',
      lastName: 'Lovelace',
    });
  });

  it('keeps everything after the first space as the surname', () => {
    // Not "del" alone: the rest of the name travels together.
    expect(splitPersonName('Maria del Carmen Fernandez')).toEqual({
      firstName: 'Maria',
      lastName: 'del Carmen Fernandez',
    });
  });

  it('leaves a single name without a surname rather than inventing one', () => {
    expect(splitPersonName('Prince')).toEqual({ firstName: 'Prince', lastName: null });
  });

  it('collapses runs of whitespace, including non-breaking spaces', () => {
    expect(splitPersonName('  Ada   Lovelace  ')).toEqual({
      firstName: 'Ada',
      lastName: 'Lovelace',
    });
  });

  it.each([null, undefined, '', '   '])('yields nulls for %p', (value) => {
    expect(splitPersonName(value)).toEqual({ firstName: null, lastName: null });
  });

  it('never returns an empty string as a name', () => {
    const result = splitPersonName('Ada  ');
    expect(result.firstName).toBe('Ada');
    expect(result.lastName).toBeNull();
  });
});
