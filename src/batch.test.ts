import { describe, expect, test } from 'bun:test'
import type { Row } from './analytics.js'
import { postgresDialect } from './dialects/postgres.js'
import { type Order, orders } from './fixtures/orders.js'
import { queryBatch } from './handler.js'
import {
	type Analytics,
	type AnalyticsCache,
	createAnalytics,
	defineDataset,
	measure,
	table
} from './index.js'
import { createMetricRegistry, metricDefiner } from './metrics.js'
import { presentKpi } from './shapes.js'

type Ctx = { tenantId: string }
const ctx: Ctx = { tenantId: 't1' }

const VALUES: Record<string, number> = {
	orders: 4,
	customers: 3,
	revenue: 100,
	averageAmount: 25
}

/** The measures a statement selects, as a database would answer them: half for `p_`. */
function answer(text: string): Row {
	const row: Row = {}
	for (const [, period, key] of text.matchAll(/AS "([mp])_(\w+)"/g)) {
		const value = VALUES[key ?? ''] ?? 0
		row[`${period}_${key}`] = period === 'm' ? value : value / 2
	}
	return row
}

function setup(
	options: {
		/** Fails every statement that selects this measure. */
		refuses?: string
		cache?: Map<string, unknown>
		/** Waits before the cache answers the query that runs for `metric`. */
		cacheGet?: (metric: string | undefined) => Promise<void>
		execute?: (text: string, signal: AbortSignal | undefined) => Promise<void>
	} = {}
) {
	const statements: string[] = []
	const { cache } = options
	const stored: AnalyticsCache<Ctx> | undefined = cache && {
		get: async (key, { metric }) => {
			await options.cacheGet?.(metric)
			return cache.get(key)
		},
		set: (key, result) => cache.set(key, result)
	}
	const analytics = createAnalytics({
		datasets: [orders],
		sources: {
			main: {
				dialect: postgresDialect(),
				execute: async ({ text }, execution) => {
					statements.push(text)
					await options.execute?.(text, execution?.signal)
					if (options.refuses && text.includes(`_${options.refuses}"`))
						throw new Error('division by zero')
					if (text.includes('AS "label"'))
						return [{ key: 'north', label: 'North' }]
					return text.includes('"g_status"')
						? [{ g_status: 'PAID', ...answer(text) }]
						: [answer(text)]
				}
			}
		},
		tenant: (ctx: Ctx) => ctx.tenantId,
		now: () => new Date('2026-10-07T10:00:00Z'),
		...(stored && { cache: stored })
	})
	return { analytics, statements }
}

/** The measure columns a statement selects. */
const selected = (text: string) =>
	[...text.matchAll(/AS "([mp]_\w+)"/g)].map(([, alias]) => alias)

describe('queries of a batch that count the same rows', () => {
	test('are read in one statement, each with its own measures', async () => {
		const { analytics, statements } = setup()

		const { results } = await queryBatch(
			analytics,
			{
				orders: { dataset: 'orders', measures: ['orders'] },
				money: { dataset: 'orders', measures: ['revenue', 'orders'] },
				average: { dataset: 'orders', measures: ['averageAmount'] }
			},
			ctx
		)

		expect(statements).toHaveLength(1)
		expect(selected(statements[0] ?? '')).toEqual([
			'm_orders',
			'm_revenue',
			'm_averageAmount'
		])
		expect(results.orders?.totals).toEqual({ orders: 4 })
		expect(results.orders?.rows).toEqual([{ orders: 4 }])
		expect(results.money?.totals).toEqual({ revenue: 100, orders: 4 })
		expect(results.average?.totals).toEqual({ averageAmount: 25 })
	})

	test('share the statement that compares with the previous period', async () => {
		const { analytics, statements } = setup()
		const compared = {
			period: { last: { days: 7 } },
			compareToPrevious: true
		} as const

		const { results } = await queryBatch(
			analytics,
			{
				orders: { dataset: 'orders', measures: ['orders'], ...compared },
				revenue: { dataset: 'orders', measures: ['revenue'], ...compared }
			},
			ctx
		)

		expect(statements).toHaveLength(1)
		expect(results.orders?.totals).toEqual({ orders: 4 })
		expect(results.orders?.previous.totals).toEqual({ orders: 2 })
		expect(results.revenue?.previous.totals).toEqual({ revenue: 50 })
	})

	test('include the totals of a grouped query', async () => {
		const { analytics, statements } = setup()

		const { results } = await queryBatch(
			analytics,
			{
				revenue: { dataset: 'orders', measures: ['revenue'] },
				byStatus: {
					dataset: 'orders',
					measures: ['orders'],
					groupBy: ['status']
				}
			},
			ctx
		)

		// The grouped rows, and one statement for the totals and the other query.
		expect(statements).toHaveLength(2)
		expect(results.byStatus?.totals).toEqual({ orders: 4 })
		expect(results.byStatus?.rows[0]?.orders).toBe(4)
		expect(results.revenue?.totals).toEqual({ revenue: 100 })
	})

	test('are the same rows whatever order the filters come in', async () => {
		const { analytics, statements } = setup()
		const paid = { dimension: 'status', op: 'in', values: ['PAID'] } as const
		const rated = { dimension: 'rating', op: 'isNotEmpty' } as const

		await queryBatch(
			analytics,
			{
				a: { dataset: 'orders', measures: ['orders'], filters: [paid, rated] },
				b: { dataset: 'orders', measures: ['revenue'], filters: [rated, paid] }
			},
			ctx
		)

		expect(statements).toHaveLength(1)
	})
})

describe('measures that are more than one pass over the rows', () => {
	test('keep a statement of their own, to run side by side', async () => {
		const { analytics, statements } = setup()

		const { results } = await queryBatch(
			analytics,
			{
				orders: { dataset: 'orders', measures: ['orders'] },
				revenue: { dataset: 'orders', measures: ['revenue'] },
				// A distinct count, a median, and a count with `exists`.
				customers: { dataset: 'orders', measures: ['customers'] },
				median: { dataset: 'orders', measures: ['medianAmount'] },
				refunded: { dataset: 'orders', measures: ['refunded', 'orders'] }
			},
			ctx
		)

		expect(statements.map(selected).sort()).toEqual([
			['m_customers'],
			['m_medianAmount'],
			['m_orders', 'm_revenue'],
			['m_refunded', 'm_orders']
		])
		expect(results.customers?.totals).toEqual({ customers: 3 })
		expect(results.revenue?.totals).toEqual({ revenue: 100 })
	})
})

describe('queries of a batch that count other rows', () => {
	test('keep their own statements', async () => {
		const { analytics, statements } = setup()

		await queryBatch(
			analytics,
			{
				all: { dataset: 'orders', measures: ['orders'] },
				paid: {
					dataset: 'orders',
					measures: ['orders'],
					filters: [{ dimension: 'status', op: 'in', values: ['PAID'] }]
				},
				week: {
					dataset: 'orders',
					measures: ['orders'],
					period: { last: { days: 7 } }
				},
				shipped: { dataset: 'orders', measures: ['orders'], time: 'shipped' },
				compared: {
					dataset: 'orders',
					measures: ['orders'],
					compareToPrevious: true
				}
			},
			ctx
		)

		expect(statements).toHaveLength(5)
	})

	test('never share across tenants', async () => {
		const { analytics, statements } = setup()
		const batch = analytics.batch()
		const query = { dataset: 'orders', measures: ['orders'] } as const

		await Promise.all([
			analytics.query(query, { tenantId: 't1' }, { batch }),
			analytics.query(query, { tenantId: 't2' }, { batch })
		])

		expect(statements).toHaveLength(2)
	})
})

describe('a batch of your own', () => {
	const orderCount = { dataset: 'orders', measures: ['orders'] } as const
	const revenue = { dataset: 'orders', measures: ['revenue'] } as const

	test('shares statements between the queries given it', async () => {
		const { analytics, statements } = setup()
		const batch = analytics.batch()

		const [first, second] = await Promise.all([
			analytics.query(orderCount, ctx, { batch }),
			analytics.query(revenue, ctx, { batch })
		])

		expect(statements).toHaveLength(1)
		expect(first.totals).toEqual({ orders: 4 })
		expect(second.totals).toEqual({ revenue: 100 })
	})

	test('waits for every query, and selects in definition order whichever came first', async () => {
		const { analytics, statements } = setup({
			cache: new Map(),
			cacheGet: (metric) => Bun.sleep(metric === 'slow' ? 5 : 0)
		})
		const batch = analytics.batch()

		await Promise.all([
			analytics.query(orderCount, ctx, { batch, metric: 'slow' }),
			analytics.query({ dataset: 'orders', measures: ['averageAmount'] }, ctx, {
				batch
			}),
			analytics.query(revenue, ctx, { batch })
		])

		expect(statements.map(selected)).toEqual([
			['m_orders', 'm_revenue', 'm_averageAmount']
		])
	})

	test('queries without one run on their own', async () => {
		const { analytics, statements } = setup()

		await Promise.all([
			analytics.query(orderCount, ctx),
			analytics.query(revenue, ctx)
		])

		expect(statements).toHaveLength(2)
	})

	test('a query that comes later still runs', async () => {
		const { analytics, statements } = setup()
		const batch = analytics.batch()

		await analytics.query(orderCount, ctx, { batch })
		const late = await analytics.query(revenue, ctx, { batch })

		expect(statements).toHaveLength(2)
		expect(late.totals).toEqual({ revenue: 100 })
	})

	test('is refused by another analytics instance', async () => {
		const { analytics } = setup()
		const batch = setup().analytics.batch()

		await expect(analytics.query(orderCount, ctx, { batch })).rejects.toThrow(
			'another analytics instance'
		)
	})
})

describe('a shared statement that fails', () => {
	test('is run again for each query, so only the measure refused fails', async () => {
		const { analytics, statements } = setup({ refuses: 'averageAmount' })

		const { results, errors } = await queryBatch(
			analytics,
			{
				orders: { dataset: 'orders', measures: ['orders'] },
				revenue: { dataset: 'orders', measures: ['revenue'] },
				average: { dataset: 'orders', measures: ['averageAmount'] }
			},
			ctx
		)

		// The shared statement, then one for each query.
		expect(statements).toHaveLength(4)
		expect(results.orders?.totals).toEqual({ orders: 4 })
		expect(results.revenue?.totals).toEqual({ revenue: 100 })
		expect(errors).toEqual({
			average: { code: 'internal', message: 'The query failed' }
		})
	})

	test('is not run again for a query that asked for all of it', async () => {
		const { analytics, statements } = setup({ refuses: 'averageAmount' })

		const { errors } = await queryBatch(
			analytics,
			{ average: { dataset: 'orders', measures: ['averageAmount'] } },
			ctx
		)

		expect(statements).toHaveLength(1)
		expect(errors.average?.code).toBe('internal')
	})
})

describe('cancelling a query of a batch', () => {
	test('leaves the statement running for the others', async () => {
		let release = () => {}
		const signals: (AbortSignal | undefined)[] = []
		const { analytics } = setup({
			execute: (_text, signal) => {
				signals.push(signal)
				return new Promise((resolve) => {
					release = resolve
				})
			}
		})
		const batch = analytics.batch()
		const controller = new AbortController()

		const gone = analytics.query(
			{ dataset: 'orders', measures: ['orders'] },
			ctx,
			{ batch, signal: controller.signal }
		)
		const kept = analytics.query(
			{ dataset: 'orders', measures: ['revenue'] },
			ctx,
			{ batch }
		)
		await Bun.sleep(1)
		controller.abort(new Error('closed'))

		await expect(gone).rejects.toThrow('closed')
		expect(signals.map((signal) => signal?.aborted)).toEqual([false])
		release()
		expect((await kept).totals).toEqual({ revenue: 100 })
	})

	test('stops the statement when every query has gone', async () => {
		const signals: (AbortSignal | undefined)[] = []
		const { analytics } = setup({
			execute: (_text, signal) => {
				signals.push(signal)
				return new Promise(() => {})
			}
		})
		const batch = analytics.batch()
		const controller = new AbortController()
		const options = { batch, signal: controller.signal }

		const both = Promise.allSettled([
			analytics.query(
				{ dataset: 'orders', measures: ['orders'] },
				ctx,
				options
			),
			analytics.query(
				{ dataset: 'orders', measures: ['revenue'] },
				ctx,
				options
			)
		])
		await Bun.sleep(1)
		controller.abort(new Error('closed'))

		expect((await both).map((outcome) => outcome.status)).toEqual([
			'rejected',
			'rejected'
		])
		expect(signals.map((signal) => signal?.aborted)).toEqual([true])
	})
})

describe('a batch with label lookups, a cache and resolved measures', () => {
	test('a query that looks up labels does not hold up the others', async () => {
		const order: string[] = []
		const { analytics } = setup({
			execute: async (text) => {
				const lookup = text.includes('AS "label"')
				order.push(lookup ? 'lookup starts' : 'statement starts')
				if (lookup) await Bun.sleep(5)
				if (lookup) order.push('lookup ends')
			}
		})

		const { results } = await queryBatch(
			analytics,
			{
				north: {
					dataset: 'orders',
					measures: ['orders'],
					filters: [{ dimension: 'region', op: 'in', values: ['North'] }]
				},
				orders: { dataset: 'orders', measures: ['orders'] },
				revenue: { dataset: 'orders', measures: ['revenue'] }
			},
			ctx
		)

		expect(order).toEqual([
			'lookup starts',
			'statement starts',
			'lookup ends',
			'statement starts'
		])
		expect(results.north?.totals).toEqual({ orders: 4 })
		expect(results.revenue?.totals).toEqual({ revenue: 100 })
	})

	test('a cached query adds nothing, and each query is stored on its own', async () => {
		const cache = new Map<string, unknown>()
		const { analytics, statements } = setup({ cache })
		const orderCount = { dataset: 'orders', measures: ['orders'] } as const
		await analytics.query(orderCount, ctx)

		const { results } = await queryBatch(
			analytics,
			{
				orders: orderCount,
				revenue: { dataset: 'orders', measures: ['revenue'] },
				average: { dataset: 'orders', measures: ['averageAmount'] }
			},
			ctx
		)

		expect(statements).toHaveLength(2)
		expect(selected(statements[1] ?? '')).toEqual([
			'm_revenue',
			'm_averageAmount'
		])
		expect(results.orders?.totals).toEqual({ orders: 4 })
		expect(cache.size).toBe(3)
	})

	test('a resolved measure gets the measures it uses from the shared statement', async () => {
		const order = table<Order>('orders')
		const sales = defineDataset({
			key: 'sales',
			label: 'Sales',
			description: 'One row per order.',
			from: order,
			tenantColumn: order.col('tenantId'),
			time: { created: { column: order.col('createdAt'), label: 'Created' } },
			measures: {
				orders: measure.count({ label: 'Orders' }),
				revenue: measure.sum(order.col('amount'), { label: 'Revenue' }),
				perOrder: measure.resolved({
					label: 'Revenue per order',
					result: 'number',
					uses: ['revenue', 'orders']
				})
			},
			dimensions: {}
		})
		const statements: string[] = []
		const analytics = createAnalytics({
			datasets: [sales],
			sources: {
				main: {
					dialect: postgresDialect(),
					execute: async ({ text }) => {
						statements.push(text)
						return [answer(text)]
					}
				}
			},
			tenant: (ctx: Ctx) => ctx.tenantId,
			resolvers: {
				sales: {
					perOrder: ({ rows, totals }) => {
						const perOrder = (values: typeof totals) =>
							values.revenue === null ? null : values.revenue / values.orders
						return {
							rows: rows.map(({ values }) => perOrder(values)),
							totals: perOrder(totals)
						}
					}
				}
			}
		})
		const batch = analytics.batch()

		const [perOrder, count] = await Promise.all([
			analytics.query({ dataset: 'sales', measures: ['perOrder'] }, ctx, {
				batch
			}),
			analytics.query({ dataset: 'sales', measures: ['orders'] }, ctx, {
				batch
			})
		])

		expect(statements).toHaveLength(1)
		expect(perOrder.totals).toEqual({ perOrder: 25 })
		expect(count.totals).toEqual({ orders: 4 })
	})
})

describe('the metric registry', () => {
	const defineMetric = metricDefiner<
		Analytics<readonly [typeof orders], Ctx>,
		{ staffOnly?: boolean }
	>()
	const kpi = <const Key extends string>(
		key: Key,
		measure: 'orders' | 'revenue' | 'averageAmount',
		staffOnly = false
	) =>
		defineMetric({
			key,
			kind: 'kpi',
			description: key,
			staffOnly,
			query: () => ({ dataset: 'orders', measures: [measure] }),
			shape: (result) => presentKpi(result, measure)
		})

	test('reads the numbers of a dashboard in one statement', async () => {
		const { analytics, statements } = setup()
		const asked: string[] = []
		const registry = createMetricRegistry({
			analytics,
			metrics: [
				kpi('orders.count', 'orders'),
				kpi('orders.revenue', 'revenue'),
				kpi('orders.average', 'averageAmount'),
				kpi('orders.secret', 'revenue', true)
			] as const,
			canRun: async (metric) => {
				asked.push(metric.key)
				await Bun.sleep(1)
				return !metric.staffOnly
			}
		})

		const { results, errors } = await registry.collect(
			{
				metrics: registry.keys.map((key) => ({ key })),
				period: { last: { days: 7 } },
				compareToPrevious: true
			},
			ctx
		)

		expect(asked).toHaveLength(4)
		expect(statements).toHaveLength(1)
		expect(selected(statements[0] ?? '')).toEqual([
			'm_orders',
			'p_orders',
			'm_revenue',
			'p_revenue',
			'm_averageAmount',
			'p_averageAmount'
		])
		expect(results['orders.count']?.current.value).toBe(4)
		expect(results['orders.revenue']?.previous?.value).toBe(50)
		expect(results['orders.average']?.current.value).toBe(25)
		expect(errors['orders.secret']?.code).toBe('forbidden')
	})
})
