/**
 * The ClickHouse dialect: compiled statements, and the sprays fixture against a real
 * ClickHouse when ANALYTICS_TEST_CLICKHOUSE_URL is set (it creates and drops its own tables):
 *
 *   ANALYTICS_TEST_CLICKHOUSE_URL=http://user:password@localhost:8123 bun test
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import {
	type AnalyticsSource,
	type CompiledStatement,
	createAnalytics,
	type ResultPeriod
} from './index.js'
import { clickhouseDialect, toQueryParams } from './dialects/clickhouse.js'
import { orders } from './fixtures/orders.js'
import { sprays } from './fixtures/sprays.js'
import { assertDatasetContract } from './testing.js'

const NOW = new Date('2026-10-07T10:00:00Z')

/** Days in a period, both ends included; null for all time. */
const daysIn = (period: ResultPeriod) =>
	'all' in period
		? null
		: (Date.parse(period.to) - Date.parse(period.from)) / 86_400_000 + 1

function analyticsOn(source: AnalyticsSource, timezone = 'UTC') {
	return createAnalytics({
		datasets: [sprays],
		sources: { main: source },
		tenant: (ctx: { tenantId: string }) => ctx.tenantId,
		timezone: () => timezone,
		now: () => NOW,
		resolvers: {
			sprays: {
				spraysPerDay: ({ rows, totals, period }) => {
					const days = daysIn(period)
					const perDay = (value: number | null) =>
						value === null || days === null ? null : value / days
					return {
						rows: rows.map(({ values }) => perDay(values.sprays)),
						totals: perDay(totals.sprays)
					}
				}
			}
		}
	})
}

const render = (statements: CompiledStatement[]) =>
	statements
		.map(
			(statement) =>
				`${statement.text}\n-- values: ${JSON.stringify(statement.values)}`
		)
		.join('\n\n')

describe('clickhouse compiler', () => {
	const analytics = analyticsOn(
		{ dialect: clickhouseDialect(), execute: async () => [] },
		'Europe/Copenhagen'
	)
	const ctx = { tenantId: 'A' }

	test('measures over a period', async () => {
		expect(
			render(
				await analytics.explain(
					{
						dataset: 'sprays',
						measures: ['sprays', 'units', 'medianBattery', 'lowLiquidShare'],
						period: { last: { days: 30 } }
					},
					ctx
				)
			)
		).toMatchSnapshot()
	})

	test('grouped by placement and week, filtered by unit and battery', async () => {
		expect(
			render(
				await analytics.explain(
					{
						dataset: 'sprays',
						measures: ['sprays', 'spraysPerUnit', 'averageBattery'],
						groupBy: ['week', 'placement'],
						filters: [
							{ dimension: 'unit', op: 'notIn', values: ['u9'] },
							{ dimension: 'battery', op: 'between', from: 10, to: 90 }
						],
						period: { preset: 'lastMonth' }
					},
					ctx
				)
			)
		).toMatchSnapshot()
	})

	test('weekday and hour', async () => {
		expect(
			render(
				await analytics.explain(
					{
						dataset: 'sprays',
						measures: ['sprays'],
						groupBy: ['weekday', 'hour'],
						filters: [{ dimension: 'placement', op: 'in', values: ['OFFICE'] }]
					},
					ctx
				)
			)
		).toMatchSnapshot()
	})

	test('parameters are typed for the ClickHouse client', async () => {
		const [statement] = await analytics.explain(
			{
				dataset: 'sprays',
				measures: ['reports'],
				period: { last: { days: 1 } }
			},
			ctx
		)
		if (!statement) throw new Error('No statement')

		expect(statement.text).toContain('{p1:String}')
		expect(statement.text).toContain("{p2:DateTime64(3, 'UTC')}")
		expect(toQueryParams(statement)).toEqual({
			p1: 'A',
			p2: '2026-10-06 22:00:00.000',
			p3: '2026-10-07 22:00:00.000'
		})
	})

	test('a dataset needing correlated subqueries fails at startup', () => {
		expect(() =>
			createAnalytics({
				datasets: [orders],
				sources: {
					main: { dialect: clickhouseDialect(), execute: async () => [] }
				},
				tenant: () => 'A'
			})
		).toThrow('ClickHouse cannot run the correlated EXISTS')
	})
})

const url = process.env.ANALYTICS_TEST_CLICKHOUSE_URL

describe.skipIf(!url)('clickhouse integration', () => {
	const endpoint = new URL(url ?? 'http://localhost:8123')
	const authorization = `Basic ${btoa(`${decodeURIComponent(endpoint.username)}:${decodeURIComponent(endpoint.password)}`)}`
	endpoint.username = ''
	endpoint.password = ''

	const send = async (query: string, params: Record<string, unknown> = {}) => {
		const search = new URLSearchParams({ default_format: 'JSONEachRow' })
		for (const [key, value] of Object.entries(params)) {
			search.set(`param_${key}`, value === null ? '\\N' : String(value))
		}
		const response = await fetch(`${endpoint.origin}/?${search}`, {
			method: 'POST',
			headers: { authorization },
			body: query
		})
		const text = await response.text()
		if (!response.ok) throw new Error(text)

		return text
			.split('\n')
			.filter((line) => line.trim() !== '')
			.map((line) => JSON.parse(line) as Record<string, unknown>)
	}

	const source: AnalyticsSource = {
		dialect: clickhouseDialect(),
		execute: (statement) => send(statement.text, toQueryParams(statement))
	}
	const analytics = analyticsOn(source)
	const tenantA = { tenantId: 'A' }

	beforeAll(async () => {
		await send('DROP TABLE IF EXISTS statuses')
		await send('DROP TABLE IF EXISTS units')
		await send(
			'CREATE TABLE statuses (unitId String, createdAt DateTime, sprays UInt32, batteryLevel UInt8, liquidLow UInt8) ENGINE = MergeTree ORDER BY (unitId, createdAt)'
		)
		await send(
			'CREATE TABLE units (unitId String, organizationId Nullable(String), placementType Nullable(String), name String) ENGINE = MergeTree ORDER BY unitId'
		)
		await send(
			"INSERT INTO units VALUES ('u1', 'A', 'OFFICE', 'Front desk'), ('u2', 'A', NULL, 'Back room'), ('u3', 'B', 'TOILET', 'Toilet')"
		)
		// UTC. 11:30 on 1 October is 00:30 on 2 October in Auckland.
		await send(`INSERT INTO statuses VALUES
			('u1', '2026-10-01 11:30:00', 10, 80, 0),
			('u1', '2026-10-02 08:00:00', 5, 70, 1),
			('u2', '2026-10-03 23:30:00', 7, 50, 0),
			('u2', '2026-09-20 12:00:00', 3, 40, 1),
			('u3', '2026-10-02 08:00:00', 100, 90, 0),
			('u9', '2026-10-02 08:00:00', 1, 10, 0)`)
	})

	afterAll(async () => {
		await send('DROP TABLE IF EXISTS statuses')
		await send('DROP TABLE IF EXISTS units')
	})

	test('totals are the tenant’s rows only', async () => {
		const result = await analytics.query(
			{
				dataset: 'sprays',
				measures: ['sprays', 'units', 'medianBattery', 'lowLiquidShare']
			},
			tenantA
		)

		// Ratios are branded numbers; compare them as plain numbers.
		expect(result.totals as Record<string, unknown>).toEqual({
			sprays: 25,
			units: 2,
			medianBattery: 60,
			lowLiquidShare: 0.5
		})
	})

	test('a unit without a placement groups as empty, not as an empty string', async () => {
		const result = await analytics.query(
			{ dataset: 'sprays', measures: ['sprays'], groupBy: ['placement'] },
			tenantA
		)

		expect(result.rows).toEqual([
			{ placement: { key: 'OFFICE', label: 'Office' }, sprays: 15 },
			{ placement: { key: null, label: 'No placement' }, sprays: 10 }
		])
	})

	test('an empty group is null, not zero or NaN', async () => {
		const result = await analytics.query(
			{
				dataset: 'sprays',
				measures: ['sprays', 'averageBattery', 'reports'],
				period: { from: '2026-01-01', to: '2026-01-31' }
			},
			tenantA
		)

		expect(result.totals).toEqual({
			sprays: null,
			averageBattery: null,
			reports: 0
		})
	})

	test('day buckets follow the tenant timezone', async () => {
		const result = await analyticsOn(source, 'Pacific/Auckland').query(
			{
				dataset: 'sprays',
				measures: ['sprays'],
				groupBy: ['day'],
				period: { from: '2026-10-01', to: '2026-10-05' }
			},
			tenantA
		)

		expect(result.rows.map((row) => [row.day.key, row.sprays])).toEqual([
			['2026-10-02', 15],
			['2026-10-04', 7]
		])
	})

	test('a resolved measure divides by the days of each period', async () => {
		const result = await analytics.query(
			{
				dataset: 'sprays',
				measures: ['spraysPerDay'],
				period: { from: '2026-10-01', to: '2026-10-05' },
				compareToPrevious: true
			},
			tenantA
		)

		expect(result.totals).toEqual({ spraysPerDay: 22 / 5 })
		expect(result.previous?.totals).toEqual({ spraysPerDay: null })
	})

	test('the dataset contract holds', async () => {
		await assertDatasetContract({
			dataset: sprays,
			source,
			tenant: 'A',
			now: () => NOW
		})
	})
})
