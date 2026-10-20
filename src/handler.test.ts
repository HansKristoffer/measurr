import { describe, expect, test } from 'bun:test'
import { postgresDialect } from './dialects/postgres.js'
import { orders } from './fixtures/orders.js'
import { queryBatch, streamBatch, toHttpError } from './handler.js'
import { AnalyticsError, createAnalytics } from './index.js'

type Ctx = { tenantId: string | null }

/** Grouped statements wait `slowMs`, so ungrouped ones finish first. */
function analyticsWith(slowMs = 0) {
	return createAnalytics({
		datasets: [orders],
		sources: {
			main: {
				dialect: postgresDialect(),
				execute: async ({ text }) => {
					if (text.includes('"g_status"')) {
						await new Promise((resolve) => setTimeout(resolve, slowMs))
						return [{ g_status: 'PAID', m_orders: 2 }]
					}
					if (text.includes('"orders"."amount"') && text.includes('avg'))
						throw new Error('connection reset')
					return [{ m_orders: 2 }]
				}
			}
		},
		tenant: (ctx: Ctx) => ctx.tenantId
	})
}

const ctx: Ctx = { tenantId: 't1' }

describe('queryBatch', () => {
	test('runs named queries and keeps failures under their names', async () => {
		const { results, errors } = await queryBatch(
			analyticsWith(),
			{
				total: { dataset: 'orders', measures: ['orders'] },
				byStatus: {
					dataset: 'orders',
					measures: ['orders'],
					groupBy: ['status']
				},
				average: { dataset: 'orders', measures: ['averageAmount'] },
				invalid: { dataset: 'orders', measures: [] }
			},
			ctx
		)

		expect(results.total?.totals.orders).toBe(2)
		expect(results.byStatus?.rows[0]?.status.label).toBe('Paid')
		expect(Object.keys(results).sort()).toEqual(['byStatus', 'total'])
		// A driver error is not described, so connection details never reach a caller.
		expect(errors.average).toEqual({
			code: 'internal',
			message: 'The query failed'
		})
		expect(errors.invalid?.code).toBe('invalid_query')
	})
})

describe('streamBatch', () => {
	test('yields each query as it finishes', async () => {
		const keys: string[] = []
		for await (const chunk of streamBatch(
			analyticsWith(20),
			{
				slow: { dataset: 'orders', measures: ['orders'], groupBy: ['status'] },
				fast: { dataset: 'orders', measures: ['orders'] },
				average: { dataset: 'orders', measures: ['averageAmount'] }
			},
			ctx
		)) {
			keys.push(chunk.key)
			if (chunk.key === 'fast' && 'result' in chunk)
				expect(chunk.result.totals.orders).toBe(2)
		}

		expect(keys).toHaveLength(3)
		expect(keys.at(-1)).toBe('slow')
	})

	test('an empty batch yields nothing', async () => {
		const chunks: unknown[] = []
		for await (const chunk of streamBatch(analyticsWith(), {}, ctx))
			chunks.push(chunk)

		expect(chunks).toEqual([])
	})
})

describe('toHttpError', () => {
	test('maps each engine error to a status', async () => {
		const missingTenant = await analyticsWith()
			.query({ dataset: 'orders', measures: ['orders'] }, { tenantId: null })
			.catch((error: AnalyticsError) => error)

		expect(toHttpError(new AnalyticsError('forbidden', 'No'))).toEqual({
			status: 403,
			code: 'FORBIDDEN',
			message: 'No'
		})
		expect(toHttpError(missingTenant as AnalyticsError)).toMatchObject({
			status: 401,
			code: 'UNAUTHORIZED'
		})
		const unknown = new AnalyticsError('unknown_value', 'Unknown tag: "x"', {
			dimension: 'tag',
			unknown: ['x'],
			valid: [{ key: 't1', label: 'Complaint' }]
		})
		expect(toHttpError(unknown)).toEqual({
			status: 400,
			code: 'BAD_REQUEST',
			message: 'Unknown tag: "x"',
			data: { code: 'unknown_value', details: unknown.details }
		})
	})
})
