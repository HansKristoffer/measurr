/**
 * Runs the example dataset against a real Postgres. Set ANALYTICS_TEST_DATABASE_URL to a
 * throwaway database (it creates and drops its own tables), for example:
 *
 *   ANALYTICS_TEST_DATABASE_URL=postgres://postgres:postgres@localhost:5432/postgres bun test
 *
 * Not DATABASE_URL: Bun loads `.env` files, and that name may point at a real database.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { SQL } from 'bun'
import {
	AnalyticsError,
	AnalyticsResultSchema,
	allTenants,
	createAnalytics
} from './index.js'
import { postgresDialect } from './dialects/postgres.js'
import {
	type RegionId,
	maintenance,
	orderBook,
	orders,
	sales
} from './fixtures/orders.js'
import { assertDatasetContract } from './testing.js'

const url = process.env.ANALYTICS_TEST_DATABASE_URL
const NOW = new Date('2026-10-07T10:00:00Z')

const SCHEMA = `
DROP TABLE IF EXISTS refunds, order_tags, tags, orders, regions, maintenance;
CREATE TABLE regions ("id" text PRIMARY KEY, "tenantId" text NOT NULL, "name" text NOT NULL);
CREATE TABLE tags ("id" text PRIMARY KEY, "tenantId" text NOT NULL, "name" text NOT NULL);
CREATE TABLE orders (
	"id" text PRIMARY KEY,
	"tenantId" text NOT NULL,
	"customerId" text NOT NULL,
	"status" text NOT NULL,
	"amount" integer NOT NULL,
	"cost" integer NOT NULL DEFAULT 0,
	"rating" integer,
	"regionId" text REFERENCES regions,
	"isTest" boolean NOT NULL DEFAULT false,
	"createdAt" timestamp(3) NOT NULL,
	"shippedAt" timestamp(3),
	"metadata" jsonb
);
CREATE TABLE order_tags ("orderId" text REFERENCES orders, "tagId" text REFERENCES tags);
CREATE TABLE refunds ("id" text PRIMARY KEY, "orderId" text REFERENCES orders, "createdAt" timestamp(3) NOT NULL);
CREATE TABLE maintenance (
	"id" text PRIMARY KEY,
	"kind" text NOT NULL,
	"technician" text,
	"cost" integer NOT NULL,
	"createdAt" timestamp(3) NOT NULL
);
`

type SeedOrder = [
	id: string,
	tenant: string,
	customer: string,
	status: string,
	amount: number,
	rating: number | null,
	region: string | null,
	createdAt: string,
	isTest?: boolean
]

// Timestamps are UTC, stored without a zone the way Prisma stores DateTime.
const ORDERS: SeedOrder[] = [
	// 00:30 on 2 October in Auckland, still 1 October in UTC.
	['o1', 'A', 'c1', 'PAID', 50, 5, 'north', '2026-10-01 11:30:00'],
	['o2', 'A', 'c1', 'PAID', 150, 4, 'north', '2026-10-02 08:00:00'],
	['o3', 'A', 'c2', 'OPEN', 1500, null, null, '2026-10-03 23:30:00'],
	['o4', 'A', 'c3', 'REFUNDED', 200, 2, 'south', '2026-09-20 12:00:00'],
	// In the previous 30 days.
	['o5', 'A', 'c4', 'PAID', 80, 3, 'south', '2026-08-20 12:00:00'],
	// A test order, excluded by the scope.
	['o6', 'A', 'c1', 'PAID', 999, 5, 'north', '2026-10-04 10:00:00', true],
	// Another tenant.
	['b1', 'B', 'c9', 'PAID', 70, 1, 'east', '2026-10-02 08:00:00'],
	['b2', 'B', 'c9', 'OPEN', 70, 1, 'east', '2026-10-02 09:00:00']
]

describe.skipIf(!url)('postgres integration', () => {
	const sql = new SQL(url ?? '')
	const source = {
		dialect: postgresDialect({ timestamps: 'utc' }),
		execute: ({ text, values }: { text: string; values: readonly unknown[] }) =>
			sql.unsafe(text, [...values]) as Promise<Record<string, unknown>[]>
	}
	const analyticsIn = (timezone: string) =>
		createAnalytics({
			datasets: [orders, orderBook],
			sources: { main: source },
			tenant: (ctx: { tenantId: string | readonly string[] }) => ctx.tenantId,
			timezone: () => timezone,
			now: () => NOW
		})
	const analytics = analyticsIn('UTC')
	const tenantA = { tenantId: 'A' }

	beforeAll(async () => {
		await sql.unsafe(SCHEMA)
		await sql.unsafe(
			`INSERT INTO regions VALUES ('north','A','North'),('south','A','South'),('east','B','East')`
		)
		await sql.unsafe(
			`INSERT INTO tags VALUES ('complaint','A','Complaint'),('billing','A','Billing'),('other','B','Complaint')`
		)
		for (const [
			id,
			tenant,
			customer,
			status,
			amount,
			rating,
			region,
			createdAt,
			isTest
		] of ORDERS) {
			await sql.unsafe(
				`INSERT INTO orders ("id","tenantId","customerId","status","amount","rating","regionId","isTest","createdAt","shippedAt") VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$9)`,
				[
					id,
					tenant,
					customer,
					status,
					amount,
					rating,
					region,
					isTest ?? false,
					createdAt
				]
			)
		}
		await sql.unsafe(
			`INSERT INTO order_tags VALUES ('o1','complaint'),('o1','billing'),('o2','complaint'),('o4','billing'),('b1','other')`
		)
		await sql.unsafe(
			`INSERT INTO refunds VALUES ('r1','o1','2026-10-03 00:00:00'),('r2','o4','2026-09-21 00:00:00')`
		)
		// Every amount is even, so the margin is exactly half the revenue.
		await sql.unsafe(`UPDATE orders SET "cost" = "amount" / 2`)
		await sql.unsafe(
			`INSERT INTO maintenance VALUES ('m1','REPAIR','Kim',300,'2026-10-01 09:00:00'),('m2','REPAIR',NULL,100,'2026-10-02 09:00:00'),('m3','SERVICE','Kim',50,'2026-09-15 09:00:00')`
		)
	})

	afterAll(async () => {
		await sql.unsafe(
			'DROP TABLE IF EXISTS refunds, order_tags, tags, orders, regions, maintenance'
		)
		await sql.close()
	})

	test('measures over the last 30 days', async () => {
		const result = await analytics.query(
			{
				dataset: 'orders',
				measures: ['orders', 'customers', 'revenue', 'medianAmount'],
				compareToPrevious: true
			},
			tenantA
		)

		expect(result.period).toEqual({
			from: '2026-09-08',
			to: '2026-10-07',
			timezone: 'UTC'
		})
		expect(result.totals).toEqual({
			orders: 4,
			customers: 3,
			revenue: 1900,
			medianAmount: 175
		})
		expect(result.previous?.totals.orders).toBe(1)
		// Counts and sums come back from Postgres as bigints and numerics.
		expect(AnalyticsResultSchema.parse(result)).toEqual(result)
	})

	test('shares, ratios and correlated exists', async () => {
		const { totals } = await analytics.query(
			{
				dataset: 'orders',
				measures: ['paidShare', 'refunded', 'refundRate', 'averageRating']
			},
			tenantA
		)

		// Ratios are branded numbers; compare them as plain numbers.
		expect(totals as Record<string, unknown>).toEqual({
			paidShare: 0.5,
			refunded: 2,
			refundRate: 0.5,
			averageRating: 11 / 3
		})
	})

	test('grouping by enum and relation, with labels', async () => {
		const result = await analytics.query(
			{
				dataset: 'orders',
				measures: ['orders'],
				groupBy: ['region', 'status']
			},
			tenantA
		)

		expect(result.rows).toEqual([
			{
				region: { key: 'north' as RegionId, label: 'North' },
				status: { key: 'PAID', label: 'Paid' },
				orders: 2
			},
			{
				region: { key: 'south' as RegionId, label: 'South' },
				status: { key: 'REFUNDED', label: 'Refunded' },
				orders: 1
			},
			{
				region: { key: null, label: 'No region' },
				status: { key: 'OPEN', label: 'Open' },
				orders: 1
			}
		])
		expect(result.totals.orders).toBe(4)
	})

	test('many-to-many rows overlap, totals stay true', async () => {
		const result = await analytics.query(
			{ dataset: 'orders', measures: ['orders'], groupBy: ['tag'] },
			tenantA
		)

		expect(result.rows).toEqual([
			{ tag: { key: 'billing', label: 'Billing' }, orders: 2 },
			{ tag: { key: 'complaint', label: 'Complaint' }, orders: 2 },
			{ tag: { key: null, label: 'None' }, orders: 1 }
		])
		expect(result.totals.orders).toBe(4)
		expect(result.notes).toEqual([
			'An order with several tags counts once per tag.'
		])
	})

	test('filters resolve labels case-insensitively and never cross tenants', async () => {
		const byLabel = await analytics.query(
			{
				dataset: 'orders',
				measures: ['orders'],
				filters: [{ dimension: 'tag', op: 'in', values: ['complaint'] }]
			},
			tenantA
		)
		const notTagged = await analytics.query(
			{
				dataset: 'orders',
				measures: ['orders'],
				filters: [{ dimension: 'tag', op: 'notIn', values: ['Complaint'] }]
			},
			tenantA
		)

		expect(byLabel.totals.orders).toBe(2)
		expect(notTagged.totals.orders).toBe(2)
	})

	test('allTenants counts every tenant and resolves labels across them', async () => {
		const everyTenant = createAnalytics({
			datasets: [orders],
			sources: { main: source },
			tenant: () => allTenants,
			now: () => NOW
		})
		const query = {
			dataset: 'orders',
			measures: ['orders'],
			filters: [{ dimension: 'tag', op: 'in', values: ['complaint'] }]
		} as const

		expect((await analytics.query(query, tenantA)).totals.orders).toBe(2)
		// B's "other" tag is also named Complaint.
		expect((await everyTenant.query(query, {})).totals.orders).toBe(3)
		expect(
			(await everyTenant.query({ dataset: 'orders', measures: ['orders'] }, {}))
				.totals.orders
		).toBe(6)
	})

	test('a tenant list counts its tenants, an empty list counts nothing', async () => {
		const query = {
			dataset: 'orders',
			measures: ['orders'],
			filters: [{ dimension: 'tag', op: 'in', values: ['complaint'] }]
		} as const
		const count = async (tenantId: readonly string[]) =>
			(await analytics.query(query, { tenantId })).totals.orders

		// B's "other" tag is also named Complaint; the lookup resolves it in the list too.
		expect(await count(['A', 'B'])).toBe(3)
		expect(await count(['B'])).toBe(1)
		expect(
			(
				await analytics.query(
					{ dataset: 'orders', measures: ['orders'], groupBy: ['status'] },
					{ tenantId: [] }
				)
			).rows
		).toEqual([])
		await expect(count([])).rejects.toMatchObject({ code: 'unknown_value' })
	})

	test('a dataset without a tenant column is only for every-tenant callers', async () => {
		const everyTenant = createAnalytics({
			datasets: [maintenance],
			sources: { main: source },
			tenant: (ctx: { tenantId?: string }) => ctx.tenantId ?? allTenants,
			now: () => NOW
		})
		const query = {
			dataset: 'maintenance',
			measures: ['cases', 'cost'],
			filters: [{ dimension: 'technician', op: 'in', values: ['kim'] }]
		} as const

		expect((await everyTenant.query(query, {})).totals).toEqual({
			cases: 2,
			cost: 350
		})
		await expect(everyTenant.query(query, tenantA)).rejects.toMatchObject({
			code: 'forbidden'
		})
	})

	test('staff-only fields', async () => {
		type Viewer = { tenantId: string; role: 'staff' | 'customer' }
		const restricted = createAnalytics({
			datasets: [sales],
			sources: { main: source },
			tenant: (viewer: Viewer) => viewer.tenantId,
			authorizeField: (_dataset, _key, access, viewer: Viewer) =>
				viewer.role === access,
			now: () => NOW
		})
		const query = {
			dataset: 'sales',
			measures: ['revenue', 'margin', 'marginRate']
		} as const

		const { totals } = await restricted.query(query, {
			tenantId: 'A',
			role: 'staff'
		})
		expect(totals as Record<string, unknown>).toEqual({
			revenue: 1900,
			margin: 950,
			marginRate: 0.5
		})
		await expect(
			restricted.query(query, { tenantId: 'A', role: 'customer' })
		).rejects.toMatchObject({ code: 'forbidden' })
	})

	test('all-time periods count every row and still bucket by time', async () => {
		const byStatus = await analytics.query(
			{ dataset: 'orderBook', measures: ['orders'], groupBy: ['status'] },
			tenantA
		)
		const byMonth = await analytics.query(
			{
				dataset: 'orders',
				measures: ['orders'],
				groupBy: ['month'],
				period: { all: true }
			},
			tenantA
		)

		expect(byStatus.period).toEqual({ all: true, timezone: 'UTC' })
		expect(byStatus.rows.map((row) => [row.status.key, row.orders])).toEqual([
			['PAID', 3],
			['OPEN', 1],
			['REFUNDED', 1]
		])
		expect(byMonth.rows.map((row) => [row.month.key, row.orders])).toEqual([
			['2026-08-01', 1],
			['2026-09-01', 1],
			['2026-10-01', 3]
		])
		expect(byMonth.totals.orders).toBe(5)
		expect(AnalyticsResultSchema.parse(byMonth)).toEqual(byMonth)
	})

	test('an unknown value lists the valid ones', async () => {
		const error = await analytics
			.query(
				{
					dataset: 'orders',
					measures: ['orders'],
					filters: [{ dimension: 'region', op: 'in', values: ['West'] }]
				},
				tenantA
			)
			.catch((caught: unknown) => caught)

		expect(error).toBeInstanceOf(AnalyticsError)
		expect((error as AnalyticsError).code).toBe('unknown_value')
		expect((error as AnalyticsError).message).toBe(
			'Unknown region: "West". Valid values: North (north), South (south).'
		)
	})

	test('days bucket in the timezone', async () => {
		const query = {
			dataset: 'orders',
			measures: ['orders'],
			groupBy: ['day'],
			filters: [
				{
					dimension: 'day',
					op: 'between',
					from: '2026-10-01',
					to: '2026-10-02'
				}
			]
		} as const

		const utc = await analytics.query(query, tenantA)
		const auckland = await analyticsIn('Pacific/Auckland').query(query, tenantA)

		expect(utc.rows.map((row) => [row.day.key, row.orders])).toEqual([
			['2026-10-01', 1],
			['2026-10-02', 1]
		])
		expect(auckland.rows.map((row) => [row.day.key, row.orders])).toEqual([
			['2026-10-02', 2]
		])
	})

	test('weekday and hour parts', async () => {
		const result = await analytics.query(
			{
				dataset: 'orders',
				measures: ['orders'],
				groupBy: ['weekday'],
				limit: 2
			},
			tenantA
		)

		// 1 Oct is a Thursday, 2 Oct a Friday, 3 Oct a Saturday, 20 Sep a Sunday.
		expect(result.rows).toEqual([
			{ weekday: { key: 4, label: 'Thursday' }, orders: 1 },
			{ weekday: { key: 5, label: 'Friday' }, orders: 1 }
		])
		expect(result.truncated).toBe(true)
	})

	test('the dataset passes the contract kit', async () => {
		const report = await assertDatasetContract({
			dataset: orders,
			source,
			tenant: 'A',
			timezone: 'Pacific/Auckland',
			now: () => NOW
		})

		expect(report.checks.length).toBeGreaterThan(20)
		await assertDatasetContract({
			dataset: orderBook,
			source,
			tenant: 'A',
			period: { all: true },
			now: () => NOW
		})
		await assertDatasetContract({
			dataset: sales,
			source,
			tenant: 'A',
			now: () => NOW
		})
		const global = await assertDatasetContract({
			dataset: maintenance,
			source,
			tenant: allTenants,
			now: () => NOW
		})
		expect(
			global.checks.filter((check) => check.name.startsWith('tenant isolation'))
		).toHaveLength(2)
	})

	test('the contract kit catches buckets in the wrong timezone', async () => {
		// Treating naive UTC columns as timestamptz reads them as Auckland wall-clock time.
		const misconfigured = {
			...source,
			dialect: postgresDialect({ timestamps: 'timestamptz' })
		}

		const failure = await assertDatasetContract({
			dataset: orders,
			source: misconfigured,
			tenant: 'A',
			timezone: 'Pacific/Auckland',
			now: () => NOW
		}).catch((error: unknown) => error)

		expect(String(failure)).toContain('day buckets of created')
	})
})
