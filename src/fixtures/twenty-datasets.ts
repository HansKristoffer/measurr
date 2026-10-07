/**
 * A compile-time budget fixture: 20 datasets, one analytics instance, typed queries against
 * it. `tsc --extendedDiagnostics` on the package measures what the generics cost.
 */
import {
	type AnalyticsQuery,
	caseWhen,
	createAnalytics,
	defineDataset,
	dimension,
	eq,
	exists,
	gte,
	measure,
	table
} from '../index.js'
import { postgresDialect } from '../dialects/postgres.js'
import {
	type Order,
	OrderStatus,
	type OrderTag,
	type Refund,
	type Region,
	STATUS_LABELS,
	type Tag
} from './orders.js'

function ordersLike<const K extends string>(key: K) {
	const order = table<Order>(`${key}_orders`)
	const region = order.leftJoin(table<Region>('regions'), (r) =>
		eq(r.col('id'), order.col('regionId'))
	)
	const orderTag = table<OrderTag>('order_tags')
	const tag = orderTag.leftJoin(table<Tag>('tags'), (t) =>
		eq(t.col('id'), orderTag.col('tagId'))
	)
	const refund = table<Refund>('refunds')

	return defineDataset({
		key,
		label: key,
		description: `Fixture ${key}`,
		from: order,
		tenantColumn: order.col('tenantId'),
		scope: eq(order.col('isTest'), false),
		time: {
			created: { column: order.col('createdAt'), label: 'Created' },
			shipped: { column: order.col('shippedAt'), label: 'Shipped' }
		},
		measures: {
			orders: measure.count({ label: 'Orders' }),
			customers: measure.countDistinct(order.col('customerId'), {
				label: 'Customers'
			}),
			revenue: measure.sum(order.col('amount'), { label: 'Revenue' }),
			averageAmount: measure.avg(order.col('amount').div(100), {
				label: 'Average'
			}),
			medianAmount: measure.median(order.col('amount'), { label: 'Median' }),
			refunded: measure.countWhere(
				exists(refund, eq(refund.col('orderId'), order.col('id'))),
				{ label: 'Refunded' }
			),
			paidShare: measure.share({
				label: 'Paid',
				numerator: eq(order.col('status'), 'PAID')
			}),
			refundRate: measure.ratio('refunded', 'orders', { label: 'Refund rate' })
		},
		dimensions: {
			status: dimension.enum(order.col('status'), OrderStatus, {
				label: 'Status',
				labels: STATUS_LABELS
			}),
			region: dimension.relation({
				label: 'Region',
				key: region.col('id'),
				name: region.col('name')
			}),
			tag: dimension.manyToMany({
				label: 'Tag',
				through: {
					table: orderTag,
					on: eq(orderTag.col('orderId'), order.col('id')),
					key: tag.col('id'),
					name: tag.col('name')
				}
			}),
			size: dimension.computed({
				label: 'Size',
				expr: caseWhen([[gte(order.col('amount'), 1000), 'large']], 'small'),
				values: { large: 'Large', small: 'Small' }
			}),
			rating: dimension.number(order.col('rating'), { label: 'Rating' }),
			week: dimension.timeBucket('created', 'week'),
			month: dimension.timeBucket('shipped', 'month'),
			weekday: dimension.timePart('created', 'isodow'),
			hour: dimension.timePart('created', 'hour')
		}
	})
}

export const twentyAnalytics = createAnalytics({
	datasets: [
		ordersLike('d01'),
		ordersLike('d02'),
		ordersLike('d03'),
		ordersLike('d04'),
		ordersLike('d05'),
		ordersLike('d06'),
		ordersLike('d07'),
		ordersLike('d08'),
		ordersLike('d09'),
		ordersLike('d10'),
		ordersLike('d11'),
		ordersLike('d12'),
		ordersLike('d13'),
		ordersLike('d14'),
		ordersLike('d15'),
		ordersLike('d16'),
		ordersLike('d17'),
		ordersLike('d18'),
		ordersLike('d19'),
		ordersLike('d20')
	],
	sources: { main: { dialect: postgresDialect(), execute: async () => [] } },
	tenant: (ctx: { tenantId: string }) => ctx.tenantId
})

export type TwentyQuery = AnalyticsQuery<typeof twentyAnalytics>

export const typedQueries = async () => {
	const ctx = { tenantId: 't' }
	const byTag = await twentyAnalytics.query(
		{
			dataset: 'd07',
			measures: ['orders', 'refundRate'],
			groupBy: ['tag', 'week']
		},
		ctx
	)
	const plain = await twentyAnalytics.query(
		{ dataset: 'd19', measures: ['revenue'] },
		ctx
	)
	const fromSchema = await twentyAnalytics.query(
		twentyAnalytics.querySchema().parse({}),
		ctx
	)

	return [byTag.rows[0]?.tag.label, plain.totals.revenue, fromSchema.truncated]
}
