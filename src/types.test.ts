import { describe, expectTypeOf, test } from 'bun:test'
import {
	allTenants,
	type AnalyticsQuery,
	type AnalyticsResult,
	type Ratio,
	type ResultPeriod,
	createAnalytics,
	defineDataset,
	dimension,
	eq,
	caseWhen,
	coalesce,
	type DatasetQuery,
	type DimensionValue,
	inList,
	isAnalyticsError,
	measure,
	table,
	toText
} from './index.js'
import { postgresDialect } from './dialects/postgres.js'
import type { z } from 'zod'
import {
	type Order,
	OrderStatus,
	type Region,
	type RegionId,
	STATUS_LABELS,
	orderBook,
	orders
} from './fixtures/orders.js'

const source = { dialect: postgresDialect(), execute: async () => [] }
const analytics = createAnalytics({
	datasets: [orders],
	sources: { main: source },
	tenant: (ctx: { tenantId: string }) => ctx.tenantId
})

const order = table<Order>('orders')

// These run only through the typechecker; the bodies are never called.
const typeOnly = (_body: () => unknown) => undefined

describe('tenant hook', () => {
	test('only allTenants widens a query beyond one tenant', () => {
		typeOnly(() => {
			createAnalytics({
				datasets: [orders],
				sources: { main: source },
				tenant: (ctx: { organizationId?: string }) =>
					ctx.organizationId ?? allTenants
			})
			createAnalytics({
				datasets: [orders],
				sources: { main: source },
				// @ts-expect-error any other symbol is not a tenant
				tenant: () => Symbol('all')
			})
			createAnalytics({
				datasets: [orders],
				sources: { main: source },
				tenant: (ctx: { organizationIds: readonly string[] }) =>
					ctx.organizationIds
			})
			createAnalytics({
				datasets: [orders],
				sources: { main: source },
				// @ts-expect-error allTenants is never part of a list
				tenant: () => [allTenants]
			})
		})
	})
})

describe('typed tables and expressions', () => {
	test('columns are checked against the row type', () => {
		expectTypeOf(order.col('amount').sqlType).toEqualTypeOf<'number'>()
		expectTypeOf(order.col('createdAt').sqlType).toEqualTypeOf<'timestamp'>()
		expectTypeOf(order.col('status').sqlType).toEqualTypeOf<'string'>()
		expectTypeOf(order.col('isTest').sqlType).toEqualTypeOf<'boolean'>()

		typeOnly(() => {
			// @ts-expect-error a misspelled column
			order.col('amout')
			// @ts-expect-error JSON columns have no SQL type here
			order.col('metadata')
		})
	})

	test('operands must match the column type', () => {
		typeOnly(() => {
			eq(order.col('isTest'), false)
			// @ts-expect-error a string compared to a boolean column
			eq(order.col('isTest'), 'no')
			// @ts-expect-error a number column compared to a string column
			eq(order.col('amount'), order.col('status'))
			// @ts-expect-error arithmetic on a string
			order.col('status').div(2)
		})
	})

	test('measures and dimensions only accept expressions of the right type', () => {
		typeOnly(() => {
			// @ts-expect-error avg over a string
			measure.avg(order.col('status'), { label: 'x' })
			// @ts-expect-error share over a number
			measure.share({ label: 'x', numerator: order.col('amount') })
			dimension.enum(toText(order.col('status')), { A: 'A', B: 'B' } as const, {
				label: 'x',
				// @ts-expect-error enum labels must cover every value
				labels: { A: 'A' }
			})
			dimension.enum(
				// @ts-expect-error the column holds values the enum does not list
				order.col('status'),
				{ OPEN: 'OPEN' } as const,
				{ label: 'x', labels: { OPEN: 'Open' } }
			)
			dimension.computed({
				label: 'x',
				// @ts-expect-error values must cover every value the expression produces
				expr: caseWhen([[order.col('isTest'), 'test']], 'live'),
				values: { test: 'Test' }
			})
			// @ts-expect-error a typo in an enum value
			eq(order.col('status'), 'PAD')
			// @ts-expect-error inList values are checked against the column too
			inList(order.col('status'), ['OPEN', 'CLOSED'])
			dimension.relation<number>({
				label: 'x',
				// @ts-expect-error the key type must match the key column
				key: order.col('customerId'),
				name: order.col('customerId')
			})
		})
	})
})

describe('defineDataset', () => {
	const base = {
		key: 'checked',
		label: 'Checked',
		description: 'Type checks.',
		from: order,
		tenantColumn: order.col('tenantId'),
		time: { created: { column: order.col('createdAt'), label: 'Created' } }
	} as const

	test('a ratio may only name measures of the same dataset', () => {
		typeOnly(() => {
			defineDataset({
				...base,
				measures: {
					orders: measure.count({ label: 'Orders' }),
					// @ts-expect-error "order" is not a measure of this dataset
					rate: measure.ratio('order', 'orders', { label: 'Rate' })
				},
				dimensions: {}
			})
		})
	})

	test('time dimensions may only name declared time fields', () => {
		typeOnly(() => {
			defineDataset({
				...base,
				measures: { orders: measure.count({ label: 'Orders' }) },
				dimensions: {
					// @ts-expect-error "shipped" is not a time field of this dataset
					week: dimension.timeBucket('shipped', 'week')
				}
			})
		})
	})

	test('time fields only accept timestamp columns', () => {
		typeOnly(() => {
			defineDataset({
				...base,
				// @ts-expect-error amount is not a timestamp
				time: { created: { column: order.col('amount'), label: 'Created' } },
				measures: { orders: measure.count({ label: 'Orders' }) },
				dimensions: {}
			})
		})
	})
})

describe('queries and results', () => {
	type Query = AnalyticsQuery<typeof analytics>

	test('queries only name what the dataset has', () => {
		typeOnly(() => {
			const ok: Query = {
				dataset: 'orders',
				measures: ['orders', 'paidShare'],
				groupBy: ['status'],
				filters: [
					{ dimension: 'status', op: 'in', values: ['PAID'] },
					{ dimension: 'tag', op: 'in', values: ['Complaint'] },
					{ dimension: 'rating', op: 'between', from: 1, to: 3 },
					{
						dimension: 'week',
						op: 'between',
						from: '2026-01-05',
						to: '2026-02-02'
					}
				],
				period: { preset: 'lastMonth' }
			}
			const wrongMeasure: Query = {
				dataset: 'orders',
				// @ts-expect-error unknown measure
				measures: ['order']
			}
			const betweenOnEnum: Query = {
				dataset: 'orders',
				measures: ['orders'],
				// @ts-expect-error between is not an operator of a closed dimension
				filters: [{ dimension: 'status', op: 'between', from: 1, to: 2 }]
			}
			const inOnNumber: Query = {
				dataset: 'orders',
				measures: ['orders'],
				// @ts-expect-error in is not an operator of a numeric dimension
				filters: [{ dimension: 'rating', op: 'in', values: ['1'] }]
			}
			const unknownEnumValue: Query = {
				dataset: 'orders',
				measures: ['orders'],
				// @ts-expect-error not a status
				filters: [{ dimension: 'status', op: 'in', values: ['LOST'] }]
			}
			return [ok, wrongMeasure, betweenOnEnum, inOnNumber, unknownEnumValue]
		})
	})

	test('rows only have the grouped dimensions and the asked measures', async () => {
		typeOnly(async () => {
			const result = await analytics.query(
				{
					dataset: 'orders',
					measures: ['orders', 'paidShare', 'revenue'],
					groupBy: ['status', 'region']
				},
				{ tenantId: 't' }
			)
			const row = result.rows[0]
			if (!row) return

			expectTypeOf(row.status.key).toEqualTypeOf<'OPEN' | 'PAID' | 'REFUNDED'>()
			expectTypeOf(row.region.key).toEqualTypeOf<RegionId | null>()
			expectTypeOf(row.orders).toEqualTypeOf<number>()
			expectTypeOf(row.paidShare).toEqualTypeOf<Ratio | null>()
			expectTypeOf(row.revenue).toEqualTypeOf<number | null>()
			expectTypeOf(result.totals.orders).toEqualTypeOf<number>()

			// @ts-expect-error not grouped by week
			row.week
			// @ts-expect-error not asked for
			row.customers
		})
	})

	test('time buckets are keyed by date and parts by number', () => {
		type Result = AnalyticsResult<
			typeof analytics,
			{ dataset: 'orders'; measures: ['orders']; groupBy: ['week', 'hour'] }
		>
		expectTypeOf<Result['rows'][number]['week']['key']>().toEqualTypeOf<
			string | null
		>()
		expectTypeOf<Result['rows'][number]['hour']['key']>().toEqualTypeOf<
			number | null
		>()
	})
})

describe('stricter definitions', () => {
	test('relation keys come from the key column', () => {
		const region = table<Region>('regions')
		const byRegion = dimension.relation({
			label: 'Region',
			key: region.col('id'),
			name: region.col('name')
		})
		expectTypeOf<
			DimensionValue<typeof byRegion>['key']
		>().toEqualTypeOf<RegionId | null>()
	})

	test('groupOnly and filterOnly limit what queries may name', () => {
		const limited = defineDataset({
			key: 'limited',
			label: 'Limited',
			description: 'Access checks.',
			from: order,
			tenantColumn: order.col('tenantId'),
			time: { created: { column: order.col('createdAt'), label: 'Created' } },
			measures: { orders: measure.count({ label: 'Orders' }) },
			dimensions: {
				status: dimension.enum(order.col('status'), OrderStatus, {
					label: 'Status',
					labels: STATUS_LABELS,
					groupOnly: true
				}),
				amount: dimension.number(order.col('amount'), {
					label: 'Amount',
					filterOnly: true
				})
			}
		})
		type Query = DatasetQuery<typeof limited>

		expectTypeOf<{
			dataset: 'limited'
			measures: ['orders']
			groupBy: ['status']
			filters: [{ dimension: 'amount'; op: 'between'; from: 1; to: 2 }]
		}>().toExtend<Query>()
		expectTypeOf<{
			dataset: 'limited'
			measures: ['orders']
			groupBy: ['amount']
		}>().not.toExtend<Query>()
		expectTypeOf<{
			dataset: 'limited'
			measures: ['orders']
			filters: [{ dimension: 'status'; op: 'in'; values: ['OPEN'] }]
		}>().not.toExtend<Query>()
	})

	test('querySchema is typed for the datasets it was built for', () => {
		const schema = analytics.querySchema({ datasets: ['orders'] })
		expectTypeOf<z.infer<typeof schema>['dataset']>().toEqualTypeOf<'orders'>()
	})

	test('error details narrow by code', () => {
		typeOnly(() => {
			const error: unknown = null
			if (isAnalyticsError(error, 'unknown_value')) {
				expectTypeOf(error.details.valid).toEqualTypeOf<
					{ key: string; label: string }[]
				>()
			}
			if (isAnalyticsError(error) && error.code === 'forbidden') {
				expectTypeOf(error.details).toEqualTypeOf<undefined>()
			}
		})
	})

	test('a plain number is not a Ratio', () => {
		expectTypeOf<number>().not.toExtend<Ratio>()
		expectTypeOf<Ratio>().toExtend<number>()
	})
})

describe('nullability', () => {
	type Ticket = {
		id: string
		tenantId: string
		priority: 'LOW' | 'HIGH' | null
		kind: 'BUG' | 'IDEA'
		createdAt: Date
	}
	const ticket = table<Ticket>('tickets')
	const LABELS = { LOW: 'Low', HIGH: 'High' }

	test('columns keep their nullability', () => {
		expectTypeOf(ticket.col('priority').valueType).toEqualTypeOf<
			'LOW' | 'HIGH' | null
		>()
		expectTypeOf(ticket.col('kind').valueType).toEqualTypeOf<'BUG' | 'IDEA'>()
		typeOnly(() => {
			// @ts-expect-error compare with isNull, never with a null value
			eq(ticket.col('priority'), null)
		})
	})

	test('enum and computed keys are null only when their expression can be', () => {
		const tickets = defineDataset({
			key: 'tickets',
			label: 'Tickets',
			description: 'One row per ticket.',
			from: ticket,
			tenantColumn: ticket.col('tenantId'),
			time: { created: { column: ticket.col('createdAt'), label: 'Created' } },
			measures: { tickets: measure.count({ label: 'Tickets' }) },
			dimensions: {
				priority: dimension.enum(
					ticket.col('priority'),
					{ LOW: 'LOW', HIGH: 'HIGH' } as const,
					{ label: 'Priority', labels: LABELS, empty: 'No priority' }
				),
				kind: dimension.enum(
					ticket.col('kind'),
					{ BUG: 'BUG', IDEA: 'IDEA' } as const,
					{ label: 'Kind', labels: { BUG: 'Bug', IDEA: 'Idea' } }
				),
				urgent: dimension.computed({
					label: 'Urgent',
					expr: caseWhen([[eq(ticket.col('priority'), 'HIGH'), 'yes']]),
					values: { yes: 'Yes' }
				}),
				filled: dimension.computed({
					label: 'Priority set',
					expr: coalesce(ticket.col('priority'), 'LOW'),
					values: { LOW: 'Low', HIGH: 'High' }
				})
			}
		})
		const analytics = createAnalytics({
			datasets: [tickets],
			sources: { main: source },
			tenant: () => 't'
		})
		type Row = AnalyticsResult<
			typeof analytics,
			{
				dataset: 'tickets'
				measures: ['tickets']
				groupBy: ['priority', 'kind']
			}
		>['rows'][number]
		type Computed = AnalyticsResult<
			typeof analytics,
			{
				dataset: 'tickets'
				measures: ['tickets']
				groupBy: ['urgent', 'filled']
			}
		>['rows'][number]

		expectTypeOf<Row['priority']['key']>().toEqualTypeOf<
			'LOW' | 'HIGH' | null
		>()
		expectTypeOf<Row['kind']['key']>().toEqualTypeOf<'BUG' | 'IDEA'>()
		expectTypeOf<Computed['urgent']['key']>().toEqualTypeOf<'yes' | null>()
		expectTypeOf<Computed['filled']['key']>().toEqualTypeOf<'LOW' | 'HIGH'>()
	})
})

describe('result periods', () => {
	type Range = { from: string; to: string; timezone: string }
	type AllTime = { all: true; timezone: string }
	const both = createAnalytics({
		datasets: [orders, orderBook],
		sources: { main: source },
		tenant: () => 't'
	})
	type PeriodOf<Q> = AnalyticsResult<typeof both, Q>['period']

	test('follow the query, or the dataset default when it names none', () => {
		expectTypeOf(orderBook.defaultPeriod).toEqualTypeOf<{
			readonly all: true
		}>()
		expectTypeOf<
			PeriodOf<{ dataset: 'orders'; measures: ['orders'] }>
		>().toEqualTypeOf<Range>()
		expectTypeOf<
			PeriodOf<{
				dataset: 'orders'
				measures: ['orders']
				period: { all: true }
			}>
		>().toEqualTypeOf<AllTime>()
		expectTypeOf<
			PeriodOf<{ dataset: 'orderBook'; measures: ['orders']; period: null }>
		>().toEqualTypeOf<AllTime>()
		expectTypeOf<
			PeriodOf<{
				dataset: 'orderBook'
				measures: ['orders']
				period: { preset: 'today' }
			}>
		>().toEqualTypeOf<Range>()
	})

	test('a query typed only as the schema gives either', () => {
		expectTypeOf<
			PeriodOf<AnalyticsQuery<typeof both>>
		>().toEqualTypeOf<ResultPeriod>()
	})

	test('a literal query needs no narrowing', () => {
		typeOnly(async () => {
			const result = await both.query(
				{ dataset: 'orders', measures: ['orders'] },
				{}
			)
			expectTypeOf(result.period.from).toEqualTypeOf<string>()
		})
	})
})

describe('integrations', () => {
	test('schema output can be passed straight to query', () => {
		typeOnly(async () => {
			const input = analytics.querySchema().parse({})
			const result = await analytics.query(input, { tenantId: 't' })
			expectTypeOf(result.period).toEqualTypeOf<ResultPeriod>()
			if ('from' in result.period)
				expectTypeOf(result.period.from).toEqualTypeOf<string>()
			// Only a range has a previous period.
			expectTypeOf(result.previous?.period.from).toEqualTypeOf<
				string | undefined
			>()
		})
	})
})
