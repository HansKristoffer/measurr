import { describe, expect, test } from 'bun:test'
import {
	allTenants,
	type AnyDataset,
	caseWhen,
	type CompiledStatement,
	createAnalytics,
	defineDataset,
	type Dialect,
	dimension,
	eq,
	gt,
	measure,
	minutesAgo,
	type Tenant,
	table
} from './index.js'
import { postgresDialect } from './dialects/postgres.js'
import {
	type Order,
	type Refund,
	orderBook,
	orders
} from './fixtures/orders.js'

const NOW = new Date('2026-10-07T10:00:00Z')

function analyticsFor(
	dialect: Dialect,
	datasets: readonly AnyDataset[] = [orders, orderBook]
) {
	return createAnalytics({
		datasets,
		sources: { main: { dialect, execute: async () => [] } },
		tenant: (ctx: { tenantId: string | readonly string[] }) => ctx.tenantId,
		timezone: () => 'Europe/Copenhagen',
		now: () => NOW
	})
}

const ctx = { tenantId: 'tenant-1' }

/** The queries the compiler snapshots cover. */
const QUERIES = {
	ungrouped: {
		dataset: 'orders',
		measures: ['orders', 'revenue', 'medianAmount']
	},
	shareAndRatio: { dataset: 'orders', measures: ['paidShare', 'refundRate'] },
	byStatusAndRegion: {
		dataset: 'orders',
		measures: ['orders', 'customers'],
		groupBy: ['status', 'region'],
		filters: [
			{ dimension: 'status', op: 'notIn', values: ['OPEN'] },
			{ dimension: 'region', op: 'isNotEmpty' }
		],
		period: { last: { days: 30 } },
		sort: { by: 'customers', direction: 'desc' },
		limit: 10
	},
	byTagFilteredByTag: {
		dataset: 'orders',
		measures: ['orders'],
		groupBy: ['tag'],
		filters: [{ dimension: 'tag', op: 'in', values: ['tag-complaint'] }]
	},
	weeklyComputed: {
		dataset: 'orders',
		measures: ['orders', 'averageAmount'],
		groupBy: ['week', 'size'],
		filters: [{ dimension: 'rating', op: 'between', from: 1, to: 3 }],
		period: { preset: 'thisYear' },
		compareToPrevious: true
	},
	byWeekdayAndHour: {
		dataset: 'orders',
		measures: ['orders'],
		groupBy: ['weekday', 'hour'],
		time: 'shipped',
		period: { from: '2026-09-01', to: '2026-09-30' }
	},
	monthlyAllTime: {
		dataset: 'orders',
		measures: ['orders'],
		groupBy: ['month'],
		period: { all: true }
	},
	stateByStatus: {
		dataset: 'orderBook',
		measures: ['orders'],
		groupBy: ['status']
	}
} as const

const render = (statements: CompiledStatement[]) =>
	statements
		.map(
			(statement) =>
				`${statement.text}\n-- values: ${JSON.stringify(statement.values)}`
		)
		.join('\n\n')

describe('postgres compiler', () => {
	const analytics = analyticsFor(postgresDialect({ timestamps: 'utc' }))

	for (const [queryName, query] of Object.entries(QUERIES)) {
		test(queryName, async () => {
			expect(render(await analytics.explain(query, ctx))).toMatchSnapshot()
		})
	}

	test('tenant list', async () => {
		expect(
			render(
				await analytics.explain(QUERIES.byStatusAndRegion, {
					tenantId: ['tenant-1', 'tenant-2']
				})
			)
		).toMatchSnapshot()
	})
})

describe('planner rules', () => {
	const analytics = analyticsFor(postgresDialect())

	test('every statement filters by the tenant from the hook', async () => {
		const statements = await analytics.explain(QUERIES.weeklyComputed, ctx)

		expect(statements).toHaveLength(4)
		for (const statement of statements) {
			const placeholder = /\("orders"\."tenantId" = \$(\d+)\)/.exec(
				statement.text
			)
			expect(placeholder).not.toBeNull()
			expect(statement.values[Number(placeholder?.[1]) - 1]).toBe('tenant-1')
		}
	})

	test('a query without a tenant is refused', async () => {
		await expect(
			analytics.explain(QUERIES.ungrouped, { tenantId: '' })
		).rejects.toMatchObject({
			code: 'missing_tenant'
		})
	})

	describe('platform admins', () => {
		type Viewer =
			| { role: 'admin'; organizationId?: string }
			| { role: 'member'; organizationId: string }
		const sql: string[] = []
		const scoped = createAnalytics({
			datasets: [orders],
			sources: {
				main: {
					dialect: postgresDialect(),
					execute: async ({ text }) => {
						sql.push(text)
						return []
					}
				}
			},
			tenant: (viewer: Viewer) =>
				viewer.role === 'admin'
					? (viewer.organizationId ?? allTenants)
					: viewer.organizationId,
			now: () => NOW
		})
		const tenantFilter = '"orders"."tenantId" ='

		test('an admin without an organization queries every tenant', async () => {
			sql.length = 0
			// The tag filter runs the label lookup first; it finds nothing and fails.
			await expect(
				scoped.query(
					{
						dataset: 'orders',
						measures: ['orders'],
						filters: [{ dimension: 'tag', op: 'in', values: ['Complaint'] }]
					},
					{ role: 'admin' }
				)
			).rejects.toMatchObject({ code: 'unknown_value' })
			const statements = await scoped.explain(QUERIES.weeklyComputed, {
				role: 'admin'
			})

			expect(sql).toHaveLength(2)
			for (const text of [...sql, ...statements.map((s) => s.text)]) {
				expect(text).not.toContain(tenantFilter)
			}
		})

		test('an admin with an organization and a member are scoped to it', async () => {
			for (const viewer of [
				{ role: 'admin', organizationId: 'org-1' },
				{ role: 'member', organizationId: 'org-1' }
			] as const) {
				const [statement] = await scoped.explain(QUERIES.ungrouped, viewer)
				expect(statement?.text).toContain(tenantFilter)
				expect(statement?.values).toContain('org-1')
			}
		})

		test('a member without an organization is refused', async () => {
			await expect(
				scoped.explain(QUERIES.ungrouped, {
					role: 'member',
					organizationId: ''
				})
			).rejects.toMatchObject({ code: 'missing_tenant' })
		})
	})

	describe('tenant lists', () => {
		const sql: string[] = []
		const listed = createAnalytics({
			datasets: [orders],
			sources: {
				main: {
					dialect: postgresDialect(),
					execute: async ({ text }) => {
						sql.push(text)
						return []
					}
				}
			},
			tenant: (ctx: { tenants: unknown }) => ctx.tenants as Tenant,
			now: () => NOW
		})

		test('every statement and lookup filters by the list', async () => {
			sql.length = 0
			await expect(
				listed.query(
					{
						dataset: 'orders',
						measures: ['orders'],
						filters: [{ dimension: 'tag', op: 'in', values: ['Complaint'] }]
					},
					{ tenants: ['org-1', 'org-2'] }
				)
			).rejects.toMatchObject({ code: 'unknown_value' })
			const statements = await listed.explain(QUERIES.weeklyComputed, {
				tenants: ['org-1', 'org-2', 'org-1']
			})

			expect(sql).toHaveLength(2)
			for (const text of [...sql, ...statements.map((s) => s.text)]) {
				expect(text).toMatch(/\("orders"\."tenantId" IN \(\$\d+, \$\d+\)\)/)
			}
			// Duplicates are dropped.
			expect(
				statements[0]?.values.filter((value) => String(value).startsWith('org'))
			).toEqual(['org-1', 'org-2'])
		})

		test('one id compiles exactly like the scalar', async () => {
			expect(
				await listed.explain(QUERIES.byStatusAndRegion, { tenants: ['org-1'] })
			).toEqual(
				await listed.explain(QUERIES.byStatusAndRegion, { tenants: 'org-1' })
			)
		})

		test('an empty list matches no rows instead of every tenant', async () => {
			for (const statement of await listed.explain(QUERIES.weeklyComputed, {
				tenants: []
			})) {
				expect(statement.text).toStartWith('SELECT')
				expect(statement.text).toContain('WHERE (1 = 0) AND')
			}
		})

		test('a list with anything but tenant ids is refused', async () => {
			for (const tenants of [
				['org-1', ''],
				['org-1', null],
				[Number.NaN],
				[allTenants],
				[['org-1']]
			]) {
				await expect(
					listed.explain(QUERIES.ungrouped, { tenants })
				).rejects.toMatchObject({ code: 'missing_tenant' })
			}
		})
	})

	describe('all-time periods', () => {
		const timeFilter = '"orders"."createdAt" >='

		test('drop the time filter and keep time buckets', async () => {
			const [rows, totals] = await analytics.explain(
				QUERIES.monthlyAllTime,
				ctx
			)

			expect(rows?.text).not.toContain(timeFilter)
			expect(rows?.text).toContain("date_trunc('month'")
			expect(totals?.text).not.toContain(timeFilter)
		})

		test('a dataset default applies when the query names no period', async () => {
			const byDefault = await analytics.explain(
				{ dataset: 'orderBook', measures: ['orders'], period: null },
				ctx
			)
			const named = await analytics.explain(
				{
					dataset: 'orderBook',
					measures: ['orders'],
					period: { last: { days: 7 } }
				},
				ctx
			)
			const [orderDefault] = await analytics.explain(QUERIES.ungrouped, ctx)

			expect(byDefault[0]?.text).not.toContain(timeFilter)
			expect(named[0]?.text).toContain(timeFilter)
			expect(orderDefault?.text).toContain(timeFilter)
		})

		test('cannot compare with a previous period', async () => {
			for (const query of [
				{ ...QUERIES.monthlyAllTime, compareToPrevious: true },
				{ ...QUERIES.stateByStatus, compareToPrevious: true }
			]) {
				await expect(analytics.explain(query, ctx)).rejects.toMatchObject({
					code: 'invalid_query'
				})
			}
		})
	})

	test('totals of a many-to-many grouping do not join the link table', async () => {
		const [rows, totals] = await analytics.explain(
			{ dataset: 'orders', measures: ['orders'], groupBy: ['tag'] },
			ctx
		)

		expect(rows?.text).toContain('LEFT JOIN "order_tags"')
		expect(totals?.text).not.toContain('order_tags')
		expect(totals?.text).not.toContain('GROUP BY')
	})

	test('only the joins a query uses are added', async () => {
		const [plain] = await analytics.explain(
			{ dataset: 'orders', measures: ['orders'] },
			ctx
		)
		const [byRegion] = await analytics.explain(
			{ dataset: 'orders', measures: ['orders'], groupBy: ['region'] },
			ctx
		)

		expect(plain?.text).not.toContain('JOIN')
		expect(byRegion?.text).toContain('LEFT JOIN "regions" AS "regions"')
	})

	test('periods resolve in the timezone and reject more than two years', async () => {
		const [statement] = await analytics.explain(
			{
				dataset: 'orders',
				measures: ['orders'],
				period: { preset: 'yesterday' }
			},
			ctx
		)
		// 2026-10-06 in Copenhagen (UTC+2) starts at 22:00 UTC the day before.
		expect(statement?.values).toContain('2026-10-05T22:00:00.000Z')
		expect(statement?.values).toContain('2026-10-06T22:00:00.000Z')

		await expect(
			analytics.explain(
				{
					dataset: 'orders',
					measures: ['orders'],
					period: { from: '2023-01-01', to: '2026-01-01' }
				},
				ctx
			)
		).rejects.toMatchObject({ code: 'invalid_period' })
	})

	test('an invalid query fails with the schema error', async () => {
		await expect(
			analytics.explain({ dataset: 'orders', measures: ['nope'] } as never, ctx)
		).rejects.toMatchObject({ code: 'invalid_query' })
	})

	test('minutesAgo counts back from the query clock', async () => {
		const order = table<Order>('orders')
		const recent = defineDataset({
			key: 'recent',
			label: 'Recent',
			description: 'Recent',
			from: order,
			tenantColumn: order.col('tenantId'),
			time: { created: { column: order.col('createdAt'), label: 'Created' } },
			measures: {
				lastQuarterHour: measure.countWhere(
					gt(order.col('createdAt'), minutesAgo(15)),
					{ label: 'Last 15 minutes' }
				)
			},
			dimensions: {}
		})

		const [statement] = await analyticsFor(postgresDialect(), [recent]).explain(
			{ dataset: 'recent', measures: ['lastQuarterHour'] },
			ctx
		)

		expect(statement?.values).toContain('2026-10-07T09:45:00.000Z')
	})
})

describe('startup validation', () => {
	const order = table<Order>('orders')
	const base = {
		label: 'X',
		description: 'X',
		from: order,
		tenantColumn: order.col('tenantId'),
		time: { created: { column: order.col('createdAt'), label: 'Created' } },
		dimensions: {}
	} as const

	test('a column that is not joined to the dataset fails at defineDataset', () => {
		const stray = table<Refund>('refunds')
		expect(() =>
			defineDataset({
				...base,
				key: 'stray',
				measures: {
					refunds: measure.countDistinct(stray.col('id'), { label: 'Refunds' })
				}
			})
		).toThrow(/not joined to orders/)
	})

	test('a computed value missing from its values fails at defineDataset', () => {
		expect(() =>
			defineDataset({
				...base,
				key: 'computed',
				measures: { orders: measure.count({ label: 'Orders' }) },
				dimensions: {
					paid: dimension.computed({
						label: 'Paid',
						// @ts-expect-error typecheck catches this; the runtime check covers untyped expressions
						expr: caseWhen([[eq(order.col('status'), 'PAID'), 'yes']], 'no'),
						values: { yes: 'Yes' }
					})
				}
			})
		).toThrow(/can produce "no"/)
	})
})
