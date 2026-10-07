import { describe, expect, test } from 'bun:test'
import {
	type AnalyticsQueryEvent,
	AnalyticsResultSchema,
	createAnalytics,
	defineDataset,
	eq,
	measure,
	table
} from './index.js'
import { postgresDialect } from './dialects/postgres.js'
import { type Order, type Refund, orders } from './fixtures/orders.js'
import type { Row } from './analytics.js'

const refund = table<Refund>('refunds')
const refundedOrder = refund.leftJoin(table<Order>('orders'), (o) =>
	eq(o.col('id'), refund.col('orderId'))
)
const refunds = defineDataset({
	key: 'refunds',
	label: 'Refunds',
	description: 'One row per refund.',
	from: refund,
	tenantColumn: refundedOrder.col('tenantId'),
	time: { created: { column: refund.col('createdAt'), label: 'Created' } },
	measures: { refunds: measure.count({ label: 'Refunds' }) },
	dimensions: {}
})

type Ctx = { tenantId: string; canSeeRefunds: boolean; seesNothing?: boolean }
const ctx: Ctx = { tenantId: 't1', canSeeRefunds: false }

/** A Prisma `Decimal` as far as decoding cares. */
const decimal = (value: string) => ({ toNumber: () => Number(value) })

function analyticsWith(input: {
	rows?: Row[]
	onQuery?: (event: AnalyticsQueryEvent, ctx: Ctx) => unknown
}) {
	return createAnalytics({
		datasets: [orders, refunds],
		sources: {
			main: {
				dialect: postgresDialect(),
				execute: async () => input.rows ?? []
			}
		},
		tenant: (ctx: Ctx) => ctx.tenantId,
		authorize: (dataset, ctx) =>
			!ctx.seesNothing && (dataset.key !== 'refunds' || ctx.canSeeRefunds),
		...(input.onQuery && { onQuery: input.onQuery })
	})
}

describe('access-aware catalog', () => {
	const analytics = analyticsWith({})

	test('listDatasets offers only what authorize allows', async () => {
		const keys = async (ctx: Ctx) =>
			(await analytics.listDatasets(ctx)).map((dataset) => dataset.key)

		expect(await keys(ctx)).toEqual(['orders'])
		expect(await keys({ ...ctx, canSeeRefunds: true })).toEqual([
			'orders',
			'refunds'
		])
	})

	test('querySchema({ ctx }) is the memoized schema for the allowed datasets', async () => {
		const schema = await analytics.querySchema({ ctx })

		expect(schema).toBe(analytics.querySchema({ datasets: ['orders'] }))
		expect(
			schema.safeParse({ dataset: 'refunds', measures: ['refunds'] }).success
		).toBe(false)
		expect(
			await analytics.querySchema({ ctx: { ...ctx, canSeeRefunds: true } })
		).toBe(analytics.querySchema())
	})

	test('querySchema({ ctx }) refuses a context that may see nothing', async () => {
		await expect(
			analytics.querySchema({ ctx: { ...ctx, seesNothing: true } })
		).rejects.toMatchObject({ code: 'forbidden' })
	})
})

describe('onQuery', () => {
	test('hears every query, successful or not', async () => {
		const events: AnalyticsQueryEvent[] = []
		const analytics = analyticsWith({
			rows: [{ m_orders: 3 }],
			onQuery: (event) => events.push(event)
		})

		await analytics.query({ dataset: 'orders', measures: ['orders'] }, ctx)
		await expect(
			analytics.query({ dataset: 'refunds', measures: ['refunds'] }, ctx)
		).rejects.toMatchObject({ code: 'forbidden' })
		await expect(
			analytics.query({ dataset: 'nope', measures: ['x'] } as never, ctx)
		).rejects.toMatchObject({ code: 'invalid_query' })

		expect(
			events.map(({ dataset, rows, outcome }) => ({ dataset, rows, outcome }))
		).toEqual([
			{ dataset: 'orders', rows: 1, outcome: 'success' },
			{ dataset: 'refunds', rows: 0, outcome: 'error' },
			{ dataset: null, rows: 0, outcome: 'error' }
		])
		expect(events[1]?.error).toMatchObject({ code: 'forbidden' })
		expect(events.every((event) => event.durationMs >= 0)).toBe(true)
	})

	test('a hook that throws never fails the query', async () => {
		const analytics = analyticsWith({
			rows: [{ m_orders: 3 }],
			onQuery: () => {
				throw new Error('metrics are down')
			}
		})

		const result = await analytics.query(
			{ dataset: 'orders', measures: ['orders'] },
			ctx
		)

		expect(result.totals.orders).toBe(3)
	})

	test('an async hook that rejects never leaves an unhandled rejection', async () => {
		const unhandled: unknown[] = []
		const listener = (reason: unknown) => unhandled.push(reason)
		process.on('unhandledRejection', listener)
		try {
			const analytics = analyticsWith({
				rows: [{ m_orders: 3 }],
				onQuery: async () => {
					throw new Error('metrics are down')
				}
			})

			const result = await analytics.query(
				{ dataset: 'orders', measures: ['orders'] },
				ctx
			)
			await new Promise((resolve) => setTimeout(resolve, 10))

			expect(result.totals.orders).toBe(3)
			expect(unhandled).toEqual([])
		} finally {
			process.off('unhandledRejection', listener)
		}
	})
})

describe('number decoding', () => {
	const { decodeNumber } = postgresDialect()

	test('accepts numbers, numeric strings, bigints and decimal objects', () => {
		expect(decodeNumber(4)).toBe(4)
		expect(decodeNumber('12.50')).toBe(12.5)
		expect(decodeNumber(9007199254740991n)).toBe(9007199254740991)
		expect(decodeNumber(decimal('1.25'))).toBe(1.25)
	})

	test('anything else is null', () => {
		expect(decodeNumber(null)).toBeNull()
		expect(decodeNumber(undefined)).toBeNull()
		expect(decodeNumber(Number.NaN)).toBeNull()
		expect(decodeNumber('many')).toBeNull()
		expect(decodeNumber('')).toBeNull()
		expect(decodeNumber('  ')).toBeNull()
		expect(decodeNumber({ value: 1 })).toBeNull()
		expect(decodeNumber(decimal('NaN'))).toBeNull()
	})

	test('a driver returning decimals and bigints gives plain numbers', async () => {
		const analytics = analyticsWith({
			rows: [{ m_orders: 3n, m_revenue: decimal('1250.75') }]
		})

		const result = await analytics.query(
			{ dataset: 'orders', measures: ['orders', 'revenue'] },
			ctx
		)

		expect(result.totals).toEqual({ orders: 3, revenue: 1250.75 })
	})
})

describe('AnalyticsResultSchema', () => {
	test('accepts what any dataset returns', async () => {
		const analytics = analyticsWith({
			rows: [
				{ g_status: 'PAID', m_orders: 2 },
				{ g_status: 'OPEN', m_orders: null }
			]
		})

		const result = await analytics.query(
			{
				dataset: 'orders',
				measures: ['orders'],
				groupBy: ['status'],
				compareToPrevious: true
			},
			ctx
		)

		expect(analytics.resultSchema('orders').parse(result)).toEqual(result)
		expect(AnalyticsResultSchema.parse(result)).toEqual(result)
	})

	test('rejects what no dataset returns', () => {
		expect(
			AnalyticsResultSchema.safeParse({
				period: { from: '2026-10-01', to: '2026-10-07', timezone: 'UTC' },
				rows: [{ orders: '3' }],
				totals: {},
				notes: [],
				truncated: false
			}).success
		).toBe(false)
	})
})
