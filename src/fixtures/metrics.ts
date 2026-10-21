/** Example dashboard metrics over the order datasets, one of each kind the presenters draw. */
import { z } from 'zod'
import { metricDefiner } from '../metrics.js'
import {
	presentDistribution,
	presentKpi,
	presentLeaderboard,
	presentTimeseries
} from '../shapes.js'
import type { orderBook, orders } from './orders.js'

export type Role = 'owner' | 'member'

const defineMetric = metricDefiner<typeof orders | typeof orderBook, Role>()

const StatusFilters = z.object({
	status: z.enum(['OPEN', 'PAID', 'REFUNDED']).optional()
})

export const orderCount = defineMetric({
	key: 'orders.count',
	kind: 'kpi',
	description: 'Orders created in the period',
	supportsTimeRange: true,
	filterSchema: StatusFilters,
	query: ({ filters }) => ({
		dataset: 'orders',
		measures: ['orders'],
		filters: filters.status
			? [{ dimension: 'status', op: 'in', values: [filters.status] }]
			: []
	}),
	shape: (result) => presentKpi(result, 'orders', { label: 'Orders' })
})

export const paidShare = defineMetric({
	key: 'orders.paidShare',
	kind: 'kpi',
	description: 'Share of orders that are paid',
	allowedRoles: ['owner'],
	supportsTimeRange: true,
	filterSchema: z.object({}),
	query: () => ({ dataset: 'orders', measures: ['paidShare'] }),
	shape: (result) =>
		presentKpi(result, 'paidShare', { label: 'Paid', percent: true })
})

export const orderTrend = defineMetric({
	key: 'orders.trend',
	kind: 'timeseries',
	description: 'Orders over time, optionally split by status',
	supportsTimeRange: true,
	filterSchema: z.object({ byStatus: z.boolean().optional() }),
	query: ({ bucket, filters }) => ({
		dataset: 'orders',
		measures: ['orders'],
		groupBy: filters.byStatus ? [bucket, 'status'] : [bucket],
		limit: 100
	}),
	shape: (result, { bucket, filters }) =>
		presentTimeseries(result, {
			bucket,
			measure: 'orders',
			series: filters.byStatus ? 'status' : undefined,
			keys: { orders: 'volume' },
			labels: { volume: 'Orders' },
			chartType: 'bar'
		})
})

export const ordersByStatus = defineMetric({
	key: 'orders.byStatus',
	kind: 'distribution',
	description: 'Every order by current status',
	supportsTimeRange: false,
	filterSchema: z.object({}),
	query: () => ({
		dataset: 'orderBook',
		measures: ['orders'],
		groupBy: ['status']
	}),
	shape: (result) =>
		presentDistribution(result, {
			by: 'status',
			measure: 'orders',
			chartType: 'donut',
			order: ['OPEN', 'PAID', 'REFUNDED']
		})
})

export const topRegions = defineMetric({
	key: 'orders.topRegions',
	kind: 'leaderboard',
	description: 'Regions with the most orders',
	supportsTimeRange: true,
	filterSchema: z.object({ limit: z.number().int().min(1).max(20).optional() }),
	query: ({ filters }) => ({
		dataset: 'orders',
		measures: ['orders', 'revenue'],
		groupBy: ['region'],
		sort: { by: 'orders' },
		limit: filters.limit ?? 10
	}),
	shape: (result) =>
		presentLeaderboard(result, {
			by: 'region',
			measure: 'orders',
			meta: (values) => ({ revenue: values.revenue ?? 0 })
		})
})

export const orderMetrics = [
	orderCount,
	paidShare,
	orderTrend,
	ordersByStatus,
	topRegions
] as const
