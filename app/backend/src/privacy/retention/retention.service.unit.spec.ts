import { readFileSync } from 'fs';
import { join } from 'path';

import {
  DELETION_SLA,
  INDEFINITE_RETENTION,
  RETENTION_CATEGORIES,
  RETENTION_ERROR_HTTP,
  RETENTION_HOLDS,
  RETENTION_POLICY_VERSION,
  RetentionErrorCode,
  deletionSlaFor,
  dueAtFor,
  effectiveMethodFor,
  isDue,
} from './retention-schedule';

const SCHEDULE_JSON_PATH = join(
  __dirname,
  '..',
  '..',
  '..',
  '..',
  '..',
  'docs',
  'policies',
  'data',
  'retention-schedule.json',
);

interface ScheduleJson {
  policyVersion: string;
  deletionServiceLevel: Record<string, number | string>;
  methods: string[];
  holds: Array<{ id: string; maxDays: number; reason: string }>;
  categories: Array<{
    id: string;
    storage: string;
    windowDays: number;
    windowFrom: string;
    method: string;
    containsPersonalData: boolean | 'possible';
    holdable: boolean;
  }>;
  errorCodes: Record<string, number>;
}

function loadScheduleJson(): ScheduleJson {
  return JSON.parse(readFileSync(SCHEDULE_JSON_PATH, 'utf8')) as ScheduleJson;
}

describe('retention schedule mirror (docs/policies ↔ backend code)', () => {
  const schedule = loadScheduleJson();

  it('pins the published policy version', () => {
    expect(RETENTION_POLICY_VERSION).toBe(schedule.policyVersion);
  });

  it('mirrors the deletion service level', () => {
    expect({
      acknowledgeBusinessDays: DELETION_SLA.acknowledgeBusinessDays,
      executeDays: DELETION_SLA.executeDays,
      executeDaysWithHold: DELETION_SLA.executeDaysWithHold,
      coolingOffDays: DELETION_SLA.coolingOffDays,
      challengeTtlSeconds: DELETION_SLA.challengeTtlSeconds,
    }).toEqual({
      acknowledgeBusinessDays: schedule.deletionServiceLevel.acknowledgeBusinessDays,
      executeDays: schedule.deletionServiceLevel.executeDays,
      executeDaysWithHold: schedule.deletionServiceLevel.executeDaysWithHold,
      coolingOffDays: schedule.deletionServiceLevel.coolingOffDays,
      challengeTtlSeconds: schedule.deletionServiceLevel.challengeTtlSeconds,
    });
    expect(DELETION_SLA.proofPurpose).toBe(schedule.deletionServiceLevel.proofPurpose);
  });

  it('mirrors every category with its window, method and PII classification', () => {
    expect(RETENTION_CATEGORIES.map((category) => category.id)).toEqual(
      schedule.categories.map((category) => category.id),
    );
    for (const json of schedule.categories) {
      const mirror = RETENTION_CATEGORIES.find((category) => category.id === json.id);
      expect(mirror).toMatchObject({
        storage: json.storage,
        windowDays: json.windowDays,
        windowFrom: json.windowFrom,
        method: json.method,
        containsPersonalData: json.containsPersonalData,
        holdable: json.holdable,
      });
    }
  });

  it('mirrors every hold with its bound', () => {
    expect(RETENTION_HOLDS).toEqual(schedule.holds);
  });

  it('mirrors the stable error codes and HTTP statuses', () => {
    expect(RETENTION_ERROR_HTTP).toEqual(schedule.errorCodes);
    for (const code of Object.values(RetentionErrorCode)) {
      expect(schedule.errorCodes[code]).toBeDefined();
    }
  });
});

describe('retention planning helpers', () => {
  const now = Date.parse('2026-09-25T00:00:00.000Z');
  const category = { windowDays: 30 } as const;
  const indefinite = { windowDays: INDEFINITE_RETENTION } as const;

  it('treats a record exactly at the window boundary as due (inclusive)', () => {
    const start = new Date(now - 30 * 86_400_000).toISOString();
    expect(dueAtFor(category, start, now)).toBe(new Date(now).toISOString());
    expect(isDue(category, start, now)).toBe(true);
  });

  it('returns null while the window is still open', () => {
    const start = new Date(now - 29 * 86_400_000 - 1000).toISOString();
    expect(dueAtFor(category, start, now)).toBeNull();
    expect(isDue(category, start, now)).toBe(false);
  });

  it('never reports indefinite categories as due', () => {
    const start = new Date(now - 10 * 365 * 86_400_000).toISOString();
    expect(dueAtFor(indefinite, start, now)).toBeNull();
    expect(isDue(indefinite, start, now)).toBe(false);
  });

  it('keeps the configured method when no hold applies', () => {
    const result = effectiveMethodFor({ method: 'hard_delete', holdable: false }, []);
    expect(result).toEqual({ method: 'hard_delete', retained: false, holds: [] });
  });

  it('degrades hard_delete to pseudonymize on a holdable category (invariants survive)', () => {
    const result = effectiveMethodFor(
      { method: 'hard_delete', holdable: true },
      ['legal_obligation'],
    );
    expect(result.method).toBe('pseudonymize');
    expect(result.retained).toBe(false);
    expect(result.holds).toEqual(['legal_obligation']);
  });

  it('blocks deletion entirely for a non-holdable category under a hold', () => {
    const result = effectiveMethodFor(
      { method: 'hard_delete', holdable: false },
      ['security_incident_active'],
    );
    expect(result).toEqual({
      method: 'retain',
      retained: true,
      holds: ['security_incident_active'],
    });
  });

  it('computes SLA dates from the published windows', () => {
    const createdAt = new Date(now);
    const sla = deletionSlaFor(createdAt);
    expect(sla.coolingOffEndsAt).toBe(new Date(now + 7 * 86_400_000).toISOString());
    expect(sla.executeBy).toBe(new Date(now + 30 * 86_400_000).toISOString());
    expect(sla.executeByWithHold).toBe(new Date(now + 45 * 86_400_000).toISOString());
    expect(sla.challengeTtlSeconds).toBe(900);
    expect(sla.proofPurpose).toBe('quickex.data-deletion');
  });
});
