/**
 * The example datasets the package's tests use: orders with a region (to-one), tags
 * (many-to-many), refunds (correlated `exists`) and two time fields; sales with staff-only
 * fields; and maintenance cases, which belong to no tenant.
 */
import {
	caseWhen,
	defineDataset,
	dimension,
	eq,
	exists,
	gte,
	measure,
	table
} from '../index.js'

export type RegionId = string & { readonly __brand: 'Region' }

export const OrderStatus = {
	OPEN: 'OPEN',
	PAID: 'PAID',
	REFUNDED: 'REFUNDED'
} as const
export type OrderStatus = (typeof OrderStatus)[keyof typeof OrderStatus]

export type Order = {
	id: string
	tenantId: string
	customerId: string
	status: OrderStatus
	amount: number
	cost: number
	rating: number | null
	regionId: RegionId | null
	isTest: boolean
	createdAt: Date
	shippedAt: Date | null
	/** JSON columns cannot be used in datasets. */
	metadata: Record<string, unknown> | null
}

export type Region = { id: RegionId; tenantId: string; name: string }
export type OrderTag = { orderId: string; tagId: string }
export type Tag = { id: string; tenantId: string; name: string }
export type Refund = { id: string; orderId: string; createdAt: Date }

export const STATUS_LABELS = {
	OPEN: 'Open',
	PAID: 'Paid',
	REFUNDED: 'Refunded'
} satisfies Record<OrderStatus, string>

const order = table<Order>('orders')
const region = order.leftJoin(table<Region>('regions'), (r) =>
	eq(r.col('id'), order.col('regionId'))
)
const orderTag = table<OrderTag>('order_tags')
const tag = orderTag.leftJoin(table<Tag>('tags'), (t) =>
	eq(t.col('id'), orderTag.col('tagId'))
)
const refund = table<Refund>('refunds')

export const orders = defineDataset({
	key: 'orders',
	label: 'Orders',
	description: 'One row per order. Test orders are excluded.',
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
		averageAmount: measure.avg(order.col('amount'), {
			label: 'Average amount'
		}),
		medianAmount: measure.median(order.col('amount'), {
			label: 'Median amount'
		}),
		averageRating: measure.avg(order.col('rating'), {
			label: 'Average rating'
		}),
		refunded: measure.countWhere(
			exists(refund, eq(refund.col('orderId'), order.col('id'))),
			{ label: 'Refunded orders' }
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
			name: region.col('name'),
			empty: 'No region'
		}),
		tag: dimension.manyToMany({
			label: 'Tag',
			through: {
				table: orderTag,
				on: eq(orderTag.col('orderId'), order.col('id')),
				key: tag.col('id'),
				name: tag.col('name')
			},
			note: 'An order with several tags counts once per tag.'
		}),
		size: dimension.computed({
			label: 'Size',
			expr: caseWhen(
				[
					[gte(order.col('amount'), 1000), 'large'],
					[gte(order.col('amount'), 100), 'medium']
				],
				'small'
			),
			values: { large: 'Large', medium: 'Medium', small: 'Small' }
		}),
		rating: dimension.number(order.col('rating'), { label: 'Rating' }),
		day: dimension.timeBucket('created', 'day'),
		week: dimension.timeBucket('created', 'week'),
		month: dimension.timeBucket('created', 'month'),
		weekday: dimension.timePart('created', 'isodow'),
		hour: dimension.timePart('created', 'hour')
	}
})

/** Current state: every order counts unless a query names a period. */
export const orderBook = defineDataset({
	key: 'orderBook',
	label: 'Order book',
	description: 'Every order, whenever it was created.',
	from: order,
	tenantColumn: order.col('tenantId'),
	scope: eq(order.col('isTest'), false),
	time: { created: { column: order.col('createdAt'), label: 'Created' } },
	defaultPeriod: { all: true },
	measures: { orders: measure.count({ label: 'Orders' }) },
	dimensions: {
		status: dimension.enum(order.col('status'), OrderStatus, {
			label: 'Status',
			labels: STATUS_LABELS
		}),
		region: dimension.relation({
			label: 'Region',
			key: region.col('id'),
			name: region.col('name'),
			empty: 'No region'
		}),
		month: dimension.timeBucket('created', 'month')
	}
})

/** Customers, resellers and staff query sales; margin and the customer split are staff-only. */
export const sales = defineDataset({
	key: 'sales',
	label: 'Sales',
	description: 'One row per order. Test orders are excluded.',
	from: order,
	tenantColumn: order.col('tenantId'),
	scope: eq(order.col('isTest'), false),
	time: { created: { column: order.col('createdAt'), label: 'Created' } },
	measures: {
		orders: measure.count({ label: 'Orders' }),
		revenue: measure.sum(order.col('amount'), { label: 'Revenue' }),
		margin: measure.sum(order.col('amount').sub(order.col('cost')), {
			label: 'Margin',
			access: 'staff'
		}),
		marginRate: measure.ratio('margin', 'revenue', { label: 'Margin rate' })
	},
	dimensions: {
		status: dimension.enum(order.col('status'), OrderStatus, {
			label: 'Status',
			labels: STATUS_LABELS
		}),
		customer: dimension.relation({
			label: 'Customer',
			key: order.col('customerId'),
			name: order.col('customerId'),
			access: 'staff'
		})
	}
})

export type Maintenance = {
	id: string
	kind: 'REPAIR' | 'SERVICE'
	technician: string | null
	cost: number
	createdAt: Date
}

const maintenanceCase = table<Maintenance>('maintenance')

/** Repairs done by staff: no organization owns them, so only every-tenant callers see them. */
export const maintenance = defineDataset({
	key: 'maintenance',
	label: 'Maintenance',
	description: 'One row per maintenance case.',
	from: maintenanceCase,
	tenantColumn: null,
	time: {
		created: { column: maintenanceCase.col('createdAt'), label: 'Created' }
	},
	measures: {
		cases: measure.count({ label: 'Cases' }),
		cost: measure.sum(maintenanceCase.col('cost'), { label: 'Cost' })
	},
	dimensions: {
		kind: dimension.enum(
			maintenanceCase.col('kind'),
			{ REPAIR: 'REPAIR', SERVICE: 'SERVICE' } as const,
			{ label: 'Kind', labels: { REPAIR: 'Repair', SERVICE: 'Service' } }
		),
		technician: dimension.relation({
			label: 'Technician',
			key: maintenanceCase.col('technician'),
			name: maintenanceCase.col('technician'),
			empty: 'Unassigned'
		})
	}
})
