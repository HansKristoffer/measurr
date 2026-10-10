import { describe, expect, test } from 'bun:test'
import {
	type AnalyticsQueryEvent,
	AnalyticsResultSchema,
	allTenants,
	createAnalytics,
	defineDataset,
	eq,
	measure,
	type Tenant,
	table
} from './index.js'
import { postgresDialect } from './dialects/postgres.js'
import {
	type Order,
	type Refund,
	maintenance,
	orders,
	sales
} from './fixtures/orders.js'
import type { Row } from './analytics.js'
import { planLookup } from './plan.js'

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

describe('datasets without a tenant column', () => {
	const sql: string[] = []
	const analytics = createAnalytics({
		datasets: [orders, maintenance],
		sources: {
			main: {
				dialect: postgresDialect(),
				execute: async ({ text }) => {
					sql.push(text)
					return []
				}
			}
		},
		tenant: (ctx: { tenant: Tenant }) => ctx.tenant
	})
	const everyTenant: { tenant: Tenant } = { tenant: allTenants }
	const byTechnician = {
		dataset: 'maintenance',
		measures: ['cases'],
		filters: [{ dimension: 'technician', op: 'in', values: ['Kim'] }]
	} as const

	test('are offered only to a caller who sees every tenant', async () => {
		const keys = async (tenant: Tenant) =>
			(await analytics.listDatasets({ tenant })).map((dataset) => dataset.key)

		expect(await keys('org-1')).toEqual(['orders'])
		expect(await keys([])).toEqual(['orders'])
		expect(await keys(allTenants)).toEqual(['orders', 'maintenance'])
		expect(await analytics.querySchema({ ctx: { tenant: 'org-1' } })).toBe(
			analytics.querySchema({ datasets: ['orders'] })
		)
		expect(await analytics.querySchema({ ctx: everyTenant })).toBe(
			analytics.querySchema()
		)
	})

	test('refuse a scoped caller before any statement or lookup runs', async () => {
		sql.length = 0
		for (const tenant of ['org-1', ['org-1', 'org-2'], []]) {
			await expect(
				analytics.query(byTechnician, { tenant })
			).rejects.toMatchObject({ code: 'forbidden' })
			await expect(
				analytics.explain(byTechnician, { tenant })
			).rejects.toMatchObject({ code: 'forbidden' })
		}

		expect(sql).toEqual([])
		// The planner refuses on its own as well.
		expect(() =>
			planLookup(maintenance, 'technician', 'org-1', null, new Date())
		).toThrow(/no tenant column/)
	})

	test('run unfiltered for a caller who sees every tenant', async () => {
		sql.length = 0
		// The label lookup runs, finds nothing and fails.
		await expect(
			analytics.query(byTechnician, everyTenant)
		).rejects.toMatchObject({ code: 'unknown_value' })
		const [statement] = await analytics.explain(
			{ dataset: 'maintenance', measures: ['cases'] },
			everyTenant
		)

		expect(sql).toHaveLength(2)
		expect(statement?.text).toContain('FROM "maintenance"')
	})

	test('must say so: a missing tenantColumn is refused', () => {
		const order = table<Order>('orders')
		const withoutTenantColumn = {
			key: 'loose',
			label: 'Loose',
			description: 'No tenant column given.',
			from: order,
			time: { created: { column: order.col('createdAt'), label: 'Created' } },
			measures: { orders: measure.count({ label: 'Orders' }) },
			dimensions: {}
		}

		expect(() => defineDataset(withoutTenantColumn as never)).toThrow(
			/declare tenantColumn, or null/
		)
	})
})

describe('field access', () => {
	type Viewer = { role: 'staff' | 'customer' }
	const staff: Viewer = { role: 'staff' }
	const customer: Viewer = { role: 'customer' }
	const checked: string[] = []
	const options = {
		datasets: [sales],
		sources: {
			main: { dialect: postgresDialect(), execute: async () => [] }
		},
		tenant: () => 'org-1'
	}
	const analytics = createAnalytics({
		...options,
		authorizeField: (dataset, key, access, viewer: Viewer) => {
			checked.push(`${dataset.key}.${key}:${access}`)
			return viewer.role === access
		}
	})

	test('marking a field needs authorizeField', () => {
		expect(() => createAnalytics(options)).toThrow(/no authorizeField/)
	})

	test('the catalog and schema for a caller leave out what it may not use', async () => {
		const [entry] = await analytics.listDatasets(customer)
		const schema = await analytics.querySchema({ ctx: customer })
		const parses = (query: object) =>
			schema.safeParse({ dataset: 'sales', ...query }).success

		expect(entry?.measures.map((measure) => measure.key)).toEqual([
			'orders',
			'revenue'
		])
		expect(entry?.dimensions.map((dimension) => dimension.key)).toEqual([
			'status'
		])
		expect(parses({ measures: ['orders'], groupBy: ['status'] })).toBe(true)
		expect(parses({ measures: ['margin'] })).toBe(false)
		expect(parses({ measures: ['marginRate'] })).toBe(false)
		expect(parses({ measures: ['orders'], groupBy: ['customer'] })).toBe(false)
		expect(await analytics.querySchema({ ctx: customer })).toBe(schema)

		const [full] = await analytics.listDatasets(staff)
		expect(full?.measures).toHaveLength(4)
		expect(await analytics.querySchema({ ctx: staff })).toBe(
			analytics.querySchema()
		)
	})

	test('a ratio needs the access of the measures it divides', async () => {
		checked.length = 0
		await analytics.listDatasets(customer)

		expect(checked.sort()).toEqual([
			'sales.customer:staff',
			'sales.margin:staff',
			'sales.marginRate:staff'
		])
	})

	test('every query checks again', async () => {
		const refused = [
			{ measures: ['margin'] },
			{ measures: ['marginRate'] },
			{ measures: ['orders'], groupBy: ['customer'] },
			{
				measures: ['orders'],
				groupBy: ['customer'],
				sort: { by: 'customer' }
			},
			{
				measures: ['orders'],
				filters: [{ dimension: 'customer', op: 'isEmpty' }]
			}
		] as const
		for (const query of refused) {
			await expect(
				analytics.query({ dataset: 'sales', ...query }, customer)
			).rejects.toMatchObject({ code: 'forbidden' })
			await analytics.query({ dataset: 'sales', ...query }, staff)
		}

		await expect(
			analytics.query(
				{ dataset: 'sales', measures: ['orders', 'margin'] },
				customer
			)
		).rejects.toThrow('Not allowed to use measure margin of sales')
		await analytics.query(
			{ dataset: 'sales', measures: ['orders'], groupBy: ['status'] },
			customer
		)
	})

	test('a dataset without a measure the caller may use is not offered', async () => {
		const order = table<Order>('orders')
		const margins = defineDataset({
			key: 'margins',
			label: 'Margins',
			description: 'Staff only.',
			from: order,
			tenantColumn: order.col('tenantId'),
			time: { created: { column: order.col('createdAt'), label: 'Created' } },
			measures: {
				margin: measure.sum(order.col('amount'), {
					label: 'Margin',
					access: 'staff'
				})
			},
			dimensions: {}
		})
		const onlyMargins = createAnalytics({
			...options,
			datasets: [margins],
			authorizeField: (_dataset, _key, access, viewer: Viewer) =>
				viewer.role === access
		})

		expect(await onlyMargins.listDatasets(customer)).toEqual([])
		await expect(
			onlyMargins.querySchema({ ctx: customer })
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

	test('an all-time result says so', async () => {
		const analytics = analyticsWith({ rows: [{ m_orders: 9 }] })

		const result = await analytics.query(
			{ dataset: 'orders', measures: ['orders'], period: { all: true } },
			ctx
		)

		expect(result.period).toEqual({ all: true, timezone: 'UTC' })
		expect(result.previous).toBeUndefined()
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
