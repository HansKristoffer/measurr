import { describe, expect, test } from 'bun:test'
import {
	type CompiledStatement,
	createAnalytics,
	defineDataset,
	dimension,
	measure,
	type ResolverInput,
	table
} from './index.js'
import { postgresDialect } from './dialects/postgres.js'

type Visit = {
	id: string
	tenantId: string
	kind: 'A' | 'B'
	minutes: number
	createdAt: Date
}

const visit = table<Visit>('visits')

const visits = defineDataset({
	key: 'visits',
	label: 'Visits',
	description: 'One row per visit.',
	from: visit,
	tenantColumn: visit.col('tenantId'),
	time: { created: { column: visit.col('createdAt'), label: 'Created' } },
	measures: {
		visits: measure.count({ label: 'Visits' }),
		minutes: measure.sum(visit.col('minutes'), {
			label: 'Minutes',
			access: 'staff'
		}),
		perVisit: measure.resolved({
			label: 'Minutes per visit',
			result: 'number',
			uses: ['visits', 'minutes']
		}),
		forecast: measure.resolved({ label: 'Forecast', result: 'count' })
	},
	dimensions: {
		kind: dimension.enum(
			visit.col('kind'),
			{ A: 'A', B: 'B' },
			{ label: 'Kind', labels: { A: 'Alpha', B: 'Beta' } }
		)
	}
})

type Ctx = { tenantId: string; staff: boolean }
const ctx: Ctx = { tenantId: 't1', staff: true }
const NOW = new Date('2026-10-07T10:00:00Z')

/** Grouped statements get one row per kind; the totals statement gets one row. */
function setup(
	resolvers: {
		perVisit?: (input: ResolverInput<typeof visits, 'perVisit', Ctx>) => {
			rows: readonly (number | null)[]
			totals: number | null
		}
		forecast?: (input: ResolverInput<typeof visits, 'forecast', Ctx>) => {
			rows: readonly (number | null)[]
			totals: number | null
		}
	} = {}
) {
	const statements: CompiledStatement[] = []
	const calls: ResolverInput<typeof visits, 'perVisit', Ctx>[] = []
	const analytics = createAnalytics({
		datasets: [visits],
		sources: {
			main: {
				dialect: postgresDialect(),
				execute: async (statement) => {
					statements.push(statement)
					if (statement.text.includes('GROUP BY')) {
						return [
							{ g_kind: 'A', m_visits: '2', m_minutes: '30' },
							{ g_kind: 'B', m_visits: '1', m_minutes: null }
						]
					}
					return [{ m_visits: '3', m_minutes: '30', row_count: '3' }]
				}
			}
		},
		tenant: (ctx: Ctx) => ctx.tenantId,
		authorizeField: (_dataset, _key, access, ctx) =>
			access === 'staff' && ctx.staff,
		now: () => NOW,
		resolvers: {
			visits: {
				perVisit: (input) => {
					calls.push(input)
					return (
						resolvers.perVisit?.(input) ?? {
							rows: input.rows.map(({ values }) =>
								values.minutes === null ? null : values.minutes / values.visits
							),
							totals:
								input.totals.minutes === null
									? null
									: input.totals.minutes / input.totals.visits
						}
					)
				},
				forecast: (input) =>
					resolvers.forecast?.(input) ?? {
						rows: input.rows.map(() => 7),
						totals: 7
					}
			}
		}
	})

	return { analytics, statements, calls }
}

describe('resolved measures', () => {
	test('get the rows, the used measures and the totals, and fill the result', async () => {
		const { analytics, calls } = setup()
		const result = await analytics.query(
			{ dataset: 'visits', measures: ['perVisit'], groupBy: ['kind'] },
			ctx
		)

		expect(result.rows).toEqual([
			{ kind: { key: 'A', label: 'Alpha' }, perVisit: 15 },
			{ kind: { key: 'B', label: 'Beta' }, perVisit: null }
		])
		expect(result.totals).toEqual({ perVisit: 10 })

		const [call] = calls
		expect(call?.rows).toEqual([
			{
				dimensions: { kind: { key: 'A', label: 'Alpha' } },
				values: { visits: 2, minutes: 30 }
			},
			{
				dimensions: { kind: { key: 'B', label: 'Beta' } },
				values: { visits: 1, minutes: null }
			}
		])
		expect(call?.totals).toEqual({ visits: 3, minutes: 30 })
		expect(call?.groupBy).toEqual(['kind'])
		expect(call?.tenant).toBe('t1')
		expect(call?.period).toEqual({
			from: '2026-09-08',
			to: '2026-10-07',
			timezone: 'UTC'
		})
	})

	test('the database computes the used measures, not the resolved one', async () => {
		const { analytics, statements } = setup()
		await analytics.query({ dataset: 'visits', measures: ['perVisit'] }, ctx)

		expect(statements).toHaveLength(1)
		expect(statements[0]?.text).toContain('AS "m_visits"')
		expect(statements[0]?.text).toContain('AS "m_minutes"')
		expect(statements[0]?.text).not.toContain('perVisit')
	})

	test('a measure that uses nothing still gets one row per group', async () => {
		const { analytics, statements } = setup()
		const result = await analytics.query(
			{ dataset: 'visits', measures: ['forecast'] },
			ctx
		)

		expect(statements[0]?.text).toContain('count(*) AS "row_count"')
		expect(result.rows).toEqual([{ forecast: 7 }])
		expect(result.totals).toEqual({ forecast: 7 })
	})

	test('count results are never null, and a non-finite value is null', async () => {
		const { analytics } = setup({
			forecast: () => ({ rows: [null, Number.NaN], totals: null }),
			perVisit: () => ({ rows: [Number.POSITIVE_INFINITY, 1], totals: 2 })
		})
		const result = await analytics.query(
			{
				dataset: 'visits',
				measures: ['forecast', 'perVisit'],
				groupBy: ['kind']
			},
			ctx
		)

		expect(result.rows.map(({ forecast }) => forecast)).toEqual([0, 0])
		expect(result.rows.map(({ perVisit }) => perVisit)).toEqual([null, 1])
		expect(result.totals).toEqual({ forecast: 0, perVisit: 2 })
	})

	test('each period of a comparison is resolved on its own', async () => {
		const { analytics, calls } = setup()
		const result = await analytics.query(
			{ dataset: 'visits', measures: ['perVisit'], compareToPrevious: true },
			ctx
		)

		expect(calls.map((call) => call.period)).toEqual([
			{ from: '2026-09-08', to: '2026-10-07', timezone: 'UTC' },
			{ from: '2026-08-09', to: '2026-09-07', timezone: 'UTC' }
		])
		expect(result.previous?.totals).toEqual({ perVisit: 10 })
	})

	test('a resolver returning the wrong number of rows fails the query', async () => {
		const { analytics } = setup({
			perVisit: () => ({ rows: [1], totals: 1 })
		})

		await expect(
			analytics.query(
				{ dataset: 'visits', measures: ['perVisit'], groupBy: ['kind'] },
				ctx
			)
		).rejects.toThrow('returned 1 values for 2 rows')
	})

	test('cannot be sorted by', async () => {
		const { analytics } = setup()

		await expect(
			analytics.query(
				{
					dataset: 'visits',
					measures: ['perVisit'],
					groupBy: ['kind'],
					// @ts-expect-error resolved measures are not sortable
					sort: { by: 'perVisit' }
				},
				ctx
			)
		).rejects.toMatchObject({ code: 'invalid_query' })
	})

	test('need the access of the measures they use', async () => {
		const { analytics } = setup()
		const notStaff = { ...ctx, staff: false }

		await expect(
			analytics.query({ dataset: 'visits', measures: ['perVisit'] }, notStaff)
		).rejects.toMatchObject({ code: 'forbidden' })
		const [catalog] = await analytics.listDatasets(notStaff)
		expect(catalog?.measures.map((entry) => entry.key)).toEqual([
			'visits',
			'forecast'
		])
	})
})

describe('resolved measure definitions', () => {
	test('createAnalytics needs a resolver for every resolved measure', () => {
		expect(() =>
			createAnalytics({
				datasets: [visits],
				sources: {
					main: { dialect: postgresDialect(), execute: async () => [] }
				},
				tenant: () => 't1',
				authorizeField: () => true,
				// @ts-expect-error forecast has no resolver
				resolvers: { visits: { perVisit: () => ({ rows: [], totals: null }) } }
			})
		).toThrow('Dataset visits resolves forecast in the app')
	})

	test('createAnalytics refuses resolvers for anything else', () => {
		expect(() =>
			createAnalytics({
				datasets: [visits],
				sources: {
					main: { dialect: postgresDialect(), execute: async () => [] }
				},
				tenant: () => 't1',
				authorizeField: () => true,
				resolvers: {
					visits: {
						perVisit: () => ({ rows: [], totals: null }),
						forecast: () => ({ rows: [], totals: null }),
						// @ts-expect-error visits is a SQL measure
						visits: () => ({ rows: [], totals: null })
					}
				}
			})
		).toThrow('Resolvers name visits.visits, which is not a resolved measure')
	})

	test('a resolved measure uses only SQL measures of its dataset', () => {
		const define = (uses: string[]) =>
			defineDataset({
				key: 'broken',
				label: 'Broken',
				description: 'Broken.',
				from: visit,
				tenantColumn: visit.col('tenantId'),
				time: { created: { column: visit.col('createdAt'), label: 'Created' } },
				measures: {
					visits: measure.count({ label: 'Visits' }),
					other: measure.resolved({ label: 'Other', result: 'number' }),
					// @ts-expect-error uses must name SQL measures of this dataset
					value: measure.resolved({ label: 'Value', result: 'number', uses })
				},
				dimensions: {}
			})

		expect(() => define(['missing'])).toThrow(
			'measure value uses unknown measure missing'
		)
		expect(() => define(['other'])).toThrow(
			'measure value uses other, which is resolved too'
		)
	})

	test('a ratio cannot divide a resolved measure', () => {
		expect(() =>
			defineDataset({
				key: 'broken',
				label: 'Broken',
				description: 'Broken.',
				from: visit,
				tenantColumn: visit.col('tenantId'),
				time: { created: { column: visit.col('createdAt'), label: 'Created' } },
				measures: {
					visits: measure.count({ label: 'Visits' }),
					forecast: measure.resolved({ label: 'Forecast', result: 'count' }),
					// @ts-expect-error ratios name SQL measures
					rate: measure.ratio('forecast', 'visits', { label: 'Rate' })
				},
				dimensions: {}
			})
		).toThrow('ratio measure rate names forecast, which is resolved')
	})
})
