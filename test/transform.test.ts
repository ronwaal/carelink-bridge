import { describe, it, expect } from 'vitest';
import { data, makeSG } from './fixtures.js';
import { transform } from '../src/transform/index.js';

describe('transform()', () => {
  it('should obey sgvLimit', () => {
    const d = data();
    expect(transform(d).entries).toHaveLength(d.sgs.length);
    expect(transform(d, 4).entries).toHaveLength(4);
  });

  it('should include pump device family', () => {
    const result = transform(data({ medicalDeviceFamily: 'foo' }));
    expect(result.entries[0].device).toBe('connect-foo');
  });

  it('should use Care Partner timestamp when datetime is absent', () => {
    const result = transform(data({
      sMedicalDeviceTime: '',
      sgs: [{
        kind: 'SG',
        version: 1,
        sg: 100,
        timestamp: '2015-10-17T09:05:00',
      }],
    }));

    expect(result.entries).toHaveLength(1);
    expect(Number.isFinite(result.entries[0].date)).toBe(true);
    expect(result.entries[0].dateString).toBe(new Date(result.entries[0].date).toISOString());
  });

  it('should discard data more than 20 minutes old', () => {
    const pumpTimeString = 'Oct 17, 2015 09:06:33';
    const now = Date.parse('Oct 17, 2015 09:09:14');
    const THRESHOLD = 20;
    const boundary = now - THRESHOLD * 60 * 1000;

    expect(
      transform(data({
        sMedicalDeviceTime: pumpTimeString,
        currentServerTime: now,
        lastMedicalDeviceDataUpdateServerTime: boundary,
      })).entries.length,
    ).toBeGreaterThan(0);

    expect(
      transform(data({
        sMedicalDeviceTime: pumpTimeString,
        currentServerTime: now,
        lastMedicalDeviceDataUpdateServerTime: boundary - 1,
      })).entries,
    ).toHaveLength(0);
  });

  describe('active insulin', () => {
    it('should include active insulin', () => {
      const pumpStatus = transform(
        data({
          activeInsulin: {
            datetime: 'Oct 17, 2015 09:09:14',
            version: 1,
            amount: 1.275,
            kind: 'Insulin',
          },
        }),
      ).devicestatus[0];

      expect(pumpStatus.pump?.iob.bolusiob).toBe(1.275);
    });

    it('should ignore activeInsulin values of -1', () => {
      const pumpStatus = transform(
        data({
          activeInsulin: {
            datetime: 'Oct 17, 2015 09:09:14',
            version: 1,
            amount: -1,
            kind: 'Insulin',
          },
        }),
      ).devicestatus[0];

      expect(pumpStatus.pump?.iob.bolusiob).toBeUndefined();
    });
  });

  describe('trend', () => {
    const sgs: [number, string][] = [
      [95, 'Oct 20, 2015 08:05:00'],
      [105, 'Oct 20, 2015 08:10:00'],
      [108, 'Oct 20, 2015 08:15:00'],
    ];

    function transformedSGs(valDatePairs: [number, string?][]) {
      return transform(
        data({
          lastSGTrend: 'UP_DOUBLE',
          sgs: valDatePairs.map(([sg, time]) => makeSG(sg, time)),
        }),
      ).entries;
    }

    it('should add the trend to the last sgv', () => {
      const sgvs = transformedSGs(sgs);
      expect(sgvs).toHaveLength(3);
      expect(sgvs[sgvs.length - 1].sgv).toBe(108);
      expect(sgvs[sgvs.length - 1].direction).toBe('DoubleUp');
      expect(sgvs[sgvs.length - 1].trend).toBe(1);
    });

    it('should not add a trend if the most recent sgv is absent', () => {
      const sgvs = transformedSGs([...sgs, [0, 'Oct 20, 2015 08:20:00']]);
      expect(sgvs).toHaveLength(3);
      expect(sgvs[sgvs.length - 1].sgv).toBe(108);
      expect(sgvs[sgvs.length - 1].direction).toBeUndefined();
      expect(sgvs[sgvs.length - 1].trend).toBeUndefined();
    });
  });

  describe('uploader battery', () => {
    it('should use the Connect battery level as uploader.battery', () => {
      const pumpStatus = transform(data({ conduitBatteryLevel: 76 })).devicestatus[0];
      expect(pumpStatus.uploader.battery).toBe(76);
    });
  });
});
