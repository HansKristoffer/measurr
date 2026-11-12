import { describe, expect, expectTypeOf, test } from 'bun:test'
import { z } from 'zod'
import { postgresDialect } from './dialects/postgres.js'
import { orderMetrics, type Role } from './fixtures/metrics.js'
import { orderBook, orders } from './fixtures/orders.js'
import { createAnalytics } from './index.js'
import {
	createMetricRegistry,
	type MetricChunk,
	MetricError,
	type MetricFiltersOf,
	type MetricKeysOfKind,
	MetricOutputSchema,
	type MetricOutputOf,
	type MetricResult,
	MetricResultSchema,
	metricDefiner,
	metricOutputSchemas
} from './metrics.js'
import { presentKpi, presentTimeseries } from './shapes.js'
import { assertMetricContract, checkMetricContract } from './testing.js'
import { localDate } from './period.js'
import type {
	KpiOutput,
	LeaderboardOutput,
	TimeSeriesOutput
} from './shapes.js'

type Ctx = { role: Role; timezone: string }

const DAY_MS = 86_400_000
const TIMEZONE = 'Pacific/Auckland'

/**
 * Answers every statement: the current period has 2 orders a bucket and the previous one 1,
 * each on the period's first local day. Records what ran.
 */
function registryWith(options: { failRegions?: boolean } = {}) {
	const statements: { text: string; values: readonly unknown[] }[] = []
	const analytics = createAnalytics({
		datasets: [orders, orderBook],
		sources: {
			main: {
				dialect: postgresDialect(),
				execute: async ({ text, values }) => {
					statements.push({ text, values })
					if (options.failRegions && text.includes('"g_region"'))
						throw new Error('connection reset')
					const start = values[2]
					const timed = typeof start === 'string'
					const previous =
						timed && statements.some((s) => String(s.values[2]) > start)
					const value = previous ? 1 : 2
					const day = timed ? localDate(new Date(start), TIMEZONE) : null
					const row = {
						m_orders: value,
						m_paidShare: 0.25,
						m_revenue: 100
					}
					if (text.includes('"g_region"'))
						return [{ ...row, g_region: 'north', g_region__label: 'North' }]
					if (text.includes('"g_status"'))
						return [
							{ ...row, g_status: 'PAID' },
							{ ...row, g_status: 'OPEN', m_orders: 1 }
						]
					if (text.includes('"g_day"')) return [{ ...row, g_day: day }]
					if (text.includes('"g_month"'))
						return [{ ...row, g_month: `${day?.slice(0, 8)}01` }]
					return [row]
				}
			}
		},
		tenant: () => 't1',
		timezone: (ctx: Ctx) => ctx.timezone
	})
	const shapeErrors: string[] = []
	const registry = createMetricRegistry({
		analytics,
		metrics: orderMetrics,
		canRun: (metric, ctx) =>
			!metric.allowedRoles || metric.allowedRoles.includes(ctx.role),
		onShapeError: (_, metric) => shapeErrors.push(metric.key)
	})
	return { registry, statements, shapeErrors }
}

type Registry = ReturnType<typeof registryWith>['registry']

/** The trend's result: a chunk's key narrows its output, so no cast is needed. */
function trendOf(chunk: MetricChunk<Registry['metrics'][number]> | undefined) {
	if (chunk?.key !== 'orders.trend' || !chunk.result)
		throw new Error(`Not a trend result: ${JSON.stringify(chunk)}`)
	return chunk.result
}

const owner: Ctx = { role: 'owner', timezone: TIMEZONE }

// Noon UTC on 30 September is 01:00 on 1 October in Auckland.
const week = {
	from: new Date('2026-09-30T12:00:00Z'),
	to: new Date(new Date('2026-09-30T12:00:00Z').getTime() + 6 * DAY_MS)
}

async function run(
	registry: ReturnType<typeof registryWith>['registry'],
	request: Parameters<typeof registry.run>[0],
	ctx: Ctx = owner
) {
	return Array.fromAsync(registry.run(request, ctx))
}

describe('createMetricRegistry', () => {
	test('runs every metric and marks the last chunk done', async () => {
		const { registry } = registryWith()
		const chunks = await run(registry, {
			metrics: registry.keys.map((key) => ({ key })),
			...week,
			compareToPrevious: true
		})

		expect(chunks.filter((chunk) => chunk.error)).toEqual([])
		expect(chunks.map((chunk) => chunk.key).sort()).toEqual(
			[...registry.keys].sort()
		)
		for (const chunk of chunks) {
			expect(chunk.result?.current.kind).toBe(registry.get(chunk.key).kind)
		}
		expect(chunks.map((chunk) => chunk.done)).toEqual([
			false,
			false,
			false,
			false,
			true
		])
	})

	test('counts the local days the instants fall on, in the timezone of ctx', async () => {
		const { registry } = registryWith()
		const [chunk] = await run(registry, {
			metrics: [{ key: 'orders.trend' }],
			...week
		})

		const output = trendOf(chunk).current
		expect(output.granularity).toBe('day')
		expect(output.series[0]?.key).toBe('volume')
		expect(output.series[0]?.label).toBe('Orders')
		expect(output.series[0]?.points.map((point) => point.ts)).toEqual(
			Array.from(
				{ length: 7 },
				(_, day) => new Date(Date.UTC(2026, 9, 1 + day))
			)
		)
		// Every bucket has a point; buckets without rows are 0.
		expect(output.series[0]?.points.map((point) => point.value)).toEqual([
			2, 0, 0, 0, 0, 0, 0
		])
	})

	test('groups a series by the bucket nearest the granularity', async () => {
		const { registry, statements } = registryWith()
		const [chunk] = await run(registry, {
			metrics: [{ key: 'orders.trend' }],
			...week,
			granularity: 'quarter'
		})

		expect(statements[0]?.text).toContain('"g_month"')
		expect(trendOf(chunk).current.granularity).toBe('month')
	})

	test('puts the previous period on the current buckets', async () => {
		const { registry } = registryWith()
		const [chunk] = await run(registry, {
			metrics: [{ key: 'orders.trend' }],
			...week,
			compareToPrevious: true
		})

		const { current, previous } = trendOf(chunk)
		expect(previous?.series[0]?.points.map((point) => point.ts)).toEqual(
			current.series[0]?.points.map((point) => point.ts)
		)
		expect(previous?.series[0]?.points[0]?.value).toBe(1)
	})

	test('a snapshot counts all time and has no previous period', async () => {
		const { registry, statements } = registryWith()
		const [chunk] = await run(registry, {
			metrics: [{ key: 'orders.byStatus' }],
			...week,
			compareToPrevious: true
		})

		expect(statements.map((s) => s.text).join()).not.toContain('"createdAt"')
		expect(chunk?.result).toEqual({
			current: {
				kind: 'distribution',
				total: 3,
				segments: [
					{ key: 'OPEN', label: 'Open', value: 1, percent: (1 / 3) * 100 },
					{ key: 'PAID', label: 'Paid', value: 2, percent: (2 / 3) * 100 }
				],
				chartType: 'donut'
			},
			supportsTimeRange: false,
			period: { all: true, timezone: TIMEZONE }
		})
	})

	test('a metric over a time range counts all time without one', async () => {
		const { registry, statements } = registryWith()
		const [chunk] = await run(registry, { metrics: [{ key: 'orders.count' }] })

		expect(statements.map((s) => s.text).join()).not.toContain('"createdAt"')
		expect(chunk?.result?.current).toEqual({
			kind: 'kpi',
			value: 2,
			label: 'Orders'
		})
	})

	test('access, filters and shapes fail one metric, not the request', async () => {
		const { registry, statements, shapeErrors } = registryWith()
		const chunks = await run(
			registry,
			{
				metrics: [
					{ key: 'orders.paidShare' },
					{ key: 'orders.count', filters: { status: 'LOST' } },
					{
						key: 'orders.count',
						requestKey: 'paid',
						filters: { status: 'PAID' }
					},
					{ key: 'orders.topRegions', filters: { limit: 5 } }
				],
				...week
			},
			{ role: 'member', timezone: TIMEZONE }
		)

		expect(chunks[0]).toEqual({
			key: 'orders.paidShare',
			requestKey: 'orders.paidShare',
			error: 'Access denied',
			code: 'forbidden',
			done: false
		})
		expect(chunks[1]?.error).toStartWith('Invalid filters:')
		expect(chunks.find((chunk) => chunk.requestKey === 'paid')?.result).toEqual(
			{
				current: { kind: 'kpi', value: 2, label: 'Orders' },
				supportsTimeRange: true,
				period: { from: '2026-10-01', to: '2026-10-07', timezone: TIMEZONE }
			}
		)
		expect(statements.some((s) => s.values.includes('PAID'))).toBe(true)
		expect(chunks.find((chunk) => chunk.key === 'orders.topRegions')).toEqual({
			key: 'orders.topRegions',
			requestKey: 'orders.topRegions',
			result: {
				current: {
					kind: 'leaderboard',
					items: [
						{
							rank: 1,
							id: 'north',
							label: 'North',
							value: 2,
							meta: { revenue: 100 }
						}
					]
				},
				supportsTimeRange: true,
				period: { from: '2026-10-01', to: '2026-10-07', timezone: TIMEZONE }
			},
			done: expect.any(Boolean)
		})
		expect(chunks.at(-1)?.done).toBe(true)
		expect(shapeErrors).toEqual([])
	})

	test('an engine error carries its message; a driver error does not', async () => {
		const { registry } = registryWith({ failRegions: true })
		const [chunk] = await run(registry, {
			metrics: [{ key: 'orders.topRegions' }],
			...week
		})

		expect(chunk?.error).toBe('The query failed')
	})

	test('a shape that throws fails its metric', async () => {
		const shapeErrors: string[] = []
		const broken = createMetricRegistry({
			analytics: createAnalytics({
				datasets: [orders],
				sources: {
					main: { dialect: postgresDialect(), execute: async () => [] }
				},
				tenant: () => 't1'
			}),
			metrics: [
				metricDefiner<typeof orders>()({
					key: 'orders.broken',
					kind: 'kpi',
					description: 'Throws while drawing',
					supportsTimeRange: false,
					filterSchema: z.object({}),
					query: () => ({ dataset: 'orders', measures: ['orders'] }),
					shape: (result) => {
						throw new Error(`no rows in ${result.rows.length}`)
					}
				})
			],
			onShapeError: (_, metric) => shapeErrors.push(metric.key),
			onError: (error, failure) =>
				shapeErrors.push(`${failure.code}: ${(error as Error).message}`)
		})
		const [failed] = await Array.fromAsync(
			broken.run({ metrics: [{ key: 'orders.broken' }] }, {})
		)
		expect(failed).toEqual({
			key: 'orders.broken',
			requestKey: 'orders.broken',
			error: 'The metric could not be drawn',
			code: 'shape_failed',
			done: true
		})
		expect(shapeErrors).toEqual(['orders.broken', 'shape_failed: no rows in 0'])
	})

	test('lists the metrics ctx may run, and refuses duplicate keys', async () => {
		const { registry } = registryWith()
		const member = await registry.available({ role: 'member', timezone: 'UTC' })

		expect(member.map((metric) => metric.key)).not.toContain('orders.paidShare')
		expect(member).toHaveLength(orderMetrics.length - 1)
		expect(() =>
			createMetricRegistry({
				analytics: createAnalytics({
					datasets: [orders],
					sources: {
						main: { dialect: postgresDialect(), execute: async () => [] }
					},
					tenant: () => 't1'
				}),
				metrics: [orderMetrics[0], orderMetrics[0]]
			})
		).toThrow('Two metrics use the key orders.count')
	})

	test('the request schema takes known keys and dates', () => {
		const { registry } = registryWith()

		expect(
			registry.requestSchema.parse({ metrics: [{ key: 'orders.count' }] })
		).toEqual({ metrics: [{ key: 'orders.count' }], compareToPrevious: false })
		expect(
			registry.requestSchema.safeParse({ metrics: [{ key: 'orders.lost' }] })
				.success
		).toBe(false)
		expect(
			registry.requestSchema
				.extend({ refresh: registry.requestSchema.shape.compareToPrevious })
				.parse({
					metrics: [{ key: 'orders.count' }]
				}).refresh
		).toBe(false)
	})
})

describe('registry types', () => {
	test('keys, outputs and filters stay per metric', () => {
		expectTypeOf<
			MetricOutputOf<Registry, 'orders.count'>
		>().toEqualTypeOf<KpiOutput>()
		expectTypeOf<
			MetricOutputOf<Registry, 'orders.topRegions'>
		>().toEqualTypeOf<LeaderboardOutput>()
		expectTypeOf<MetricFiltersOf<Registry, 'orders.count'>>().toEqualTypeOf<{
			status?: 'OPEN' | 'PAID' | 'REFUNDED' | undefined
		}>()
		expectTypeOf<MetricKeysOfKind<Registry, 'kpi'>>().toEqualTypeOf<
			'orders.count' | 'orders.paidShare'
		>()
		expectTypeOf(
			registryWith().registry.get('orders.trend').kind
		).toEqualTypeOf<'timeseries'>()
	})

	test('a chunk narrows to its metric by key', () => {
		const chunk = {} as MetricChunk<Registry['metrics'][number]>
		if (chunk.key === 'orders.trend' && chunk.result) {
			expectTypeOf(chunk.result.current).toEqualTypeOf<TimeSeriesOutput>()
		}
		expectTypeOf(chunk.key).toEqualTypeOf<
			| 'orders.count'
			| 'orders.paidShare'
			| 'orders.trend'
			| 'orders.byStatus'
			| 'orders.topRegions'
		>()
	})

	test('an app adds its own fields', () => {
		const defineMetric = metricDefiner<
			typeof orders,
			Role,
			{ catalog?: { owner: string } }
		>()
		const metric = defineMetric({
			key: 'orders.owned',
			kind: 'kpi',
			description: '',
			supportsTimeRange: true,
			filterSchema: z.object({}),
			catalog: { owner: 'sales' },
			query: () => ({ dataset: 'orders', measures: ['orders'] }),
			shape: (result) => ({ kind: 'kpi', value: result.totals.orders })
		})
		expectTypeOf(metric.key).toEqualTypeOf<'orders.owned'>()
		expectTypeOf(metric.catalog).toEqualTypeOf<{ owner: string } | undefined>()
		// @ts-expect-error not a field of the definitions
		defineMetric({ ...metric, unknownField: true })
	})

	test('a query and a shape are checked against the dataset', () => {
		const defineMetric = metricDefiner<typeof orders, Role>()
		defineMetric({
			key: 'orders.typo',
			kind: 'kpi',
			description: '',
			supportsTimeRange: true,
			// @ts-expect-error not a role
			allowedRoles: ['admin'],
			filterSchema: orderMetrics[1].filterSchema,
			// @ts-expect-error not a measure of orders
			query: () => ({ dataset: 'orders', measures: ['refunds'] }),
			shape: () => ({ kind: 'kpi', value: 0 })
		})
		defineMetric({
			key: 'orders.wrongKind',
			kind: 'kpi',
			description: '',
			supportsTimeRange: true,
			filterSchema: orderMetrics[1].filterSchema,
			query: () => ({ dataset: 'orders', measures: ['orders'] }),
			// @ts-expect-error a kpi metric draws a kpi
			shape: () => ({ kind: 'leaderboard', items: [] })
		})
	})
})

describe('periods, resolve metrics and errors', () => {
	type Viewer = { tenantId?: string; userId: string }
	const NOW = new Date('2026-11-10T10:00:00Z')
	const defineMetric = metricDefiner<typeof orders, Role, object, Viewer>()

	const mine = defineMetric({
		key: 'orders.mine',
		kind: 'kpi',
		description: 'Orders of the customer signed in',
		supportsTimeRange: true,
		query: ({ ctx }) => ({
			dataset: 'orders',
			measures: ['orders'],
			filters: [{ dimension: 'region', op: 'in', values: [ctx.userId] }]
		}),
		shape: (result) => presentKpi(result, 'orders')
	})
	const seats = defineMetric({
		key: 'seats.used',
		kind: 'kpi',
		description: 'Seats in use, from the billing database',
		supportsTimeRange: true,
		resolve: async ({ period, tenant, ctx }) => ({
			kind: 'kpi',
			value: period?.days ?? 0,
			label: `${String(tenant)}:${ctx.userId}`
		})
	})
	const daily = defineMetric({
		key: 'orders.daily',
		kind: 'timeseries',
		description: 'Orders per day',
		supportsTimeRange: true,
		query: ({ bucket }) => ({
			dataset: 'orders',
			measures: ['orders'],
			groupBy: [bucket],
			limit: 2
		}),
		shape: (result, { bucket }) =>
			presentTimeseries(result, { bucket, measure: 'orders' })
	})

	function setup(rows: Record<string, unknown>[] = []) {
		const statements: { text: string; values: readonly unknown[] }[] = []
		const signals: AbortSignal[] = []
		const failures: [unknown, string, string][] = []
		const analytics = createAnalytics({
			datasets: [orders],
			sources: {
				main: {
					dialect: postgresDialect(),
					execute: async ({ text, values }, options) => {
						statements.push({ text, values })
						if (options?.signal) signals.push(options.signal)
						if (text.includes('"label"')) return [{ key: 'u1', label: 'u1' }]
						return text.includes('"g_') ? rows : [{ m_orders: 4 }]
					}
				}
			},
			tenant: (ctx: Viewer) => ctx.tenantId,
			timezone: () => 'Europe/Copenhagen',
			now: () => NOW
		})
		const registry = createMetricRegistry({
			analytics,
			metrics: [mine, seats, daily] as const,
			onError: (error, failure) =>
				failures.push([error, failure.code, failure.requestKey])
		})
		return { registry, statements, signals, failures }
	}
	const viewer: Viewer = { tenantId: 't1', userId: 'u1' }

	test('a request names its period in local days, and each result echoes it', async () => {
		const { registry } = setup()
		const { results } = await registry.collect(
			{
				metrics: [{ key: 'orders.mine' }, { key: 'seats.used' }],
				period: { last: { days: 7 } }
			},
			viewer
		)

		const period = {
			from: '2026-11-04',
			to: '2026-11-10',
			timezone: 'Europe/Copenhagen'
		}
		expect(results['orders.mine']?.period).toEqual(period)
		expect(results['seats.used']).toEqual({
			current: { kind: 'kpi', value: 7, label: 't1:u1' },
			supportsTimeRange: true,
			period
		})
	})

	test('from without to counts up to today; to without from, or both forms, is refused', async () => {
		const { registry } = setup()
		const result = await registry.one(
			'seats.used',
			{ from: new Date('2026-11-01T12:00:00Z') },
			viewer
		)
		expect(result.period).toEqual({
			from: '2026-11-01',
			to: '2026-11-10',
			timezone: 'Europe/Copenhagen'
		})

		await expect(
			registry.one('seats.used', { to: NOW }, viewer)
		).rejects.toMatchObject({ code: 'invalid_period' })
		await expect(
			registry.one(
				'seats.used',
				{ from: NOW, period: { last: { days: 7 } } },
				viewer
			)
		).rejects.toMatchObject({ code: 'invalid_period' })
	})

	test('a resolve metric gets its previous period and the tenant from ctx', async () => {
		const { registry } = setup()
		const result = await registry.one(
			'seats.used',
			{
				period: { from: '2026-11-01', to: '2026-11-03' },
				compareToPrevious: true
			},
			viewer
		)

		expect(result.current.value).toBe(3)
		expect(result.previous).toEqual({ kind: 'kpi', value: 3, label: 't1:u1' })

		const { registry: scoped, failures } = setup()
		await expect(
			scoped.one('seats.used', {}, { userId: 'u1' })
		).rejects.toMatchObject({ code: 'missing_tenant' })
		expect(failures.map(([, code]) => code)).toEqual(['missing_tenant'])
	})

	test('a query gets ctx, and the tenant scope still applies', async () => {
		const { registry, statements } = setup()
		await registry.one('orders.mine', {}, viewer)

		const query = statements.at(-1)
		expect(query?.values).toContain('t1')
		expect(query?.values).toContain('u1')
	})

	test('every failure has a code, and onError hears each one', async () => {
		const { registry, failures } = setup()
		const { errors } = await registry.collect(
			{
				metrics: [
					{ key: 'orders.lost' as never },
					{ key: 'seats.used', requestKey: 'bad', filters: 'x' }
				]
			},
			viewer
		)

		expect(errors).toEqual({
			'orders.lost': { code: 'unknown_metric', message: 'Unknown metric' },
			bad: {
				code: 'invalid_filters',
				message: expect.stringContaining('Invalid filters')
			}
		})
		expect(
			failures.map(([error, code]) => [code, error instanceof MetricError])
		).toEqual([
			['unknown_metric', true],
			['invalid_filters', true]
		])
	})

	test('a time series cut at its limit fails instead of drawing zeros', async () => {
		const { registry } = setup([
			{ g_day: '2026-11-08', m_orders: 1 },
			{ g_day: '2026-11-09', m_orders: 1 },
			{ g_day: '2026-11-10', m_orders: 1 }
		])

		await expect(
			registry.one('orders.daily', { period: { last: { days: 3 } } }, viewer)
		).rejects.toMatchObject({ code: 'truncated' })
	})

	test('collect and one are typed per metric', async () => {
		const { registry } = setup()
		const { results } = await registry.collect(
			{ metrics: [{ key: 'orders.daily' }] },
			viewer
		)
		expectTypeOf(results['orders.daily']).toEqualTypeOf<
			MetricResult<TimeSeriesOutput> | undefined
		>()
		const one = await registry.one('seats.used', {}, viewer)
		expectTypeOf(one.current).toEqualTypeOf<{
			kind: 'kpi'
			value: number
			label: string
		}>()
	})

	test('a consumer that stops reading aborts the statements', async () => {
		const { registry, signals } = setup()
		for await (const chunk of registry.run(
			{
				metrics: [
					{ key: 'orders.mine' },
					{ key: 'orders.mine', requestKey: 'again' }
				]
			},
			viewer
		)) {
			expect(chunk.error).toBeUndefined()
			break
		}

		expect(signals.length).toBeGreaterThan(0)
		expect(signals.every((signal) => signal.aborted)).toBe(true)
	})

	test('a run with an aborted signal rejects with its reason', async () => {
		const { registry } = setup()
		const controller = new AbortController()
		controller.abort(new Error('closed'))

		await expect(
			registry.collect({ metrics: [{ key: 'seats.used' }] }, viewer, {
				signal: controller.signal
			})
		).rejects.toThrow('closed')
	})
})

describe('previous-period alignment', () => {
	test('weeks pair from the end, and a series only in the previous period gets current buckets', async () => {
		const analytics = createAnalytics({
			datasets: [orders],
			sources: {
				main: {
					dialect: postgresDialect(),
					execute: async ({ text, values }) => {
						if (!text.includes('"g_week"')) return [{ m_orders: 1 }]
						// The previous period (2026-09-16 to 2026-09-30) spans three ISO weeks.
						return values.includes('2026-09-15T22:00:00.000Z')
							? [
									{ g_week: '2026-09-14', g_status: 'OPEN', m_orders: 1 },
									{ g_week: '2026-09-21', g_status: 'OPEN', m_orders: 2 },
									{ g_week: '2026-09-28', g_status: 'OPEN', m_orders: 3 }
								]
							: [{ g_week: '2026-10-05', g_status: 'PAID', m_orders: 5 }]
					}
				}
			},
			tenant: () => 't1',
			timezone: () => 'Europe/Copenhagen'
		})
		const registry = createMetricRegistry({
			analytics,
			metrics: [orderMetrics[2]] as const
		})

		const result = await registry.one(
			'orders.trend',
			{
				period: { from: '2026-10-01', to: '2026-10-15' },
				granularity: 'week',
				compareToPrevious: true,
				filters: { byStatus: true }
			},
			{}
		)

		const buckets = result.current.series[0]?.points.map(
			(point) => point.bucket
		)
		expect(buckets).toEqual(['2026-09-28', '2026-10-05', '2026-10-12'])
		const previous = result.previous?.series[0]
		expect(previous?.key).toBe('OPEN')
		expect(
			previous?.points.map((point) => [point.bucket, point.value])
		).toEqual([
			['2026-09-28', 1],
			['2026-10-05', 2],
			['2026-10-12', 3]
		])
	})
})

describe('output schemas', () => {
	test('every presented output parses, also back from JSON', async () => {
		const { registry } = registryWith()
		const { results } = await registry.collect(
			{
				metrics: registry.keys.map((key) => ({ key })),
				...week,
				compareToPrevious: true
			},
			owner
		)

		for (const result of Object.values(results)) {
			if (!result) continue
			const json = JSON.parse(JSON.stringify(result))
			expect(MetricResultSchema.parse(json)).toEqual(result)
			expect(
				metricOutputSchemas[result.current.kind].parse(json.current)
			).toEqual(result.current)
		}
		expect(MetricOutputSchema.safeParse({ kind: 'gauge' }).success).toBe(false)
	})
})

test('the metric contract kit runs every metric of a registry', async () => {
	const { registry } = registryWith()
	expect((await checkMetricContract({ registry, ctx: owner })).ok).toBe(true)

	const report = await checkMetricContract({
		registry,
		ctx: { role: 'member', timezone: TIMEZONE }
	})
	expect(report.checks.filter((check) => !check.ok)).toEqual([
		{
			name: 'metric orders.paidShare',
			ok: false,
			message: 'forbidden: Access denied'
		}
	])
	await expect(
		assertMetricContract({
			registry,
			ctx: { role: 'member', timezone: TIMEZONE }
		})
	).rejects.toThrow('orders.paidShare')
})
