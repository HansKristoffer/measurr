/**
 * The row source: statements evaluated in JavaScript over rows a function loads. Its answers
 * are checked against Postgres for the same rows when ANALYTICS_TEST_DATABASE_URL is set.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { SQL } from 'bun'
import { postgresDialect } from './dialects/postgres.js'
import {
	type Maintenance,
	type Order,
	type OrderTag,
	type Refund,
	type Region,
	type RegionId,
	type Tag,
	maintenance,
	orders,
	sales
} from './fixtures/orders.js'
import { queryBatch } from './handler.js'
import {
	type AnalyticsSource,
	allTenants,
	createAnalytics,
	defineDataset,
	dimension,
	eq,
	exists,
	measure,
	table
} from './index.js'
import { type RowRequest, memorySource, rowSource } from './rows.js'
import { assertDatasetContract } from './testing.js'

const NOW = new Date('2026-10-07T10:00:00Z')
const DAY_MS = 86_400_000

type Tables = {
	orders: Omit<Order, 'metadata'>[]
	regions: Region[]
	tags: Tag[]
	order_tags: OrderTag[]
	refunds: Refund[]
	maintenance: Maintenance[]
}

/** A few hundred orders of two tenants over 100 days, the same on every run. */
function seed(): Tables {
	let state = 7
	const random = () => {
		state = (state * 1_664_525 + 1_013_904_223) % 4_294_967_296
		return state / 4_294_967_296
	}
	const below = (max: number) => Math.floor(random() * max)
	const pick = <T>(items: readonly T[]) => items[below(items.length)] as T

	const regions: Region[] = [
		{ id: 'north' as RegionId, tenantId: 'A', name: 'North' },
		{ id: 'south' as RegionId, tenantId: 'A', name: 'South' },
		{ id: 'west' as RegionId, tenantId: 'A', name: 'West' },
		{ id: 'east' as RegionId, tenantId: 'B', name: 'East' }
	]
	const tags: Tag[] = [
		{ id: 'complaint', tenantId: 'A', name: 'Complaint' },
		{ id: 'billing', tenantId: 'A', name: 'Billing' },
		{ id: 'vip', tenantId: 'A', name: 'Vip' },
		{ id: 'other', tenantId: 'B', name: 'Complaint' }
	]
	const tables: Tables = {
		orders: [],
		regions,
		tags,
		order_tags: [],
		refunds: [],
		maintenance: [
			{
				id: 'm1',
				kind: 'REPAIR',
				technician: 'Kim',
				cost: 300,
				createdAt: new Date('2026-10-01T09:00:00Z')
			},
			{
				id: 'm2',
				kind: 'REPAIR',
				technician: null,
				cost: 100,
				createdAt: new Date('2026-10-02T09:00:00Z')
			},
			{
				id: 'm3',
				kind: 'SERVICE',
				technician: 'Kim',
				cost: 50,
				createdAt: new Date('2026-09-15T09:00:00Z')
			}
		]
	}

	for (let n = 0; n < 320; n++) {
		const tenantId = n % 5 === 0 ? 'B' : 'A'
		const amount = below(200) * 10
		const createdAt = new Date(NOW.getTime() - below(100 * 86_400) * 1000)
		const id = `o${n}`
		tables.orders.push({
			id,
			tenantId,
			customerId: `c${below(40)}`,
			status: pick(['OPEN', 'PAID', 'PAID', 'REFUNDED']),
			amount,
			cost: amount / 2,
			rating: random() < 0.25 ? null : 1 + below(5),
			regionId:
				random() < 0.2
					? null
					: pick(regions.filter((region) => region.tenantId === tenantId)).id,
			isTest: random() < 0.05,
			createdAt,
			shippedAt:
				random() < 0.3
					? null
					: new Date(createdAt.getTime() + below(3 * 86_400) * 1000)
		})
		for (const tag of tags) {
			if (tag.tenantId === tenantId && random() < 0.3)
				tables.order_tags.push({ orderId: id, tagId: tag.id })
		}
		if (random() < 0.15) {
			tables.refunds.push({ id: `r${n}`, orderId: id, createdAt: NOW })
		}
	}
	return tables
}

const tables = seed()
const analyticsOn = (source: AnalyticsSource, timezone = 'UTC') =>
	createAnalytics({
		datasets: [orders],
		sources: { main: source },
		tenant: (ctx: { tenantId: string | readonly string[] }) => ctx.tenantId,
		timezone: () => timezone,
		now: () => NOW
	})
const tenantA = { tenantId: 'A' }

/** The seeded orders a query for tenant A counts, in JavaScript. */
const ordersOfA = (from: Date, to = new Date(NOW.getTime() + DAY_MS)) =>
	tables.orders.filter(
		(order) =>
			order.tenantId === 'A' &&
			!order.isTest &&
			order.createdAt >= from &&
			order.createdAt < to
	)

describe('a source over rows in memory', () => {
	const analytics = analyticsOn(memorySource(tables))
	const october = { from: '2026-10-01', to: '2026-10-07' } as const
	const inOctober = ordersOfA(new Date('2026-10-01T00:00:00Z'))

	test('rows are checked against the row types it is given', () => {
		const typeOnly = () => {
			memorySource<{ orders: Order; regions: Region }>({
				orders: [{ id: 'o1', tenantId: 'A', amount: 120, createdAt: NOW }],
				regions: []
			})
			memorySource<{ orders: Order }>({
				// @ts-expect-error misspelt column
				orders: [{ id: 'o1', tenantID: 'A' }]
			})
			memorySource<{ orders: Order }>({
				// @ts-expect-error an amount is a number
				orders: [{ id: 'o1', amount: '120' }]
			})
			// Without row types, rows are as an API returns them.
			memorySource({ orders: [{ id: 'o1', amount: '120' }] })
		}
		void typeOnly
	})

	test('counts, sums and medians what the rows hold', async () => {
		const { totals } = await analytics.query(
			{
				dataset: 'orders',
				measures: ['orders', 'revenue', 'customers', 'medianAmount'],
				period: october
			},
			tenantA
		)
		const amounts = inOctober.map((order) => order.amount).sort((a, b) => a - b)
		const middle = (amounts.length - 1) / 2

		expect(inOctober.length).toBeGreaterThan(10)
		expect(totals).toEqual({
			orders: inOctober.length,
			revenue: amounts.reduce((sum, amount) => sum + amount, 0),
			customers: new Set(inOctober.map((order) => order.customerId)).size,
			medianAmount:
				((amounts[Math.floor(middle)] ?? 0) +
					(amounts[Math.ceil(middle)] ?? 0)) /
				2
		})
	})

	test('joins, subqueries and many-to-many links', async () => {
		const refunded = new Set(tables.refunds.map((refund) => refund.orderId))
		const tagged = new Set(
			tables.order_tags
				.filter((link) => link.tagId === 'complaint')
				.map((link) => link.orderId)
		)

		const byRegion = await analytics.query(
			{
				dataset: 'orders',
				measures: ['orders', 'refunded'],
				groupBy: ['region'],
				filters: [{ dimension: 'tag', op: 'in', values: ['Complaint'] }],
				period: october
			},
			tenantA
		)

		const complaints = inOctober.filter((order) => tagged.has(order.id))
		const north = complaints.filter((order) => order.regionId === 'north')
		expect(byRegion.totals).toEqual({
			orders: complaints.length,
			refunded: complaints.filter((order) => refunded.has(order.id)).length
		})
		expect(byRegion.rows.find((row) => row.region.key === 'north')).toEqual({
			region: { key: 'north' as RegionId, label: 'North' },
			orders: north.length,
			refunded: north.filter((order) => refunded.has(order.id)).length
		})
		expect(byRegion.rows.some((row) => row.region.label === 'No region')).toBe(
			complaints.some((order) => order.regionId === null)
		)
	})

	test('buckets by the day of the timezone', async () => {
		const result = await analyticsOn(
			memorySource(tables),
			'Pacific/Auckland'
		).query(
			{
				dataset: 'orders',
				measures: ['orders'],
				groupBy: ['day'],
				period: { from: '2026-10-02', to: '2026-10-02' }
			},
			tenantA
		)
		// 2 October in Auckland runs from 11:00 UTC on the 1st to 11:00 UTC on the 2nd.
		const thatDay = ordersOfA(
			new Date('2026-10-01T11:00:00Z'),
			new Date('2026-10-02T11:00:00Z')
		)

		expect(result.rows).toEqual([
			{
				day: { key: '2026-10-02', label: '2026-10-02' },
				orders: thatDay.length
			}
		])
	})

	test('an unknown label lists the values that exist', async () => {
		await expect(
			analytics.query(
				{
					dataset: 'orders',
					measures: ['orders'],
					filters: [{ dimension: 'region', op: 'in', values: ['Nowhere'] }]
				},
				tenantA
			)
		).rejects.toMatchObject({
			code: 'unknown_value',
			details: {
				valid: [
					{ key: 'north', label: 'North' },
					{ key: 'south', label: 'South' },
					{ key: 'west', label: 'West' }
				]
			}
		})
	})

	test('explain shows the statement as SQL', async () => {
		const [statement] = await analytics.explain(
			{ dataset: 'orders', measures: ['orders'] },
			tenantA
		)

		expect(statement?.text).toStartWith('SELECT count(*) AS "m_orders"')
	})

	test('the dataset contract holds without a database', async () => {
		const source = memorySource(tables)

		await assertDatasetContract({
			dataset: orders,
			source,
			tenant: 'A',
			now: () => NOW
		})
		await assertDatasetContract({
			dataset: sales,
			source,
			tenant: 'A',
			now: () => NOW
		})
		await assertDatasetContract({
			dataset: maintenance,
			source,
			tenant: allTenants,
			now: () => NOW
		})
	})
})

describe('a source over an API', () => {
	function recording() {
		const requests: RowRequest[] = []
		const source = rowSource({
			load: async (request) => {
				requests.push(request)
				// As an API would: it applies the equality filters and ignores the rest.
				return (tables[request.table as keyof Tables] as object[]).filter(
					(row) =>
						request.filters.every(
							(filter) =>
								filter.op !== '=' ||
								(row as Record<string, unknown>)[filter.column] === filter.value
						)
				) as Record<string, unknown>[]
			}
		})
		return { requests, analytics: analyticsOn(source) }
	}

	test('the tenant, the scope, the period and plain filters reach the loader', async () => {
		const { analytics, requests } = recording()

		await analytics.query(
			{
				dataset: 'orders',
				measures: ['orders'],
				filters: [{ dimension: 'status', op: 'in', values: ['PAID'] }],
				period: { from: '2026-10-01', to: '2026-10-07' }
			},
			tenantA
		)

		expect(requests).toEqual([
			{
				table: 'orders',
				columns: ['tenantId', 'isTest', 'createdAt', 'status'],
				filters: [
					{ column: 'tenantId', op: '=', value: 'A' },
					{ column: 'isTest', op: '=', value: false },
					{
						column: 'createdAt',
						op: '>=',
						value: new Date('2026-10-01T00:00:00Z')
					},
					{
						column: 'createdAt',
						op: '<',
						value: new Date('2026-10-08T00:00:00Z')
					},
					{ column: 'status', op: 'in', values: ['PAID'] }
				],
				signal: expect.any(AbortSignal)
			}
		])
	})

	test('a joined table is asked only for the rows the others refer to', async () => {
		const { analytics, requests } = recording()

		const result = await analytics.query(
			{
				dataset: 'orders',
				measures: ['refunded'],
				groupBy: ['region'],
				period: { from: '2026-10-06', to: '2026-10-07' },
				totals: false
			},
			tenantA
		)

		const [fromOrders, fromRegions, fromRefunds] = requests
		const loaded = tables.orders.filter(
			(order) => order.tenantId === 'A' && !order.isTest
		)
		expect(requests.map((request) => request.table)).toEqual([
			'orders',
			'regions',
			'refunds'
		])
		expect(fromOrders?.columns).toContain('regionId')
		expect(fromRegions?.filters).toEqual([
			{
				column: 'id',
				op: 'in',
				values: [
					...new Set(
						loaded.flatMap((order) => (order.regionId ? [order.regionId] : []))
					)
				]
			}
		])
		expect(fromRefunds?.filters).toEqual([
			{ column: 'orderId', op: 'in', values: loaded.map((order) => order.id) }
		])
		expect(result.rows.length).toBeGreaterThan(0)
	})

	test('a query for its rows and its totals loads the table once', async () => {
		const { analytics, requests } = recording()

		await analytics.query(
			{ dataset: 'orders', measures: ['orders'], groupBy: ['status'] },
			tenantA
		)

		expect(requests.map((request) => request.table)).toEqual(['orders'])
	})

	test('the queries of a batch that count the same rows load them once', async () => {
		const { analytics, requests } = recording()

		const { results } = await queryBatch(
			analytics,
			{
				orders: { dataset: 'orders', measures: ['orders'] },
				revenue: { dataset: 'orders', measures: ['revenue'] },
				paid: { dataset: 'orders', measures: ['paidShare'] }
			},
			tenantA
		)

		expect(requests.map((request) => request.table)).toEqual(['orders'])
		expect(results.orders?.totals.orders).toBe(
			ordersOfA(new Date('2026-09-08T00:00:00Z')).length
		)
	})

	test('an empty tenant list asks the API for nothing', async () => {
		const { analytics, requests } = recording()

		const result = await analytics.query(
			{ dataset: 'orders', measures: ['orders', 'revenue'] },
			{ tenantId: [] }
		)

		expect(requests).toEqual([])
		expect(result.totals).toEqual({ orders: 0, revenue: null })
	})

	test('a loader that ignores the tenant cannot widen a query', async () => {
		const leaky = analyticsOn(rowSource({ load: () => tables.orders }))

		const { totals } = await leaky.query(
			{ dataset: 'orders', measures: ['orders'], period: { all: true } },
			tenantA
		)

		expect(totals.orders).toBe(
			tables.orders.filter((order) => order.tenantId === 'A' && !order.isTest)
				.length
		)
	})

	test('values as an API returns them: text for numbers, dates and booleans', async () => {
		type Deal = {
			id: string
			portalId: string
			amount: number
			closed: boolean
			stage: 'won' | 'lost'
			closedAt: Date
		}
		const deal = table<Deal>('deals')
		const deals = defineDataset({
			key: 'deals',
			label: 'Deals',
			description: 'One row per deal.',
			from: deal,
			tenantColumn: deal.col('portalId'),
			scope: eq(deal.col('closed'), true),
			time: { closed: { column: deal.col('closedAt'), label: 'Closed' } },
			measures: {
				deals: measure.count({ label: 'Deals' }),
				value: measure.sum(deal.col('amount'), { label: 'Value' }),
				winRate: measure.share({
					label: 'Win rate',
					numerator: eq(deal.col('stage'), 'won')
				})
			},
			dimensions: {
				stage: dimension.enum(deal.col('stage'), {
					label: 'Stage',
					labels: { won: 'Won', lost: 'Lost' }
				}),
				month: dimension.timeBucket('closed', 'month')
			}
		})
		const analytics = createAnalytics({
			datasets: [deals],
			sources: {
				crm: rowSource({
					load: ({ filters }) => {
						const portal = filters.find(
							(filter) => filter.column === 'portalId'
						)
						const portalId = portal?.op === '=' ? portal.value : null
						return [
							{
								id: '1',
								portalId,
								amount: '1200.50',
								closed: 'true',
								stage: 'won',
								closedAt: '2026-09-30T22:30:00Z'
							},
							{
								id: '2',
								portalId,
								amount: '300',
								closed: 'true',
								stage: 'lost',
								closedAt: '1790899200000'
							},
							{
								id: '3',
								portalId,
								amount: '99',
								closed: 'false',
								stage: 'won',
								closedAt: '2026-10-03 08:00:00'
							}
						]
					}
				})
			},
			tenant: () => 'portal-1',
			timezone: () => 'Europe/Copenhagen',
			now: () => NOW
		})

		const result = await analytics.query(
			{
				dataset: 'deals',
				measures: ['deals', 'value', 'winRate'],
				groupBy: ['month'],
				period: { last: { days: 30 } }
			},
			{}
		)

		expect(result.totals as Record<string, unknown>).toEqual({
			deals: 2,
			value: 1500.5,
			winRate: 0.5
		})
		// 22:30 UTC on 30 September is already 1 October in Copenhagen.
		expect(result.rows.map((row) => [row.month.key, row.deals])).toEqual([
			['2026-10-01', 2]
		])
	})

	test('what the source cannot run fails when the app starts', () => {
		const order = table<Order>('orders')
		const refund = table<Refund>('refunds')
		const refundedRegion = order.leftJoin(table<Region>('regions'), (region) =>
			exists(refund, eq(refund.col('orderId'), region.col('id')))
		)
		const broken = defineDataset({
			key: 'broken',
			label: 'Broken',
			description: 'Joins on a subquery.',
			from: order,
			tenantColumn: order.col('tenantId'),
			time: { created: { column: order.col('createdAt'), label: 'Created' } },
			measures: { orders: measure.count({ label: 'Orders' }) },
			dimensions: {
				region: dimension.relation({
					label: 'Region',
					key: refundedRegion.col('id'),
					name: refundedRegion.col('name')
				})
			}
		})

		expect(() =>
			createAnalytics({
				datasets: [broken],
				sources: { main: memorySource({}) },
				tenant: () => 'A'
			})
		).toThrow('cannot run exists() inside the join condition of regions')
	})
})

const url = process.env.ANALYTICS_TEST_DATABASE_URL

describe.skipIf(!url)('the row source against Postgres', () => {
	// One connection, so the search path set on it holds for every statement.
	const sql = new SQL(url ?? '', { max: 1 })
	const postgres: AnalyticsSource = {
		dialect: postgresDialect({ timestamps: 'utc' }),
		execute: ({ text, values }) =>
			sql.unsafe(text, [...values]) as Promise<Record<string, unknown>[]>
	}
	const stamp = (date: Date | null) =>
		date ? date.toISOString().replace('T', ' ').replace('Z', '') : null

	beforeAll(async () => {
		await sql.unsafe(`
			DROP SCHEMA IF EXISTS measurr_rows CASCADE;
			CREATE SCHEMA measurr_rows;
			SET search_path TO measurr_rows;
			CREATE TABLE regions ("id" text PRIMARY KEY, "tenantId" text NOT NULL, "name" text NOT NULL);
			CREATE TABLE tags ("id" text PRIMARY KEY, "tenantId" text NOT NULL, "name" text NOT NULL);
			CREATE TABLE orders ("id" text PRIMARY KEY, "tenantId" text NOT NULL, "customerId" text NOT NULL, "status" text NOT NULL, "amount" integer NOT NULL, "cost" integer NOT NULL, "rating" integer, "regionId" text, "isTest" boolean NOT NULL, "createdAt" timestamp(3) NOT NULL, "shippedAt" timestamp(3));
			CREATE TABLE order_tags ("orderId" text, "tagId" text);
			CREATE TABLE refunds ("id" text PRIMARY KEY, "orderId" text, "createdAt" timestamp(3) NOT NULL);
		`)
		const insert = async (name: string, rows: readonly object[]) => {
			for (const row of rows) {
				const values = Object.values(row).map((value) =>
					value instanceof Date ? stamp(value) : value
				)
				const columns = Object.keys(row).map((column) => `"${column}"`)
				const places = values.map((_, index) => `$${index + 1}`)
				await sql.unsafe(
					`INSERT INTO ${name} (${columns.join(', ')}) VALUES (${places.join(', ')})`,
					values
				)
			}
		}
		await insert('regions', tables.regions)
		await insert('tags', tables.tags)
		await insert('orders', tables.orders)
		await insert('order_tags', tables.order_tags)
		await insert('refunds', tables.refunds)
	})

	afterAll(async () => {
		await sql.unsafe('DROP SCHEMA IF EXISTS measurr_rows CASCADE')
		await sql.close()
	})

	/** Numbers to ten significant digits: an average is a decimal there and a float here. */
	const rounded = (value: unknown): unknown => {
		if (typeof value === 'number') return Number(value.toPrecision(10))
		if (Array.isArray(value)) return value.map(rounded)
		if (typeof value !== 'object' || value === null) return value
		return Object.fromEntries(
			Object.entries(value).map(([key, inner]) => [key, rounded(inner)])
		)
	}
	const answer = (source: AnalyticsSource, timezone: string, query: object) =>
		analyticsOn(source, timezone)
			.query(query as never, tenantA)
			.then(rounded, (error: { code?: string; details?: unknown }) => ({
				failed: error.code ?? String(error),
				details: error.details
			}))
	const same = async (query: object, timezone = 'UTC') => {
		const [fromRows, fromPostgres] = await Promise.all([
			answer(memorySource(tables), timezone, query),
			answer(postgres, timezone, query)
		])
		expect(fromRows, JSON.stringify(query)).toEqual(fromPostgres)
		// Two refusals are equal too: only the unknown label may be one.
		const refused = typeof fromRows === 'object' && 'failed' in (fromRows ?? {})
		expect(refused, JSON.stringify(query)).toBe(
			JSON.stringify(query).includes('Nowhere')
		)
		return fromRows as { rows: unknown[] }
	}

	const MEASURES = [
		['orders', 'customers', 'revenue', 'averageAmount'],
		['medianAmount', 'averageRating', 'refunded', 'paidShare'],
		['refundRate', 'orders']
	]
	const GROUPINGS = [
		[],
		['status'],
		['region'],
		['tag'],
		['size'],
		['rating'],
		['day'],
		['week'],
		['month'],
		['weekday'],
		['hour'],
		['status', 'region'],
		['week', 'size'],
		['weekday', 'hour'],
		['tag', 'status'],
		['month', 'region']
	]
	const FILTERS = [
		{ dimension: 'status', op: 'in', values: ['PAID'] },
		{ dimension: 'status', op: 'notIn', values: ['OPEN', 'REFUNDED'] },
		{ dimension: 'region', op: 'isEmpty' },
		{ dimension: 'region', op: 'isNotEmpty' },
		{ dimension: 'region', op: 'in', values: ['North', 'south'] },
		{ dimension: 'region', op: 'notIn', values: ['north'] },
		{ dimension: 'region', op: 'in', values: ['Nowhere'] },
		{ dimension: 'tag', op: 'in', values: ['Complaint'] },
		{ dimension: 'tag', op: 'notIn', values: ['billing', 'Vip'] },
		{ dimension: 'tag', op: 'isEmpty' },
		{ dimension: 'tag', op: 'isNotEmpty' },
		{ dimension: 'size', op: 'in', values: ['large'] },
		{ dimension: 'size', op: 'notIn', values: ['small'] },
		{ dimension: 'rating', op: 'between', from: 2, to: 4 },
		{ dimension: 'rating', op: 'isEmpty' },
		{ dimension: 'day', op: 'between', from: '2026-09-10', to: '2026-09-25' },
		{ dimension: 'week', op: 'between', from: '2026-09-07', to: '2026-09-21' },
		{ dimension: 'weekday', op: 'between', from: 6, to: 7 },
		{ dimension: 'hour', op: 'between', from: 8, to: 17 }
	]

	for (const timezone of ['UTC', 'Pacific/Auckland', 'America/New_York']) {
		test(`every measure by every grouping, in ${timezone}`, async () => {
			let rows = 0
			for (const measures of MEASURES) {
				for (const groupBy of GROUPINGS) {
					const result = await same(
						{
							dataset: 'orders',
							measures,
							groupBy,
							period: { last: { days: 60 } },
							compareToPrevious: true,
							limit: 100
						},
						timezone
					)
					rows += result.rows.length
				}
			}
			expect(rows).toBeGreaterThan(500)
		})
	}

	test('every kind of filter', async () => {
		for (const filter of FILTERS) {
			for (const groupBy of [[], ['status'], ['tag']]) {
				await same(
					{
						dataset: 'orders',
						measures: ['orders', 'revenue', 'paidShare', 'medianAmount'],
						groupBy,
						filters: [filter, { dimension: 'hour', op: 'isNotEmpty' }],
						period: { last: { days: 90 } }
					},
					'Pacific/Auckland'
				)
			}
		}
	})

	test('periods, time fields, sorting and limits', async () => {
		const byWeek = {
			dataset: 'orders',
			measures: ['orders', 'revenue'],
			groupBy: ['week']
		}
		const queries = [
			{ ...byWeek, period: { all: true } },
			{ ...byWeek, period: { preset: 'thisMonth' }, compareToPrevious: true },
			{
				...byWeek,
				period: { from: '2026-08-01', to: '2026-09-15' },
				time: 'shipped'
			},
			{ ...byWeek, sort: { by: 'revenue', direction: 'asc' }, limit: 3 },
			{ ...byWeek, sort: { by: 'week', direction: 'desc' }, limit: 5 },
			{ ...byWeek, totals: false, compareToPrevious: true },
			{
				dataset: 'orders',
				measures: ['orders'],
				groupBy: ['region', 'tag'],
				limit: 4
			},
			{
				dataset: 'orders',
				measures: ['averageRating'],
				groupBy: ['rating'],
				sort: { by: 'rating', direction: 'desc' }
			},
			{
				dataset: 'orders',
				measures: ['customers'],
				groupBy: ['hour'],
				sort: { by: 'customers' },
				limit: 7
			}
		]

		for (const query of queries) await same(query, 'America/New_York')
	})
})
