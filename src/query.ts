import { z } from 'zod'
import type {
	AnyDataset,
	AnyDimension,
	AnyMeasure,
	Dataset,
	DimensionValue,
	MeasureResult,
	MeasureValue,
	SqlMeasureKey
} from './dataset.js'
import type { TimeBucketUnit } from './expr.js'
import {
	MAX_PERIOD_DAYS,
	type PeriodInput,
	type PeriodPreset
} from './period.js'

export const MAX_MEASURES = 4
export const MAX_GROUP_BY = 2
export const MAX_LIMIT = 100
export const DEFAULT_LIMIT = 20

const PERIOD_PRESETS = [
	'today',
	'yesterday',
	'thisWeek',
	'lastWeek',
	'thisMonth',
	'lastMonth',
	'thisYear'
] as const satisfies readonly PeriodPreset[]

// ---------------------------------------------------------------------------------------------
// Static types

type EmptinessFilter<Name> = { dimension: Name; op: 'isEmpty' | 'isNotEmpty' }

type FilterFor<Name extends string, Dim> = Dim extends {
	category: 'closed'
	keyType?: infer K
}
	?
			| { dimension: Name; op: 'in' | 'notIn'; values: readonly K[] }
			| EmptinessFilter<Name>
	: Dim extends { category: 'open' }
		? // Open sets take keys or labels; labels are resolved at query time.
				| { dimension: Name; op: 'in' | 'notIn'; values: readonly string[] }
				| EmptinessFilter<Name>
		: Dim extends { category: 'numeric' }
			?
					| { dimension: Name; op: 'between'; from: number; to: number }
					| EmptinessFilter<Name>
			:
					| { dimension: Name; op: 'between'; from: string; to: string }
					| EmptinessFilter<Name>

/** Dimensions a query may group by: all but `filterOnly` ones. */
export type GroupableKey<Dm> = {
	[K in keyof Dm & string]: Dm[K] extends { groupable: false } ? never : K
}[keyof Dm & string]

/** Dimensions a query may filter by: all but `groupOnly` ones. */
export type FilterableKey<Dm> = {
	[K in keyof Dm & string]: Dm[K] extends { filterable: false } ? never : K
}[keyof Dm & string]

export type DatasetFilter<Dm> = {
	[Name in FilterableKey<Dm>]: FilterFor<Name, Dm[Name]>
}[FilterableKey<Dm>]

/** The query one dataset accepts. Distributes over a union of datasets. */
export type DatasetQuery<DS> =
	DS extends Dataset<infer K, infer M, infer Dm, infer T>
		? {
				dataset: K
				measures: readonly (keyof M & string)[]
				groupBy?: readonly GroupableKey<Dm>[] | undefined
				filters?: readonly DatasetFilter<Dm>[] | undefined
				/** Null or omitted: the default period. */
				period?: PeriodInput | null | undefined
				time?: T | undefined
				compareToPrevious?: boolean | undefined
				sort?:
					| {
							by: SqlMeasureKey<M> | GroupableKey<Dm>
							direction?: 'asc' | 'desc' | undefined
					  }
					| undefined
				limit?: number | undefined
				/**
				 * False skips the ungrouped totals statement of a grouped query; the result then has
				 * no `totals`. Not offered to models (`querySchema` leaves it out). Defaults to true.
				 */
				totals?: boolean | undefined
			}
		: never

type GroupKeys<Q> = Q extends { groupBy: readonly (infer G extends string)[] }
	? G
	: never

type Simplify<T> = { [K in keyof T]: T[K] } & {}

export type ResultRow<
	M,
	Dm,
	MeasureKey extends string,
	GroupKey extends string
> = Simplify<
	{ [G in GroupKey & keyof Dm]: DimensionValue<Dm[G]> } & {
		[Key in MeasureKey & keyof M]: MeasureValue<M[Key]>
	}
>

export type ResultTotals<M, MeasureKey extends string> = Simplify<{
	[Key in MeasureKey & keyof M]: MeasureValue<M[Key]>
}>

/** The days a result covers: local days `from` to `to` (inclusive), or all time. */
export type ResultPeriod =
	| { from: string; to: string; timezone: string }
	| { all: true; timezone: string }

/** The period query `Q` names; null or none means the dataset's `Default`. */
type QueryPeriod<Q, Default> = Q extends unknown
	? 'period' extends keyof Q
		? OrDefault<Q['period' & keyof Q], Default>
		: Default
	: never
type OrDefault<P, Default> = P extends null | undefined ? Default : P
type PeriodShape<P> = P extends { all: true }
	? Extract<ResultPeriod, { all: true }>
	: Exclude<ResultPeriod, { all: true }>

/** A grouped dimension of a result, as the dataset describes it. */
export type ResultGroupField = {
	key: string
	label: string
	kind: AnyDimension['kind']
	/** For a time bucket: what one bucket is. */
	unit?: TimeBucketUnit
	/** For an enum or computed dimension: every value it can have, in definition order. */
	values?: { key: string; label: string }[]
}

/** A measure of a result, as the dataset describes it. */
export type ResultMeasureField = {
	key: string
	label: string
	/** `count`: a whole number, never null. `ratio`: 0-1. `number`: the rest. */
	valueType: MeasureResult
}

/** What a result's row keys are: its grouped dimensions and its measures, in query order. */
export type ResultFields = {
	groupBy: ResultGroupField[]
	measures: ResultMeasureField[]
}

export type QueryResult<
	Row,
	Totals,
	Period extends ResultPeriod = ResultPeriod
> = {
	period: Period
	rows: Row[]
	totals: Totals
	/** Only for a range: an all-time period has no previous period. */
	previous?: {
		period: { from: string; to: string; timezone: string }
		rows: Row[]
		totals: Totals
	}
	notes: string[]
	/** Whether the period's rows were cut at the query's `limit`. */
	truncated: boolean
	fields: ResultFields
}

/** What a query with `totals: false` returns: no totals for either period. */
export type ResultWithoutTotals<
	Row,
	Period extends ResultPeriod = ResultPeriod
> = Omit<QueryResult<Row, never, Period>, 'totals' | 'previous'> & {
	previous?: {
		period: { from: string; to: string; timezone: string }
		rows: Row[]
	}
}

type WithTotals<Q, Row, Totals, Period extends ResultPeriod> = Q extends {
	totals: false
}
	? ResultWithoutTotals<Row, Period>
	: QueryResult<Row, Totals, Period>

/** `previous` is there whenever the query literally asks for it. */
type WithPrevious<Q, R extends { previous?: unknown }> = Q extends {
	compareToPrevious: true
}
	? R & { previous: NonNullable<R['previous']> }
	: R

/** The typed result of query `Q` against the datasets `DS`. */
export type ResultOf<DS, Q> =
	DS extends Dataset<infer K, infer M, infer Dm, string, infer P>
		? Q extends { dataset: K; measures: readonly (infer Mk extends string)[] }
			? WithPrevious<
					Q,
					WithTotals<
						Q,
						ResultRow<M, Dm, Mk, GroupKeys<Q>>,
						ResultTotals<M, Mk>,
						PeriodShape<QueryPeriod<Q, P>>
					>
				>
			: never
		: never

// ---------------------------------------------------------------------------------------------
// Runtime schemas

const isoDate = z.iso.date().describe('A date, YYYY-MM-DD.')

export const periodSchema = z.union([
	z.object({
		last: z.object({
			days: z
				.number()
				.int()
				.min(1)
				.max(MAX_PERIOD_DAYS)
				.describe('Number of days, ending today.')
		})
	}),
	z.object({ from: isoDate, to: isoDate.describe('Last day, inclusive.') }),
	z.object({ preset: z.enum(PERIOD_PRESETS) }),
	z.object({ all: z.literal(true) }).describe('Every row, with no time filter.')
])

/** How the schema names a dataset's default period, so a model knows what omitting it means. */
function describePeriod(period: PeriodInput): string {
	if ('all' in period) return 'all time (no time filter)'
	if ('last' in period) return `the last ${period.last.days} days`
	if ('from' in period) return `${period.from} to ${period.to}`
	return period.preset
}

function describeList(
	entries: [string, { label: string; description?: string | undefined }][]
) {
	return entries
		.map(
			([key, entry]) =>
				`${key}: ${entry.label}${entry.description ? ` (${entry.description})` : ''}`
		)
		.join(' · ')
}

function nonEmpty(values: string[]): [string, ...string[]] | null {
	const [first, ...rest] = values
	return first === undefined ? null : [first, ...rest]
}

function filterSchema(key: string, dim: AnyDimension) {
	const dimension = z.literal(key)
	const description = `${dim.label}${dim.description ? `: ${dim.description}` : ''}`
	const emptiness = z.object({
		dimension,
		op: z.enum(['isEmpty', 'isNotEmpty'])
	})

	switch (dim.category) {
		case 'closed': {
			const labels: [string, { label: string }][] = Object.entries(
				dim.values
			).map(([value, label]) => [value, { label }])
			const keys = nonEmpty(labels.map(([value]) => value))
			if (!keys) throw new Error(`Dimension ${key} lists no values`)

			const values = z.array(z.enum(keys)).min(1).describe(describeList(labels))
			return z
				.discriminatedUnion('op', [
					z.object({ dimension, op: z.enum(['in', 'notIn']), values }),
					emptiness
				])
				.describe(description)
		}
		case 'open':
			return z
				.discriminatedUnion('op', [
					z.object({
						dimension,
						op: z.enum(['in', 'notIn']),
						values: z
							.array(z.string())
							.min(1)
							.describe('Keys or names; names match case-insensitively.')
					}),
					emptiness
				])
				.describe(description)
		case 'numeric':
			return z
				.discriminatedUnion('op', [
					z.object({
						dimension,
						op: z.literal('between'),
						from: z.number(),
						to: z.number()
					}),
					emptiness
				])
				.describe(`${description} (inclusive range)`)
		case 'time':
			return z
				.discriminatedUnion('op', [
					z.object({
						dimension,
						op: z.literal('between'),
						from: isoDate,
						to: isoDate
					}),
					emptiness
				])
				.describe(`${description} (bucket start dates, inclusive)`)
	}
}

/** How a schema is built: `querySchema()` for callers, `parse` for what `query` accepts. */
export type QuerySchemaOptions = {
	/** The highest `limit`; `MAX_LIMIT` unless `createAnalytics({ maxLimit })` raises it. */
	maxLimit?: number | undefined
	/** Adds the fields only app code may set (`totals`), which a model's schema leaves out. */
	parse?: boolean | undefined
}

/** The input schema branch for one dataset. */
export function datasetQuerySchema(
	dataset: AnyDataset,
	options: QuerySchemaOptions = {}
) {
	const maxLimit = options.maxLimit ?? MAX_LIMIT
	const measures: [string, AnyMeasure][] = Object.entries(dataset.measures)
	const dimensions: [string, AnyDimension][] = Object.entries(
		dataset.dimensions
	)
	const groupable = dimensions.filter(([, dim]) => dim.groupable)
	const filterable = dimensions.filter(([, dim]) => dim.filterable)

	const measureKeys = nonEmpty(measures.map(([key]) => key))
	if (!measureKeys) throw new Error(`Dataset ${dataset.key} has no measures`)
	const groupKeys = nonEmpty(groupable.map(([key]) => key))
	const timeKeys = nonEmpty(Object.keys(dataset.time))
	// The database limits rows before a resolved measure exists, so it cannot sort them.
	const sqlMeasureKeys = measures
		.filter(([, entry]) => entry.kind !== 'resolved')
		.map(([key]) => key)
	const sortKeys =
		nonEmpty([...sqlMeasureKeys, ...(groupKeys ?? [])]) ?? measureKeys

	const notes = groupable
		.filter(([, dim]) => dim.kind === 'manyToMany' && dim.note)
		.map(([key, dim]) => `${key}: ${dim.kind === 'manyToMany' ? dim.note : ''}`)

	const [firstFilter, ...otherFilters] = filterable.map(([key, dim]) =>
		filterSchema(key, dim)
	)

	return z
		.object({
			dataset: z
				.literal(dataset.key)
				.describe(`${dataset.label}. ${dataset.description}`),
			measures: z
				.array(z.enum(measureKeys))
				.min(1)
				.max(MAX_MEASURES)
				.describe(describeList(measures)),
			...(groupKeys && {
				groupBy: z
					.array(z.enum(groupKeys))
					.max(MAX_GROUP_BY)
					.optional()
					.describe([describeList(groupable), ...notes].join('\n'))
			}),
			...(firstFilter && {
				filters: z
					.array(
						z.discriminatedUnion('dimension', [firstFilter, ...otherFilters])
					)
					.optional()
					.describe('Every filter must match.')
			}),
			// Nullable as well: LLM tool callers send null for a field they leave out.
			period: periodSchema
				.describe(
					`Which days to count, in the organization timezone. Defaults to ${describePeriod(dataset.defaultPeriod)}. A range covers at most two years.`
				)
				.nullish(),
			...(timeKeys && {
				time: z
					.enum(timeKeys)
					.optional()
					.describe(
						`Which time field the period applies to; time dimensions name their own. Defaults to ${dataset.defaultTime}. ${describeList(Object.entries(dataset.time))}`
					)
			}),
			compareToPrevious: z
				.boolean()
				.optional()
				.describe(
					'Also return the previous period of the same length. Not for all-time periods.'
				),
			sort: z
				.object({
					by: z.enum(sortKeys),
					direction: z.enum(['asc', 'desc']).optional()
				})
				.optional()
				.describe(
					'One of the asked measures or grouped dimensions. Defaults to time order when grouped by time, otherwise the first measure, descending.'
				),
			limit: z
				.number()
				.int()
				.min(1)
				.max(maxLimit)
				.optional()
				.describe(`Maximum number of groups. Defaults to ${DEFAULT_LIMIT}.`),
			...(options.parse && { totals: z.boolean().optional() })
		})
		.superRefine((query, context) => {
			// Sorting by something the query does not return would be silently ignored.
			// groupBy is spread in conditionally above, which hides its type here.
			const { groupBy } = query as { groupBy?: string[] | undefined }
			const by = query.sort?.by
			const returned: string[] = [...query.measures, ...(groupBy ?? [])]
			if (by !== undefined && !returned.includes(by)) {
				context.addIssue({
					code: 'custom',
					path: ['sort', 'by'],
					message: `Sort by one of the asked measures or grouped dimensions: ${returned.join(', ')}`
				})
			}
			const sortMeasure: AnyMeasure | undefined =
				by === undefined ? undefined : dataset.measures[by]
			if (sortMeasure?.kind === 'resolved') {
				context.addIssue({
					code: 'custom',
					path: ['sort', 'by'],
					message: `${by} is computed after the query runs and cannot be sorted by`
				})
			}

			const period = query.period ?? dataset.defaultPeriod
			if (query.compareToPrevious && 'all' in period) {
				context.addIssue({
					code: 'custom',
					path: ['compareToPrevious'],
					message: 'An all-time period has no previous period to compare with'
				})
			}
		})
}

/** A discriminated union on `dataset`, one branch per dataset. */
export function buildQuerySchema(
	datasets: readonly AnyDataset[],
	options: QuerySchemaOptions = {}
) {
	const [first, ...rest] = datasets.map((dataset) =>
		datasetQuerySchema(dataset, options)
	)
	if (!first) throw new Error('querySchema needs at least one dataset')

	return z.discriminatedUnion('dataset', [first, ...rest])
}

const rangeOutput = z.object({
	from: z.string(),
	to: z.string(),
	timezone: z.string()
})
export const periodOutput = z.union([
	rangeOutput,
	z.object({ all: z.literal(true), timezone: z.string() })
])
const measureValue = z.number().nullable()
const dimensionValue = z.object({
	key: z.union([z.string(), z.number()]).nullable(),
	label: z.string()
})

const fieldsOutput = z.object({
	groupBy: z.array(
		z.object({
			key: z.string(),
			label: z.string(),
			kind: z.enum([
				'enum',
				'computed',
				'relation',
				'manyToMany',
				'number',
				'timePart',
				'timeBucket'
			]),
			unit: z.enum(['day', 'week', 'month']).optional(),
			values: z
				.array(z.object({ key: z.string(), label: z.string() }))
				.optional()
		})
	),
	measures: z.array(
		z.object({
			key: z.string(),
			label: z.string(),
			valueType: z.enum(['count', 'number', 'ratio'])
		})
	)
})

/**
 * The envelope every result shares; only the row and totals shapes differ per dataset.
 * `totals` and `fields` are optional, for `totals: false` and for results stored before
 * `fields` existed.
 */
function resultSchemaOf<Row extends z.ZodType, Totals extends z.ZodType>(
	row: Row,
	totals: Totals
) {
	return z.object({
		period: periodOutput,
		rows: z.array(row),
		totals: totals.optional(),
		previous: z
			.object({
				period: rangeOutput,
				rows: z.array(row),
				totals: totals.optional()
			})
			.optional(),
		notes: z.array(z.string()),
		truncated: z.boolean(),
		fields: fieldsOutput.optional()
	})
}

/** The result schema for one dataset. Row fields exist only for grouped dimensions. */
export function datasetResultSchema(dataset: AnyDataset) {
	const measures = Object.fromEntries(
		Object.entries(dataset.measures).map(([key, entry]) => [
			key,
			measureValue.optional().describe((entry as AnyMeasure).label)
		])
	)
	const dimensions = Object.fromEntries(
		Object.entries(dataset.dimensions).map(([key, entry]) => [
			key,
			dimensionValue.optional().describe((entry as AnyDimension).label)
		])
	)

	return resultSchemaOf(
		z.object({ ...dimensions, ...measures }),
		z.object(measures)
	)
}

/**
 * Any dataset's result, without the per-dataset keys (`analytics.resultSchema(key)` has
 * those): rows hold `{ key, label }` per grouped dimension and a number or null per measure.
 * For contracts that must not depend on the dataset list, such as an LLM tool's output.
 */
export const AnalyticsResultSchema = resultSchemaOf(
	z.record(z.string(), z.union([dimensionValue, measureValue])),
	z.record(z.string(), measureValue)
)
