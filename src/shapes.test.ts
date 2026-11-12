import { describe, expect, test } from 'bun:test'
import type { Row } from './analytics.js'
import { postgresDialect } from './dialects/postgres.js'
import { orders } from './fixtures/orders.js'
import { createAnalytics } from './index.js'
import { bucketStarts } from './period.js'
import {
	isKpi,
	isTimeSeries,
	OUTPUT_KINDS,
	pickRenderer,
	presentDistribution,
	presentPivot,
	presentTable,
	presentKpi,
	presentLeaderboard,
	presentTimeseries,
	toDistribution,
	toKpi,
	toLeaderboard,
	toPivot,
	toTimeseries
} from './shapes.js'

/** Rows for the current or the previous period, grouped or as totals. */
type Answer = {
	/** Answers a grouped statement with one more day row than this, so it is truncated. */
	limit?: number
	rows?: Row[]
	totals?: Row
	previousRows?: Row[]
	previousTotals?: Row
}

function analyticsAnswering(answer: Answer) {
	return createAnalytics({
		datasets: [orders],
		sources: {
			main: {
				dialect: postgresDialect(),
				execute: async ({ text, values }) => {
					// The previous period of a period starting 2026-10-01 ends there.
					const previous = values.at(-1) === '2026-10-01T00:00:00.000Z'
					const grouped = text.includes('"g_')
					if (grouped && answer.limit)
						return Array.from({ length: answer.limit + 1 }, (_, day) => ({
							g_day: bucketStarts('2026-10-01', '2026-12-31', 'day')[day],
							m_orders: 1
						}))
					if (grouped)
						return (previous ? answer.previousRows : answer.rows) ?? []
					const totals = previous ? answer.previousTotals : answer.totals
					return totals ? [totals] : []
				}
			}
		},
		tenant: () => 't1'
	})
}

const week = { from: '2026-10-01', to: '2026-10-07' }

describe('toKpi', () => {
	test('the total, with the change against the previous period', async () => {
		const result = await analyticsAnswering({
			totals: { m_orders: 12 },
			previousTotals: { m_orders: 8 }
		}).query(
			{
				dataset: 'orders',
				measures: ['orders'],
				period: week,
				compareToPrevious: true
			},
			{}
		)

		expect(toKpi(result, 'orders')).toEqual({
			kind: 'kpi',
			value: 12,
			previous: 8,
			change: 0.5
		})
	})

	test('no change without a previous value to compare with', async () => {
		const analytics = analyticsAnswering({
			totals: { m_orders: 3 },
			previousTotals: { m_orders: 0 }
		})

		const compared = await analytics.query(
			{
				dataset: 'orders',
				measures: ['orders'],
				period: week,
				compareToPrevious: true
			},
			{}
		)
		const alone = await analytics.query(
			{ dataset: 'orders', measures: ['orders'], period: week },
			{}
		)

		expect(toKpi(compared, 'orders').change).toBeNull()
		expect(toKpi(alone, 'orders')).toEqual({ kind: 'kpi', value: 3 })
	})
})

describe('toTimeseries', () => {
	test('one series per value, every day of the period filled', async () => {
		const result = await analyticsAnswering({
			rows: [
				{ g_day: '2026-10-01', g_status: 'PAID', m_orders: 2 },
				{ g_day: '2026-10-03', g_status: 'PAID', m_orders: 1 },
				{ g_day: '2026-10-03', g_status: 'OPEN', m_orders: 4 }
			],
			totals: { m_orders: 7 }
		}).query(
			{
				dataset: 'orders',
				measures: ['orders'],
				groupBy: ['day', 'status'],
				period: { from: '2026-10-01', to: '2026-10-03' },
				limit: 100
			},
			{}
		)

		expect(
			toTimeseries(result, {
				bucket: 'day',
				unit: 'day',
				measure: 'orders',
				series: 'status'
			})
		).toEqual({
			kind: 'timeseries',
			unit: 'day',
			series: [
				{
					key: 'PAID',
					label: 'Paid',
					points: [
						{ bucket: '2026-10-01', value: 2 },
						{ bucket: '2026-10-02', value: 0 },
						{ bucket: '2026-10-03', value: 1 }
					]
				},
				{
					key: 'OPEN',
					label: 'Open',
					points: [
						{ bucket: '2026-10-01', value: 0 },
						{ bucket: '2026-10-02', value: 0 },
						{ bucket: '2026-10-03', value: 4 }
					]
				}
			],
			truncated: false
		})
	})

	test('the previous period on its own buckets, and a fill for averages', async () => {
		const result = await analyticsAnswering({
			rows: [{ g_day: '2026-10-02', m_averageAmount: 50 }],
			totals: { m_averageAmount: 50 },
			previousRows: [{ g_day: '2026-09-24', m_averageAmount: 40 }],
			previousTotals: { m_averageAmount: 40 }
		}).query(
			{
				dataset: 'orders',
				measures: ['averageAmount'],
				groupBy: ['day'],
				period: week,
				compareToPrevious: true
			},
			{}
		)

		const [series] = toTimeseries(result, {
			bucket: 'day',
			unit: 'day',
			measure: 'averageAmount',
			fill: null
		}).series

		expect(series?.points).toHaveLength(7)
		expect(series?.points[1]).toEqual({ bucket: '2026-10-02', value: 50 })
		expect(series?.points[0]?.value).toBeNull()
		expect(series?.previous?.[0]).toEqual({ bucket: '2026-09-24', value: 40 })
		expect(series?.previous).toHaveLength(7)
	})

	test('an all-time series has only the buckets it found, in order', async () => {
		const result = await analyticsAnswering({
			rows: [
				{ g_month: '2026-03-01', m_orders: 2 },
				{ g_month: '2026-01-01', m_orders: 1 }
			],
			totals: { m_orders: 3 }
		}).query(
			{
				dataset: 'orders',
				measures: ['orders'],
				groupBy: ['month'],
				period: { all: true }
			},
			{}
		)

		expect(
			toTimeseries(result, {
				bucket: 'month',
				unit: 'month',
				measure: 'orders'
			}).series[0]?.points
		).toEqual([
			{ bucket: '2026-01-01', value: 1 },
			{ bucket: '2026-03-01', value: 2 }
		])
	})
})

describe('bucketStarts', () => {
	test('weeks start on Monday and months on the first', () => {
		expect(bucketStarts('2026-10-01', '2026-10-14', 'week')).toEqual([
			'2026-09-28',
			'2026-10-05',
			'2026-10-12'
		])
		expect(bucketStarts('2026-11-15', '2027-01-02', 'month')).toEqual([
			'2026-11-01',
			'2026-12-01',
			'2027-01-01'
		])
	})
})

describe('toDistribution', () => {
	test('shares of the total, with each segment’s previous value', async () => {
		const result = await analyticsAnswering({
			rows: [
				{ g_tag: 't1', g_tag__label: 'Complaint', m_orders: 6 },
				{ g_tag: 't2', g_tag__label: 'Praise', m_orders: 4 }
			],
			totals: { m_orders: 8 },
			previousRows: [{ g_tag: 't1', g_tag__label: 'Complaint', m_orders: 3 }],
			previousTotals: { m_orders: 3 }
		}).query(
			{
				dataset: 'orders',
				measures: ['orders'],
				groupBy: ['tag'],
				period: week,
				compareToPrevious: true
			},
			{}
		)

		expect(toDistribution(result, { by: 'tag', measure: 'orders' })).toEqual({
			kind: 'distribution',
			// Orders with two tags count once in the total, so shares add up to more than 1.
			total: 8,
			segments: [
				{ key: 't1', label: 'Complaint', value: 6, share: 0.75, previous: 3 },
				{ key: 't2', label: 'Praise', value: 4, share: 0.5, previous: null }
			],
			truncated: false
		})
	})
})

describe('toPivot', () => {
	test('a grid with numeric keys sorted and missing cells filled', async () => {
		const result = await analyticsAnswering({
			rows: [
				{ g_weekday: 2, g_hour: 9, m_orders: 5 },
				{ g_weekday: 1, g_hour: 14, m_orders: 3 },
				{ g_weekday: 1, g_hour: 9, m_orders: 1 }
			],
			totals: { m_orders: 9 }
		}).query(
			{ dataset: 'orders', measures: ['orders'], groupBy: ['weekday', 'hour'] },
			{}
		)

		expect(
			toPivot(result, { rows: 'weekday', columns: 'hour', measure: 'orders' })
		).toEqual({
			kind: 'pivot',
			rows: [
				{ key: 1, label: 'Monday' },
				{ key: 2, label: 'Tuesday' }
			],
			columns: [
				{ key: 9, label: '09:00' },
				{ key: 14, label: '14:00' }
			],
			values: [
				[1, 3],
				[5, 0]
			],
			total: 9,
			truncated: false
		})
	})
})

describe('toLeaderboard', () => {
	test('ranks the rows in query order with every asked measure', async () => {
		const result = await analyticsAnswering({
			rows: [
				{
					g_region: 'r1',
					g_region__label: 'North',
					m_orders: 9,
					m_revenue: 900
				},
				{ g_region: null, g_region__label: null, m_orders: 2, m_revenue: null }
			],
			totals: { m_orders: 11, m_revenue: 900 }
		}).query(
			{
				dataset: 'orders',
				measures: ['orders', 'revenue'],
				groupBy: ['region']
			},
			{}
		)

		expect(
			toLeaderboard(result, { by: 'region', measure: 'orders' }).items
		).toEqual([
			{
				key: 'r1',
				label: 'North',
				rank: 1,
				value: 9,
				values: { orders: 9, revenue: 900 }
			},
			{
				key: null,
				label: 'No region',
				rank: 2,
				value: 2,
				values: { orders: 2, revenue: null }
			}
		])
	})
})

test('a dimension the query did not group by is an error', async () => {
	const result = await analyticsAnswering({
		rows: [{ g_status: 'PAID', m_orders: 1 }]
	}).query({ dataset: 'orders', measures: ['orders'], groupBy: ['status'] }, {})

	expect(() =>
		toDistribution(result, { by: 'region' as never, measure: 'orders' })
	).toThrow('not grouped by region')
})

describe('presentation', () => {
	test('a KPI is 0 when missing, and a share is a percentage', async () => {
		const result = await analyticsAnswering({
			totals: { m_paidShare: 0.25, m_averageAmount: null }
		}).query(
			{
				dataset: 'orders',
				measures: ['paidShare', 'averageAmount'],
				period: week
			},
			{}
		)

		expect(
			presentKpi(result, 'paidShare', { label: 'Paid', percent: true })
		).toEqual({ kind: 'kpi', value: 25, unit: 'PERCENTAGE', label: 'Paid' })
		const average = presentKpi(result, 'averageAmount', { suffix: 'kr' })
		expect(average).toEqual({ kind: 'kpi', value: 0, suffix: 'kr' })
		expect(isKpi(average)).toBe(true)
		expect(isTimeSeries(average)).toBe(false)
	})

	test('a series has wire keys, labels, dates and 0 for empty buckets', async () => {
		const result = await analyticsAnswering({
			rows: [
				{ g_day: '2026-10-01', g_status: 'PAID', m_orders: 2 },
				{ g_day: '2026-10-02', g_status: 'OPEN', m_orders: 1 }
			],
			totals: { m_orders: 3 }
		}).query(
			{
				dataset: 'orders',
				measures: ['orders'],
				groupBy: ['day', 'status'],
				period: { from: '2026-10-01', to: '2026-10-02' },
				limit: 100
			},
			{}
		)

		expect(
			presentTimeseries(result, {
				bucket: 'day',
				measure: 'orders',
				series: 'status',
				keys: { PAID: 'paid' },
				labels: { paid: 'Settled' },
				chartType: 'line'
			})
		).toEqual({
			kind: 'timeseries',
			granularity: 'day',
			series: [
				{
					key: 'paid',
					label: 'Settled',
					points: [
						{
							ts: new Date('2026-10-01T00:00:00.000Z'),
							bucket: '2026-10-01',
							value: 2
						},
						{
							ts: new Date('2026-10-02T00:00:00.000Z'),
							bucket: '2026-10-02',
							value: 0
						}
					],
					chartType: 'line'
				},
				{
					key: 'OPEN',
					label: 'Open',
					points: [
						{
							ts: new Date('2026-10-01T00:00:00.000Z'),
							bucket: '2026-10-01',
							value: 0
						},
						{
							ts: new Date('2026-10-02T00:00:00.000Z'),
							bucket: '2026-10-02',
							value: 1
						}
					],
					chartType: 'line'
				}
			]
		})
	})

	test('segments add up to their own total, in the given order', async () => {
		// Many-to-many: 7 orders, but tags count 6 + 4 + 2.
		const result = await analyticsAnswering({
			rows: [
				{ g_tag: 't1', g_tag__label: 'Complaint', m_orders: 6 },
				{ g_tag: null, g_tag__label: null, m_orders: 2 },
				{ g_tag: 't2', g_tag__label: 'Praise', m_orders: 4 }
			],
			totals: { m_orders: 7 }
		}).query(
			{
				dataset: 'orders',
				measures: ['orders'],
				groupBy: ['tag'],
				period: week
			},
			{}
		)

		expect(
			presentDistribution(result, {
				by: 'tag',
				measure: 'orders',
				chartType: 'bar',
				keys: { null: 'untagged' },
				labels: { untagged: 'Not tagged' },
				order: ['t2', 't1']
			})
		).toEqual({
			kind: 'distribution',
			total: 12,
			segments: [
				{ key: 't2', label: 'Praise', value: 4, percent: (4 / 12) * 100 },
				{ key: 't1', label: 'Complaint', value: 6, percent: 50 },
				{
					key: 'untagged',
					label: 'Not tagged',
					value: 2,
					percent: (2 / 12) * 100
				}
			],
			chartType: 'bar'
		})
	})

	test('leaderboard rows carry string ids and meta from every measure', async () => {
		const result = await analyticsAnswering({
			rows: [
				{
					g_region: 'r1',
					g_region__label: 'North',
					m_orders: 9,
					m_revenue: 900
				},
				{
					g_region: null,
					g_region__label: null,
					m_orders: null,
					m_revenue: null
				}
			],
			totals: { m_orders: 9, m_revenue: 900 }
		}).query(
			{
				dataset: 'orders',
				measures: ['orders', 'revenue'],
				groupBy: ['region']
			},
			{}
		)

		expect(
			presentLeaderboard(result, {
				by: 'region',
				measure: 'orders',
				meta: (values) => ({ revenue: values.revenue ?? null })
			})
		).toEqual({
			kind: 'leaderboard',
			items: [
				{ rank: 1, id: 'r1', label: 'North', value: 9, meta: { revenue: 900 } },
				{
					rank: 2,
					id: 'null',
					label: 'No region',
					value: 0,
					meta: { revenue: null }
				}
			]
		})
	})
})

describe('zero-filled and truncated outputs', () => {
	test('an ungrouped series exists for a period without rows', async () => {
		const result = await analyticsAnswering({ rows: [] }).query(
			{
				dataset: 'orders',
				measures: ['orders'],
				groupBy: ['day'],
				period: week
			},
			{}
		)

		const output = presentTimeseries(result, {
			bucket: 'day',
			measure: 'orders'
		})

		expect(output.series).toHaveLength(1)
		expect(output.series[0]?.points.map((point) => point.value)).toEqual([
			0, 0, 0, 0, 0, 0, 0
		])
	})

	test('seriesKeys and segmentKeys add zero lanes for keys without rows', async () => {
		const result = await analyticsAnswering({
			rows: [{ g_day: '2026-10-01', g_status: 'PAID', m_orders: 2 }],
			totals: { m_orders: 2 }
		}).query(
			{
				dataset: 'orders',
				measures: ['orders'],
				groupBy: ['day', 'status'],
				period: { from: '2026-10-01', to: '2026-10-02' },
				limit: 100
			},
			{}
		)

		const all = presentTimeseries(result, {
			bucket: 'day',
			measure: 'orders',
			series: 'status',
			seriesKeys: 'all'
		})
		expect(all.series.map((series) => [series.key, series.label])).toEqual([
			['OPEN', 'Open'],
			['PAID', 'Paid'],
			['REFUNDED', 'Refunded']
		])
		expect(all.series[0]?.points.map((point) => point.value)).toEqual([0, 0])

		const listed = presentTimeseries(result, {
			bucket: 'day',
			measure: 'orders',
			series: 'status',
			seriesKeys: ['REFUNDED']
		})
		expect(listed.series.map((series) => series.key)).toEqual([
			'REFUNDED',
			'PAID'
		])

		const segments = presentDistribution(result, {
			by: 'status',
			measure: 'orders',
			segmentKeys: 'all'
		}).segments
		expect(segments.map((segment) => [segment.key, segment.value])).toEqual([
			['OPEN', 0],
			['PAID', 2],
			['REFUNDED', 0]
		])
	})

	test("'all' needs a closed dimension", async () => {
		const result = await analyticsAnswering({ rows: [] }).query(
			{ dataset: 'orders', measures: ['orders'], groupBy: ['region'] },
			{}
		)

		expect(() =>
			presentDistribution(result, {
				by: 'region',
				measure: 'orders',
				segmentKeys: 'all'
			})
		).toThrow('closed values of region')
	})

	test('a truncated result says so in its output', async () => {
		const result = await analyticsAnswering({ limit: 20 }).query(
			{
				dataset: 'orders',
				measures: ['orders'],
				groupBy: ['day'],
				period: { from: '2026-10-01', to: '2026-12-31' }
			},
			{}
		)

		expect(result.truncated).toBe(true)
		expect(
			presentTimeseries(result, { bucket: 'day', measure: 'orders' }).truncated
		).toBe(true)
		expect(
			presentDistribution(result, { by: 'day', measure: 'orders' })
		).toMatchObject({ truncated: true })
		expect(
			presentLeaderboard(result, { by: 'day', measure: 'orders' }).truncated
		).toBe(true)
	})

	test('the presenters draw a result without totals', async () => {
		const result = await analyticsAnswering({
			rows: [
				{ g_status: 'PAID', m_orders: 2, m_revenue: 50 },
				{ g_status: 'OPEN', m_orders: 1, m_revenue: 10 }
			]
		}).query(
			{
				dataset: 'orders',
				measures: ['orders', 'revenue'],
				groupBy: ['status'],
				totals: false
			},
			{}
		)

		expect(
			presentDistribution(result, { by: 'status', measure: 'orders' }).total
		).toBe(3)
		expect(
			presentLeaderboard(result, {
				by: 'status',
				measure: 'orders',
				meta: (values) => ({ revenue: values.revenue ?? 0 })
			}).items[0]
		).toEqual({
			rank: 1,
			id: 'PAID',
			label: 'Paid',
			value: 2,
			meta: { revenue: 50 }
		})
		expect(
			toDistribution(result, { by: 'status', measure: 'orders' }).total
		).toBeNull()
	})
})

describe('pivot and table presenters', () => {
	const grid = () =>
		analyticsAnswering({
			rows: [
				{ g_weekday: 1, g_hour: 9, m_orders: 2, m_revenue: 20 },
				{ g_weekday: 2, g_hour: 10, m_orders: 3, m_revenue: 30 },
				{ g_weekday: 1, g_hour: 10, m_orders: 1, m_revenue: 5 }
			],
			totals: { m_orders: 6, m_revenue: 55 }
		}).query(
			{
				dataset: 'orders',
				measures: ['orders', 'revenue'],
				groupBy: ['weekday', 'hour'],
				period: week
			},
			{}
		)

	test('presentPivot draws a grid by label, with sums when asked', async () => {
		expect(
			presentPivot(await grid(), {
				rows: 'weekday',
				columns: 'hour',
				measure: 'orders',
				totals: true
			})
		).toEqual({
			kind: 'pivot',
			rowDimension: { key: 'weekday', label: 'Weekday' },
			columnDimension: { key: 'hour', label: 'Hour' },
			rows: ['Monday', 'Tuesday'],
			columns: ['09:00', '10:00'],
			values: [
				[2, 1],
				[0, 3]
			],
			totals: { rowTotals: [3, 3], columnTotals: [2, 4], grandTotal: 6 }
		})
	})

	test('presentTable has a column per grouped dimension and measure', async () => {
		const table = presentTable(await grid(), {
			columns: ['weekday', 'orders'],
			labels: { orders: 'Count' }
		})

		expect(table).toEqual({
			kind: 'table',
			columns: [
				{ key: 'weekday', label: 'Weekday', type: 'number' },
				{ key: 'orders', label: 'Count', type: 'number', nullable: false }
			],
			rows: [
				{ weekday: 1, orders: 2 },
				{ weekday: 2, orders: 3 },
				{ weekday: 1, orders: 1 }
			]
		})
		expect(
			presentTable(await grid()).columns.map((column) => column.key)
		).toEqual(['weekday', 'hour', 'orders', 'revenue'])
	})
})

test('pickRenderer covers every kind and falls back for an unknown one', () => {
	const map = Object.fromEntries(
		OUTPUT_KINDS.map((kind) => [kind, kind])
	) as Record<(typeof OUTPUT_KINDS)[number], string>

	expect(pickRenderer(map, { kind: 'pivot' }, 'none')).toBe('pivot')
	expect(pickRenderer(map, { kind: 'gauge' }, 'none')).toBe('none')
	expect(pickRenderer(map, { kind: 'toString' }, 'none')).toBe('none')
})
