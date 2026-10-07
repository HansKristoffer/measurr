import { describe, expect, test } from 'bun:test'
import { previousPeriod, resolvePeriod, startOfLocalDay } from './period.js'

// A Wednesday, 10:00 UTC.
const NOW = new Date('2026-10-07T10:00:00Z')

describe('periods', () => {
	test('last N days ends today, inclusive', () => {
		const period = resolvePeriod({ last: { days: 30 } }, 'UTC', NOW)
		expect([period.from, period.to, period.days]).toEqual([
			'2026-09-08',
			'2026-10-07',
			30
		])
	})

	test('today depends on the timezone', () => {
		// 12:00 UTC is already 01:00 on the 8th in Auckland (UTC+13).
		const noon = new Date('2026-10-07T12:00:00Z')
		expect(
			resolvePeriod({ preset: 'today' }, 'Pacific/Auckland', noon).from
		).toBe('2026-10-08')
		expect(
			resolvePeriod({ preset: 'today' }, 'America/Los_Angeles', noon).from
		).toBe('2026-10-07')
	})

	test('presets', () => {
		const days = (preset: Parameters<typeof resolvePeriod>[0]) => {
			const period = resolvePeriod(preset, 'UTC', NOW)
			return [period.from, period.to]
		}
		expect(days({ preset: 'yesterday' })).toEqual(['2026-10-06', '2026-10-06'])
		expect(days({ preset: 'thisWeek' })).toEqual(['2026-10-05', '2026-10-07'])
		expect(days({ preset: 'lastWeek' })).toEqual(['2026-09-28', '2026-10-04'])
		expect(days({ preset: 'thisMonth' })).toEqual(['2026-10-01', '2026-10-07'])
		expect(days({ preset: 'lastMonth' })).toEqual(['2026-09-01', '2026-09-30'])
		expect(days({ preset: 'thisYear' })).toEqual(['2026-01-01', '2026-10-07'])
	})

	test('local midnight follows daylight saving time', () => {
		expect(
			startOfLocalDay('2026-07-01', 'Europe/Copenhagen').toISOString()
		).toBe('2026-06-30T22:00:00.000Z')
		expect(
			startOfLocalDay('2026-12-01', 'Europe/Copenhagen').toISOString()
		).toBe('2026-11-30T23:00:00.000Z')
		// The day DST ends is 25 hours long.
		const period = resolvePeriod(
			{ from: '2026-10-25', to: '2026-10-25' },
			'Europe/Copenhagen',
			NOW
		)
		expect(period.end.getTime() - period.start.getTime()).toBe(25 * 3_600_000)
	})

	test('the previous period has the same length and ends the day before', () => {
		const period = resolvePeriod(
			{ from: '2026-09-01', to: '2026-09-30' },
			'UTC',
			NOW
		)
		const previous = previousPeriod(period)
		expect([previous.from, previous.to, previous.days]).toEqual([
			'2026-08-02',
			'2026-08-31',
			30
		])
	})

	test('periods longer than two years and reversed periods are rejected', () => {
		expect(() =>
			resolvePeriod({ from: '2023-01-01', to: '2026-01-01' }, 'UTC', NOW)
		).toThrow(/at most 731 days/)
		expect(() =>
			resolvePeriod({ from: '2026-02-01', to: '2026-01-01' }, 'UTC', NOW)
		).toThrow(/starts/)
	})
})
