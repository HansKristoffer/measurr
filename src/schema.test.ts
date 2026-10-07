import { describe, expect, test } from 'bun:test'
import { z } from 'zod'
import { createAnalytics } from './index.js'
import { postgresDialect } from './dialects/postgres.js'
import { orders } from './fixtures/orders.js'

const analytics = createAnalytics({
	datasets: [orders],
	sources: { main: { dialect: postgresDialect(), execute: async () => [] } },
	tenant: () => 'tenant-1'
})
const schema = analytics.querySchema()

const issuesOf = (input: unknown) => {
	const parsed = schema.safeParse(input)
	return parsed.success ? [] : parsed.error.issues.map((issue) => issue.message)
}

describe('query schema', () => {
	test('becomes a JSON Schema with labels as descriptions', () => {
		const json = JSON.stringify(z.toJSONSchema(schema))

		expect(json).toContain('One row per order. Test orders are excluded.')
		expect(json).toContain('refundRate: Refund rate')
		expect(json).toContain('An order with several tags counts once per tag.')
		expect(json).toContain('"enum":["OPEN","PAID","REFUNDED"]')
	})

	test('accepts a full query', () => {
		expect(
			issuesOf({
				dataset: 'orders',
				measures: ['orders', 'paidShare'],
				groupBy: ['tag', 'week'],
				filters: [
					{ dimension: 'status', op: 'in', values: ['PAID'] },
					{ dimension: 'tag', op: 'notIn', values: ['Complaint'] },
					{ dimension: 'rating', op: 'between', from: 1, to: 3 },
					{ dimension: 'region', op: 'isEmpty' }
				],
				period: { preset: 'lastMonth' },
				time: 'shipped',
				compareToPrevious: true,
				sort: { by: 'orders', direction: 'asc' },
				limit: 100
			})
		).toEqual([])
	})

	test('rejects what a dataset does not have, with the valid options', () => {
		expect(
			issuesOf({ dataset: 'orders', measures: ['order'] }).join()
		).toContain('"orders"')
		expect(
			issuesOf({
				dataset: 'orders',
				measures: ['orders'],
				filters: [{ dimension: 'status', op: 'in', values: ['LOST'] }]
			}).join()
		).toContain('"REFUNDED"')
	})

	test('enforces the caps and per-kind operators', () => {
		const tooMany = [
			'orders',
			'customers',
			'revenue',
			'averageAmount',
			'medianAmount'
		]
		expect(issuesOf({ dataset: 'orders', measures: tooMany })).not.toEqual([])
		expect(
			issuesOf({
				dataset: 'orders',
				measures: ['orders'],
				sort: { by: 'revenue' }
			}).join()
		).toContain(
			'Sort by one of the asked measures or grouped dimensions: orders'
		)
		expect(
			issuesOf({
				dataset: 'orders',
				measures: ['orders'],
				groupBy: ['status'],
				sort: { by: 'status', direction: 'asc' }
			})
		).toEqual([])
		expect(
			issuesOf({
				dataset: 'orders',
				measures: ['orders'],
				groupBy: ['status', 'region', 'tag']
			})
		).not.toEqual([])
		expect(
			issuesOf({ dataset: 'orders', measures: ['orders'], limit: 101 })
		).not.toEqual([])
		expect(
			issuesOf({
				dataset: 'orders',
				measures: ['orders'],
				filters: [{ dimension: 'status', op: 'between', from: 1, to: 2 }]
			})
		).not.toEqual([])
		expect(
			issuesOf({
				dataset: 'orders',
				measures: ['orders'],
				period: { last: { days: 800 } }
			})
		).not.toEqual([])
	})

	test('the result schema accepts a shaped result', () => {
		const result = {
			period: { from: '2026-09-08', to: '2026-10-07', timezone: 'UTC' },
			rows: [{ status: { key: 'PAID', label: 'Paid' }, orders: 3 }],
			totals: { orders: 3 },
			notes: [],
			truncated: false
		}
		expect(analytics.resultSchema('orders').safeParse(result).success).toBe(
			true
		)
	})
})
