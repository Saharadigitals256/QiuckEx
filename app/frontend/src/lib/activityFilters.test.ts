import { describe, expect, it } from 'vitest';
import { filterActivityItems } from './activityFilters';

describe('filterActivityItems', () => {
  const items = [
    {
      id: 'tx-abc-123',
      amount: '150.00',
      asset: 'USDC',
      memo: 'Invoice 4201',
      date: '2h ago',
      status: 'Settled' as const,
      source: 'GB3A...',
      destination: 'GD9X...',
      timestamp: '2025-01-01T00:00:00Z',
    },
    {
      id: 'tx-def-456',
      amount: '50.00',
      asset: 'XLM',
      memo: 'Refund',
      date: '1d ago',
      status: 'Pending' as const,
      source: 'GABC...',
      destination: 'GDEF...',
      timestamp: '2025-01-02T00:00:00Z',
    },
  ];

  it('matches text across memo, hash, source, destination and asset', () => {
    const result = filterActivityItems(items, {
      query: 'invoice',
      status: 'All',
      asset: 'All',
    });

    expect(result).toHaveLength(1);
    expect(result[0].id).toBe('tx-abc-123');
  });

  it('filters by status and asset together', () => {
    const result = filterActivityItems(items, {
      query: '',
      status: 'Pending',
      asset: 'XLM',
    });

    expect(result).toHaveLength(1);
    expect(result[0].id).toBe('tx-def-456');
  });

  it('returns empty results when no items match', () => {
    const result = filterActivityItems(items, {
      query: 'not found',
      status: 'Settled',
      asset: 'XLM',
    });

    expect(result).toEqual([]);
  });
});
