import { describe, expect, test } from 'bun:test'
import { z } from 'zod'
import {
	type AnalyticsCache,
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

	test('defineDataset refuses a missing tenantColumn', () => {
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
	const options = {
		datasets: [sales],
		sources: {
			main: { dialect: postgresDialect(), execute: async () => [] }
		},
		tenant: () => 'org-1'
	}
	const analytics = createAnalytics({
		...options,
		authorizeField: (_dataset, _key, access, viewer: Viewer) =>
			viewer.role === access
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

	test('every query checks again, ratios included', async () => {
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

describe('cache', () => {
	type CacheCtx = Ctx & { refresh?: boolean }

	function cachedAnalytics(cache: Partial<AnalyticsCache<CacheCtx>> = {}) {
		const store = new Map<string, unknown>()
		const statements: string[] = []
		const events: AnalyticsQueryEvent[] = []
		const analytics = createAnalytics({
			datasets: [orders, refunds],
			sources: {
				main: {
					dialect: postgresDialect(),
					execute: async ({ text }) => {
						statements.push(text)
						return [{ m_orders: 3 }]
					}
				}
			},
			tenant: (ctx: CacheCtx) => ctx.tenantId,
			authorize: (dataset, ctx) =>
				dataset.key !== 'refunds' || ctx.canSeeRefunds,
			now: () => new Date('2026-10-20T12:00:00Z'),
			onQuery: (event) => events.push(event),
			cache: {
				get: (key, { ctx }) => (ctx.refresh ? undefined : store.get(key)),
				set: (key, result) => store.set(key, result),
				...cache
			}
		})
		return { analytics, store, statements, events }
	}

	const ordersQuery = { dataset: 'orders', measures: ['orders'] } as const

	test('answers a repeated query from the cache', async () => {
		const { analytics, statements, events } = cachedAnalytics()

		const first = await analytics.query(ordersQuery, ctx)
		const second = await analytics.query(ordersQuery, ctx)

		expect(second).toEqual(first)
		expect(statements).toHaveLength(1)
		expect(events.map((event) => event.cache)).toEqual(['miss', 'hit'])
	})

	test('keys name the dataset and ignore how the query is written', async () => {
		const { analytics, store } = cachedAnalytics()

		await analytics.query(
			{
				measures: ['orders'],
				dataset: 'orders',
				period: { last: { days: 30 } }
			},
			ctx
		)
		await analytics.query(ordersQuery, ctx)

		expect([...store.keys()]).toEqual([
			expect.stringMatching(/^measurr:orders:[0-9a-f]{64}$/)
		])
	})

	test('a tenant, a period or a timezone of its own is a different entry', async () => {
		const { analytics, store } = cachedAnalytics()

		await analytics.query(ordersQuery, ctx)
		await analytics.query(ordersQuery, { ...ctx, tenantId: 't2' })
		await analytics.query(
			{ ...ordersQuery, period: { last: { days: 7 } } },
			ctx
		)

		expect(store.size).toBe(3)
	})

	test('a query the caller may not run never reaches the cache', async () => {
		const { analytics, store } = cachedAnalytics()
		const refundsQuery = { dataset: 'refunds', measures: ['refunds'] } as const
		await analytics.query(refundsQuery, { ...ctx, canSeeRefunds: true })
		expect(store.size).toBe(1)

		await expect(analytics.query(refundsQuery, ctx)).rejects.toMatchObject({
			code: 'forbidden'
		})
	})

	test('a miss from get bypasses the cache and stores the fresh result', async () => {
		const { analytics, statements, store } = cachedAnalytics()

		await analytics.query(ordersQuery, ctx)
		await analytics.query(ordersQuery, { ...ctx, refresh: true })

		expect(statements).toHaveLength(2)
		expect(store.size).toBe(1)
	})

	test('a stored value that is not a result is a miss', async () => {
		const { analytics, statements } = cachedAnalytics({
			get: () => ({ rows: 'stale' })
		})

		const result = await analytics.query(ordersQuery, ctx)

		expect(result.totals.orders).toBe(3)
		expect(statements).toHaveLength(1)
	})

	test('a failing cache never fails the query', async () => {
		const { analytics } = cachedAnalytics({
			get: async () => {
				throw new Error('redis is down')
			},
			set: () => {
				throw new Error('redis is down')
			}
		})

		const result = await analytics.query(ordersQuery, ctx)

		expect(result.totals.orders).toBe(3)
	})
})

test('listDatasets says what values each measure gives', async () => {
	const [entry] = await analyticsWith({}).listDatasets(ctx)

	expect(
		Object.fromEntries(
			(entry?.measures ?? []).map((measure) => [measure.key, measure.valueType])
		)
	).toEqual({
		orders: 'count',
		customers: 'count',
		refunded: 'count',
		revenue: 'number',
		averageAmount: 'number',
		medianAmount: 'number',
		averageRating: 'number',
		paidShare: 'ratio',
		refundRate: 'ratio'
	})
})

describe('query options', () => {
	/** Records every statement; answers grouped statements with `rows`, the rest with totals. */
	function recording(
		options: {
			rows?: Row[]
			concurrency?: number
			maxLimit?: number
			cache?: AnalyticsCache<Ctx>
			execute?: (signal: AbortSignal | undefined) => Promise<void>
		} = {}
	) {
		const statements: string[] = []
		const signals: (AbortSignal | undefined)[] = []
		const analytics = createAnalytics({
			datasets: [orders],
			sources: {
				main: {
					dialect: postgresDialect(),
					execute: async ({ text }, execution) => {
						statements.push(text)
						signals.push(execution?.signal)
						await options.execute?.(execution?.signal)
						return text.includes('"g_')
							? (options.rows ?? [])
							: [{ m_orders: 3 }]
					}
				}
			},
			tenant: (ctx: Ctx) => ctx.tenantId,
			...(options.concurrency && { concurrency: options.concurrency }),
			...(options.maxLimit && { maxLimit: options.maxLimit }),
			...(options.cache && { cache: options.cache })
		})
		return { analytics, statements, signals }
	}

	const byStatus = {
		dataset: 'orders',
		measures: ['orders'],
		groupBy: ['status']
	} as const

	test('totals: false skips the totals statement and leaves totals out', async () => {
		const { analytics, statements } = recording({
			rows: [{ g_status: 'PAID', m_orders: 2 }]
		})

		const result = await analytics.query(
			{ ...byStatus, totals: false, compareToPrevious: true },
			ctx
		)

		expect(statements).toHaveLength(2)
		expect('totals' in result).toBe(false)
		expect('totals' in result.previous).toBe(false)
		expect(result.rows[0]?.orders).toBe(2)
		// @ts-expect-error a result without totals says so in its type
		void result.totals
	})

	test('totals stay the default, and models are not offered the option', async () => {
		const { analytics, statements } = recording()

		const result = await analytics.query(byStatus, ctx)

		expect(statements).toHaveLength(2)
		expect(result.totals.orders).toBe(3)
		expect(
			JSON.stringify(z.toJSONSchema(analytics.querySchema()))
		).not.toContain('"totals"')
	})

	test('maxLimit raises the limit for app code; the schema a model gets keeps 100', async () => {
		const { analytics, statements } = recording({ maxLimit: 500 })

		await analytics.query({ ...byStatus, limit: 300 }, ctx)

		expect(statements[0]).toContain('LIMIT 301')
		expect(
			analytics.querySchema().safeParse({ ...byStatus, limit: 300 }).success
		).toBe(false)
		await expect(
			recording().analytics.query({ ...byStatus, limit: 300 }, ctx)
		).rejects.toMatchObject({ code: 'invalid_query' })
	})

	test('a result describes its grouped dimensions and measures', async () => {
		const { analytics } = recording()

		const result = await analytics.query(
			{
				dataset: 'orders',
				measures: ['orders', 'paidShare'],
				groupBy: ['day', 'size']
			},
			ctx
		)

		expect(result.fields).toEqual({
			groupBy: [
				{ key: 'day', label: 'Day', kind: 'timeBucket', unit: 'day' },
				{
					key: 'size',
					label: 'Size',
					kind: 'computed',
					values: [
						{ key: 'large', label: 'Large' },
						{ key: 'medium', label: 'Medium' },
						{ key: 'small', label: 'Small' }
					]
				}
			],
			measures: [
				{ key: 'orders', label: 'Orders', valueType: 'count' },
				{ key: 'paidShare', label: 'Paid', valueType: 'ratio' }
			]
		})
		expect(AnalyticsResultSchema.parse(result).fields).toEqual(result.fields)
	})

	test('concurrency caps the statements running at once', async () => {
		let running = 0
		let most = 0
		const { analytics, statements } = recording({
			concurrency: 2,
			execute: async () => {
				most = Math.max(most, ++running)
				await new Promise((resolve) => setTimeout(resolve, 5))
				running--
			}
		})

		await Promise.all(
			[1, 2, 3].map((days) =>
				analytics.query(
					{ ...byStatus, period: { last: { days } }, compareToPrevious: true },
					ctx
				)
			)
		)

		expect(statements).toHaveLength(12)
		expect(most).toBe(2)
	})

	test('an aborted query rejects with the reason and reaches the source', async () => {
		const controller = new AbortController()
		const { analytics, signals } = recording({
			execute: async (signal) => {
				controller.abort(new Error('gone'))
				signal?.throwIfAborted()
			}
		})

		await expect(
			analytics.query(byStatus, ctx, { signal: controller.signal })
		).rejects.toThrow('gone')
		expect(signals[0]).toBe(controller.signal)
		await expect(
			analytics.query(byStatus, ctx, { signal: controller.signal })
		).rejects.toThrow('gone')
	})

	test('a waiting statement leaves the queue when its query aborts', async () => {
		let release = () => {}
		const { analytics, statements } = recording({
			concurrency: 1,
			execute: () => new Promise((resolve) => (release = resolve))
		})
		const first = analytics.query(
			{ dataset: 'orders', measures: ['orders'] },
			ctx
		)
		const controller = new AbortController()
		const second = analytics.query(
			{ dataset: 'orders', measures: ['revenue'] },
			ctx,
			{ signal: controller.signal }
		)
		await Bun.sleep(1)
		controller.abort(new Error('gone'))

		await expect(second).rejects.toThrow('gone')
		release()
		await first
		expect(statements).toHaveLength(1)
	})

	test('with a cache, identical queries in flight share one run', async () => {
		const store = new Map<string, unknown>()
		const cache: AnalyticsCache<Ctx> = {
			get: (key) => store.get(key),
			set: (key, result) => store.set(key, result)
		}
		const { analytics, statements } = recording({
			cache,
			execute: () => Bun.sleep(5)
		})

		const [a, b] = await Promise.all([
			analytics.query(byStatus, ctx),
			analytics.query(byStatus, ctx)
		])

		expect(a).toEqual(b)
		expect(statements).toHaveLength(2)
	})

	test('a shared run goes on while one of its callers still waits', async () => {
		const { analytics, statements } = recording({
			cache: { get: () => null, set: () => {} },
			execute: () => Bun.sleep(5)
		})
		const controller = new AbortController()

		const gone = analytics.query(byStatus, ctx, { signal: controller.signal })
		const kept = analytics.query(byStatus, ctx)
		await Bun.sleep(1)
		controller.abort(new Error('gone'))

		await expect(gone).rejects.toThrow('gone')
		expect((await kept).totals.orders).toBe(3)
		expect(statements).toHaveLength(2)
	})

	test('a changed definition is a different cache entry', async () => {
		const keys: string[] = []
		const cache: AnalyticsCache<Ctx> = {
			get: () => null,
			set: (key) => keys.push(key)
		}
		const relabeled = {
			...orders,
			measures: {
				...orders.measures,
				orders: { ...orders.measures.orders, label: 'Placed orders' }
			}
		}
		for (const dataset of [orders, relabeled]) {
			await createAnalytics({
				datasets: [dataset],
				sources: {
					main: { dialect: postgresDialect(), execute: async () => [] }
				},
				tenant: (ctx: Ctx) => ctx.tenantId,
				cache
			}).query({ dataset: 'orders', measures: ['orders'] }, ctx)
		}

		expect(keys).toHaveLength(2)
		expect(keys[0]).not.toBe(keys[1])
	})

	test('onQuery and the cache hear the metric a query runs for', async () => {
		const events: AnalyticsQueryEvent[] = []
		const entries: unknown[] = []
		await createAnalytics({
			datasets: [orders],
			sources: {
				main: { dialect: postgresDialect(), execute: async () => [] }
			},
			tenant: (ctx: Ctx) => ctx.tenantId,
			onQuery: (event) => events.push(event),
			cache: { get: () => null, set: (_, __, entry) => entries.push(entry) }
		}).query({ dataset: 'orders', measures: ['orders'] }, ctx, {
			metric: 'orders.count'
		})

		expect(events[0]?.metric).toBe('orders.count')
		expect(entries).toEqual([
			{ dataset: 'orders', ctx, metric: 'orders.count' }
		])
	})
})

describe('period and scope', () => {
	const analytics = createAnalytics({
		datasets: [orders],
		sources: { main: { dialect: postgresDialect(), execute: async () => [] } },
		tenant: (ctx: { tenantId?: string }) => ctx.tenantId,
		timezone: () => 'Europe/Copenhagen',
		now: () => new Date('2026-11-10T23:30:00Z')
	})

	test('period resolves local days in the timezone of ctx', async () => {
		expect(await analytics.period({ last: { days: 7 } }, {})).toMatchObject({
			from: '2026-11-05',
			to: '2026-11-11',
			timezone: 'Europe/Copenhagen',
			days: 7
		})
		expect(await analytics.period({ all: true }, {})).toBeNull()
		await expect(
			analytics.period({ from: '2026-11-02', to: '2026-11-01' }, {})
		).rejects.toMatchObject({ code: 'invalid_period' })
	})

	test('scope is the tenant every query gets, and refuses none', () => {
		expect(analytics.scope({ tenantId: 't1' })).toBe('t1')
		expect(() => analytics.scope({})).toThrow('without a tenant')
	})
})

test('listDatasets gives a resolved measure its own value type', async () => {
	const order = table<Order>('orders')
	const resolved = defineDataset({
		key: 'resolvedOrders',
		label: 'Orders',
		description: 'One row per order.',
		from: order,
		tenantColumn: order.col('tenantId'),
		time: { created: { column: order.col('createdAt'), label: 'Created' } },
		measures: {
			orders: measure.count({ label: 'Orders' }),
			forecast: measure.resolved({
				label: 'Forecast',
				result: 'count',
				uses: ['orders']
			}),
			perDay: measure.resolved({
				label: 'Per day',
				result: 'number',
				uses: ['orders']
			})
		},
		dimensions: {}
	})
	const [entry] = await createAnalytics({
		datasets: [resolved],
		sources: { main: { dialect: postgresDialect(), execute: async () => [] } },
		tenant: () => 't1',
		resolvers: {
			resolvedOrders: {
				forecast: () => ({ rows: [], totals: null }),
				perDay: () => ({ rows: [], totals: null })
			}
		}
	}).listDatasets({})

	expect(entry?.measures.map((m) => m.valueType)).toEqual([
		'count',
		'count',
		'number'
	])
})
