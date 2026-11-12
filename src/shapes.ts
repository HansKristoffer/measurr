/**
 * Chart-ready shapes of a query result: a KPI, a time series, a distribution, a pivot and a
 * leaderboard. Pure functions over `analytics.query` results, with the previous period when the
 * query compared with it. They add no numbers the result does not hold.
 */
import { bucketStarts } from './period.js'
import type { ResultFields, ResultPeriod } from './query.js'

type BucketUnit = 'day' | 'week' | 'month'
type DimensionValue = { key: string | number | null; label: string }
type Measures = Record<string, number | null>
type Key = string | number | null

/** Any `analytics.query` result, with or without totals (`totals: false`). */
type AnyResult = {
	period: ResultPeriod
	rows: readonly Record<string, unknown>[]
	totals?: Measures
	previous?: {
		period: ResultPeriod
		rows: readonly Record<string, unknown>[]
		totals?: Measures
	}
	truncated: boolean
	fields?: ResultFields
}

type RowOf<R extends AnyResult> = R['rows'][number]
/**
 * The measures: the totals' keys, or the row keys that hold numbers when there are none. A
 * key the query may not have asked for (a list of measures built at runtime) counts too.
 */
type MeasureOf<R extends AnyResult> = R extends { totals: infer T }
	? keyof T & string
	: {
			[K in keyof RowOf<R> & string]-?: [NonNullable<RowOf<R>[K]>] extends [
				number
			]
				? K
				: never
		}[keyof RowOf<R> & string]
type DimensionOf<R extends AnyResult> = Exclude<
	keyof RowOf<R> & string,
	MeasureOf<R>
>

/**
 * Keys to give a series or segment even when no row has them, in this order before any
 * other. `'all'` lists a closed dimension's values from the result's `fields`.
 */
export type IncludeKeys = readonly Key[] | 'all'

export type KpiShape = {
	kind: 'kpi'
	value: number | null
	/** Only when the query compared with the previous period. */
	previous?: number | null
	/** `(value - previous) / |previous|`; null when either is null or previous is 0. */
	change?: number | null
}

export type SeriesPoint = {
	/** The bucket's start date, `YYYY-MM-DD`. */
	bucket: string
	value: number | null
}

export type TimeseriesShape = {
	kind: 'timeseries'
	unit: BucketUnit
	series: {
		key: string | number | null
		label: string
		points: SeriesPoint[]
		/** The previous period's points, its own buckets; compare them by position. */
		previous?: SeriesPoint[]
	}[]
	truncated: boolean
}

export type DistributionShape = {
	kind: 'distribution'
	/**
	 * The measure over every row, so a many-to-many split can add up to more. Null for a
	 * result without totals.
	 */
	total: number | null
	segments: (DimensionValue & {
		value: number | null
		/** `value / total`, 0-1. */
		share: number | null
		previous?: number | null
	})[]
	truncated: boolean
}

export type PivotShape = {
	kind: 'pivot'
	rows: DimensionValue[]
	columns: DimensionValue[]
	/** `values[row][column]`. */
	values: (number | null)[][]
	/** Null for a result without totals. */
	total: number | null
	truncated: boolean
}

export type LeaderboardShape = {
	kind: 'leaderboard'
	items: (DimensionValue & {
		rank: number
		value: number | null
		/** Every measure the query asked for. */
		values: Measures
	})[]
	truncated: boolean
}

export function toKpi<R extends AnyResult>(
	result: R,
	measure: MeasureOf<R>
): KpiShape {
	const totalOf = (period: { rows: AnyResult['rows']; totals?: Measures }) =>
		period.totals
			? (period.totals[measure] ?? null)
			: period.rows[0]
				? measureValue(period.rows[0], measure)
				: null
	const value = totalOf(result)
	if (!result.previous) return { kind: 'kpi', value }

	const previous = totalOf(result.previous)
	const change =
		value === null || previous === null || previous === 0
			? null
			: (value - previous) / Math.abs(previous)

	return { kind: 'kpi', value, previous, change }
}

/**
 * One series per value of `series` (or one series named after the measure, even for a period
 * without rows), with a point for every bucket of the period: buckets without rows get `fill`
 * (0 by default; pass null for averages). Series come in the order they first appear in the
 * rows, after `seriesKeys`. Group by the bucket dimension and set a `limit` that covers every
 * bucket and series, or the result is truncated.
 */
export function toTimeseries<R extends AnyResult>(
	result: R,
	options: {
		/** The time-bucket dimension the query grouped by. */
		bucket: DimensionOf<R>
		/**
		 * What one bucket is. Read from the result's `fields` when omitted; only a result built
		 * by hand, without `fields`, needs it.
		 */
		unit?: BucketUnit | undefined
		measure: MeasureOf<R>
		series?: DimensionOf<R> | undefined
		/** Series to draw even without rows (zero lanes), first. */
		seriesKeys?: IncludeKeys | undefined
		fill?: number | null
	}
): TimeseriesShape {
	const { bucket, measure, series } = options
	const unit = bucketUnit(result, bucket, options.unit)
	const fill = options.fill === undefined ? 0 : options.fill
	const seriesOf = (row: Record<string, unknown>) =>
		series ? dimensionValue(row, series) : { key: measure, label: measure }

	const pointsOf = (
		period: ResultPeriod,
		rows: readonly Record<string, unknown>[],
		key: string | number | null
	): SeriesPoint[] => {
		const values = new Map<string, number | null>()
		for (const row of rows) {
			const start = dimensionValue(row, bucket).key
			if (start === null || seriesOf(row).key !== key) continue
			values.set(String(start), measureValue(row, measure))
		}
		const starts =
			'all' in period
				? [...values.keys()].sort()
				: bucketStarts(period.from, period.to, unit)
		return starts.map((start) => ({
			bucket: start,
			value: values.has(start) ? (values.get(start) ?? null) : fill
		}))
	}

	const { previous } = result
	const lanes = series
		? withKeys(
				result,
				series,
				distinct(result.rows.map(seriesOf)),
				options.seriesKeys
			)
		: [{ key: measure, label: measure }]
	return {
		kind: 'timeseries',
		unit,
		series: lanes.map(({ key, label }) => ({
			key,
			label,
			points: pointsOf(result.period, result.rows, key),
			...(previous && {
				previous: pointsOf(previous.period, previous.rows, key)
			})
		})),
		truncated: result.truncated
	}
}

export function toDistribution<R extends AnyResult>(
	result: R,
	options: {
		by: DimensionOf<R>
		measure: MeasureOf<R>
		/** Segments to list even without rows (value 0), first. */
		segmentKeys?: IncludeKeys | undefined
	}
): DistributionShape {
	const { by, measure } = options
	const total = result.totals ? (result.totals[measure] ?? null) : null
	const previous =
		result.previous &&
		new Map(
			result.previous.rows.map((row) => [
				dimensionValue(row, by).key,
				measureValue(row, measure)
			])
		)

	const values = new Map(
		result.rows.map((row) => [
			dimensionValue(row, by).key,
			measureValue(row, measure)
		])
	)
	const found = result.rows.map((row) => dimensionValue(row, by))
	const segments = options.segmentKeys
		? withKeys(result, by, found, options.segmentKeys)
		: found

	return {
		kind: 'distribution',
		total,
		segments: segments.map(({ key, label }) => {
			const value = values.has(key) ? (values.get(key) ?? null) : 0
			return {
				key,
				label,
				value,
				share: value === null || !total ? null : value / total,
				...(previous && { previous: previous.get(key) ?? null })
			}
		}),
		truncated: result.truncated
	}
}

/**
 * A grid of `measure` by two grouped dimensions. Numeric keys (weekdays, hours) are sorted;
 * other keys keep the order they first appear in. Cells without a row get `fill` (0 by
 * default; pass null for averages).
 */
export function toPivot<R extends AnyResult>(
	result: R,
	options: {
		rows: DimensionOf<R>
		columns: DimensionOf<R>
		measure: MeasureOf<R>
		fill?: number | null
	}
): PivotShape {
	const fill = options.fill === undefined ? 0 : options.fill
	const rowsOf = (dimension: string) =>
		sortNumeric(
			distinct(result.rows.map((row) => dimensionValue(row, dimension)))
		)
	const rows = rowsOf(options.rows)
	const columns = rowsOf(options.columns)
	const values = rows.map(() => columns.map(() => fill))

	for (const row of result.rows) {
		const r = rows.findIndex(
			(entry) => entry.key === dimensionValue(row, options.rows).key
		)
		const c = columns.findIndex(
			(entry) => entry.key === dimensionValue(row, options.columns).key
		)
		const cells = values[r]
		if (cells) cells[c] = measureValue(row, options.measure)
	}

	return {
		kind: 'pivot',
		rows,
		columns,
		values,
		total: result.totals ? (result.totals[options.measure] ?? null) : null,
		truncated: result.truncated
	}
}

/** The rows in query order (sort the query by `measure`), ranked from 1. */
export function toLeaderboard<R extends AnyResult>(
	result: R,
	options: { by: DimensionOf<R>; measure: MeasureOf<R> }
): LeaderboardShape {
	return {
		kind: 'leaderboard',
		items: result.rows.map((row, index) => ({
			...dimensionValue(row, options.by),
			rank: index + 1,
			value: measureValue(row, options.measure),
			// Every measure of the row: dimension values are `{ key, label }` objects.
			values: Object.fromEntries(
				Object.entries(row)
					.filter(([, value]) => typeof value !== 'object' || value === null)
					.map(([key]) => [key, measureValue(row, key)])
			)
		})),
		truncated: result.truncated
	}
}

/** What one bucket of the grouped dimension `bucket` is: `unit`, or what `fields` says. */
function bucketUnit(
	result: AnyResult,
	bucket: string,
	unit: BucketUnit | undefined
): BucketUnit {
	const known =
		unit ?? result.fields?.groupBy.find((field) => field.key === bucket)?.unit
	if (known) return known
	// A result from before `fields`: a dimension named after its unit says enough.
	if (bucket === 'day' || bucket === 'week' || bucket === 'month') return bucket
	throw new Error(
		`${bucket} is not a time bucket the result describes; pass its unit`
	)
}

function dimensionValue(
	row: Record<string, unknown>,
	key: string
): DimensionValue {
	const value = row[key]
	if (typeof value === 'object' && value !== null && 'label' in value) {
		return value as DimensionValue
	}
	throw new Error(`The rows are not grouped by ${key}`)
}

function measureValue(row: Record<string, unknown>, key: string) {
	const value = row[key]
	return typeof value === 'number' ? value : null
}

/**
 * `found` with the keys `include` names first, in its order; a key no row has gets its label
 * from `fields`, or the key itself.
 */
function withKeys(
	result: AnyResult,
	dimension: string,
	found: DimensionValue[],
	include: IncludeKeys | undefined
): DimensionValue[] {
	if (!include) return found
	const field = result.fields?.groupBy.find((entry) => entry.key === dimension)
	const known = field?.values
	if (include === 'all' && !known) {
		throw new Error(
			`'all' needs the closed values of ${dimension}; pass the keys instead`
		)
	}
	const keys =
		include === 'all' ? (known ?? []).map((value) => value.key) : include
	const labelOf = (key: Key) =>
		found.find((value) => value.key === key)?.label ??
		known?.find((value) => value.key === String(key))?.label ??
		(key === null ? 'None' : String(key))

	return distinct([
		...keys.map((key) => ({ key, label: labelOf(key) })),
		...found
	])
}

/** The values by key, first one first. */
function distinct(values: DimensionValue[]): DimensionValue[] {
	const byKey = new Map<string | number | null, DimensionValue>()
	for (const value of values) {
		if (!byKey.has(value.key))
			byKey.set(value.key, { key: value.key, label: value.label })
	}
	return [...byKey.values()]
}

function sortNumeric(values: DimensionValue[]): DimensionValue[] {
	return values.every((value) => typeof value.key === 'number')
		? [...values].sort((a, b) => Number(a.key) - Number(b.key))
		: values
}

// ---------------------------------------------------------------------------------------------
// Presentation: what a dashboard draws. Keys are strings, a missing value is 0, a share is
// 0-100, and labels, units and chart types are the caller's to choose.

export type TimeGranularity =
	| 'hour'
	| 'day'
	| 'week'
	| 'month'
	| 'quarter'
	| 'year'

/** Scalar values a series or a leaderboard row can carry along. */
export type ScalarMeta = Record<string, string | number | boolean | null>

export type KpiOutput = {
	kind: 'kpi'
	value: number
	label?: string
	/** A currency code, or `'PERCENTAGE'` for a share (`percent: true`). */
	unit?: string
	prefix?: string
	suffix?: string
	trend?: 'up' | 'down' | 'flat'
}

export type TimeSeriesPoint = {
	/** The bucket's local start date as UTC midnight (`2026-10-01T00:00:00.000Z`). */
	ts: Date
	/**
	 * The bucket's local start date, `YYYY-MM-DD`. Format this, not `ts` in the viewer's
	 * timezone, which shows the day before west of UTC.
	 */
	bucket?: string
	value: number
	label?: string
}

export type TimeSeriesSeries<
	SeriesKey extends string = string,
	Meta = ScalarMeta | undefined
> = {
	key: SeriesKey
	label?: string
	points: TimeSeriesPoint[]
	chartType?: 'line' | 'bar'
	axis?: 'left' | 'right'
	meta?: Meta
}

export type TimeSeriesOutput<
	SeriesKey extends string = string,
	Meta = ScalarMeta | undefined
> = {
	kind: 'timeseries'
	granularity: TimeGranularity
	series: TimeSeriesSeries<SeriesKey, Meta>[]
	/** Set when the query's rows were cut at its `limit`: the newest buckets are missing. */
	truncated?: true
}

export type DistributionSegment<Key extends string = string> = {
	key: Key
	label: string
	value: number
	/** 0-100. */
	percent?: number
}

export type DistributionChartType = 'bar' | 'donut' | 'pie' | 'funnel'

export type DistributionOutput<Key extends string = string> = {
	kind: 'distribution'
	total: number
	segments: DistributionSegment<Key>[]
	chartType?: DistributionChartType
	/** Set when the query's rows were cut at its `limit`. */
	truncated?: true
}

export type TableColumn<Key extends string = string> = {
	key: Key
	label: string
	type?: 'string' | 'number' | 'date' | 'boolean'
	nullable?: boolean
}

export type TableOutput<
	Row = Record<string, unknown>,
	ColumnKey extends string = string
> = {
	kind: 'table'
	columns: TableColumn<ColumnKey>[]
	rows: Row[]
	total?: number
	/** Set when the query's rows were cut at its `limit`. */
	truncated?: true
}

export type PivotOutput = {
	kind: 'pivot'
	rowDimension: { key: string; label: string }
	columnDimension: { key: string; label: string }
	rows: string[]
	columns: string[]
	/** `values[row][column]`. */
	values: number[][]
	/** Same shape as `values`; empty strings for cells without one. */
	cellTooltips?: string[][]
	totals?: {
		rowTotals?: number[]
		columnTotals?: number[]
		grandTotal?: number
	}
	/** Set when the query's rows were cut at its `limit`. */
	truncated?: true
}

export type LeaderboardItem<Meta = ScalarMeta | undefined> = {
	rank: number
	id: string
	label: string
	value: number
	meta?: Meta
}

export type LeaderboardOutput<Meta = ScalarMeta | undefined> = {
	kind: 'leaderboard'
	items: LeaderboardItem<Meta>[]
	total?: number
	/** Set when the query's rows were cut at its `limit`. */
	truncated?: true
}

export interface OutputKindMap {
	kpi: KpiOutput
	timeseries: TimeSeriesOutput
	distribution: DistributionOutput
	table: TableOutput
	leaderboard: LeaderboardOutput
	pivot: PivotOutput
}

export type OutputKind = keyof OutputKindMap

export type OutputForKind<K extends OutputKind> = OutputKindMap[K]

export type MetricOutput = OutputKindMap[OutputKind]

/** Every output kind, for a select, a schema or a renderer map. */
export const OUTPUT_KINDS = [
	'kpi',
	'timeseries',
	'distribution',
	'table',
	'leaderboard',
	'pivot'
] as const satisfies readonly OutputKind[]

// A kind added to `OutputKindMap` and missing above fails here.
const everyKind: [Exclude<OutputKind, (typeof OUTPUT_KINDS)[number]>] extends [
	never
]
	? true
	: never = true
void everyKind

/**
 * The renderer for `output`'s kind. `map` must name every kind, so a new kind fails typecheck
 * until it has one; a kind the client does not know yet (a newer server) gets `fallback`.
 */
export function pickRenderer<R>(
	map: Readonly<Record<OutputKind, R>>,
	output: { kind: string },
	fallback: R
): R {
	return Object.hasOwn(map, output.kind)
		? map[output.kind as OutputKind]
		: fallback
}

export const isKpi = (output: MetricOutput): output is KpiOutput =>
	output.kind === 'kpi'
export const isTimeSeries = (
	output: MetricOutput
): output is TimeSeriesOutput => output.kind === 'timeseries'
export const isDistribution = (
	output: MetricOutput
): output is DistributionOutput => output.kind === 'distribution'
export const isTable = (output: MetricOutput): output is TableOutput =>
	output.kind === 'table'
export const isLeaderboard = (
	output: MetricOutput
): output is LeaderboardOutput => output.kind === 'leaderboard'
export const isPivot = (output: MetricOutput): output is PivotOutput =>
	output.kind === 'pivot'

/** Wire keys by key (`String(key)`, so `'null'` names the empty group). */
type Renames = Readonly<Record<string, string>>

const rename = (renames: Renames | undefined, key: string | number | null) =>
	renames?.[String(key)] ?? String(key)

const truncation = (result: AnyResult) =>
	result.truncated ? { truncated: true as const } : {}

const fieldLabel = (result: AnyResult, key: string) =>
	result.fields?.groupBy.find((field) => field.key === key)?.label ??
	result.fields?.measures.find((field) => field.key === key)?.label ??
	key

export function presentKpi<R extends AnyResult>(
	result: R,
	measure: MeasureOf<R>,
	display: Omit<KpiOutput, 'kind' | 'value'> & {
		/** A 0-1 share, drawn as 0-100 with the unit `'PERCENTAGE'`. */
		percent?: boolean
	} = {}
): KpiOutput {
	const { percent, ...rest } = display
	const value = toKpi(result, measure).value ?? 0

	return percent
		? { kind: 'kpi', value: value * 100, unit: 'PERCENTAGE', ...rest }
		: { kind: 'kpi', value, ...rest }
}

export function presentTimeseries<R extends AnyResult>(
	result: R,
	options: {
		/** The time-bucket dimension the query grouped by, whatever it is called. */
		bucket: DimensionOf<R>
		measure: MeasureOf<R>
		/** The dimension each series is; one series named after the measure without it. */
		series?: DimensionOf<R> | undefined
		/** Series keys (before `keys` renames them) to draw even without rows, first. */
		seriesKeys?: IncludeKeys | undefined
		/** Wire keys for series keys (or the measure). */
		keys?: Renames
		/** Labels by wire key, where the dataset's are not the ones to show. */
		labels?: Renames
		chartType?: 'line' | 'bar'
	}
): TimeSeriesOutput {
	const shape = toTimeseries(result, {
		bucket: options.bucket,
		measure: options.measure,
		series: options.series,
		seriesKeys: options.seriesKeys
	})

	return {
		kind: 'timeseries',
		granularity: shape.unit,
		series: shape.series.map((series) => {
			const key = rename(options.keys, series.key)
			return {
				key,
				label: options.labels?.[key] ?? series.label,
				points: series.points.map((point) => ({
					ts: new Date(`${point.bucket}T00:00:00.000Z`),
					bucket: point.bucket,
					value: point.value ?? 0
				})),
				...(options.chartType && { chartType: options.chartType })
			}
		}),
		...truncation(result)
	}
}

/**
 * Segments in query order (or `order`), with a `total` the segments add up to, so a
 * many-to-many split still has percentages that sum to 100.
 */
export function presentDistribution<R extends AnyResult>(
	result: R,
	options: {
		by: DimensionOf<R>
		measure: MeasureOf<R>
		/** Segment keys (before `keys` renames them) to list even without rows, first. */
		segmentKeys?: IncludeKeys | undefined
		chartType?: DistributionChartType
		keys?: Renames
		labels?: Renames
		/** Segment order by wire key; keys it does not list go last. */
		order?: readonly string[]
	}
): DistributionOutput {
	const segments = toDistribution(result, options).segments.map((segment) => {
		const key = rename(options.keys, segment.key)
		return {
			key,
			label: options.labels?.[key] ?? segment.label,
			value: segment.value ?? 0
		}
	})
	const { order } = options
	if (order) {
		const rank = (key: string) =>
			order.includes(key) ? order.indexOf(key) : order.length
		segments.sort((a, b) => rank(a.key) - rank(b.key))
	}
	const total = segments.reduce((sum, segment) => sum + segment.value, 0)

	return {
		kind: 'distribution',
		total,
		segments: segments.map((segment) => ({
			...segment,
			percent: total > 0 ? (segment.value / total) * 100 : 0
		})),
		...(options.chartType && { chartType: options.chartType }),
		...truncation(result)
	}
}

export function presentLeaderboard<R extends AnyResult>(
	result: R,
	options: {
		by: DimensionOf<R>
		measure: MeasureOf<R>
		/** What each row carries besides its value, from every measure of the row. */
		meta?: (values: Measures) => ScalarMeta
	}
): LeaderboardOutput {
	return {
		kind: 'leaderboard',
		items: toLeaderboard(result, options).items.map((item) => ({
			rank: item.rank,
			id: String(item.key),
			label: item.label,
			value: item.value ?? 0,
			...(options.meta && { meta: options.meta(item.values) })
		})),
		...truncation(result)
	}
}

/**
 * A grid of `measure` by two grouped dimensions, rows and columns by label. Missing cells
 * are 0. `totals: true` adds row, column and grand totals: sums of the cells, so leave it off
 * for a measure that does not add up (an average, a share, a many-to-many split).
 */
export function presentPivot<R extends AnyResult>(
	result: R,
	options: {
		rows: DimensionOf<R>
		columns: DimensionOf<R>
		measure: MeasureOf<R>
		totals?: boolean
	}
): PivotOutput {
	const shape = toPivot(result, options)
	const values = shape.values.map((cells) => cells.map((cell) => cell ?? 0))
	const sum = (numbers: number[]) => numbers.reduce((a, b) => a + b, 0)
	const columnTotals = shape.columns.map((_, c) =>
		sum(values.map((cells) => cells[c] ?? 0))
	)

	return {
		kind: 'pivot',
		rowDimension: {
			key: options.rows,
			label: fieldLabel(result, options.rows)
		},
		columnDimension: {
			key: options.columns,
			label: fieldLabel(result, options.columns)
		},
		rows: shape.rows.map((row) => row.label),
		columns: shape.columns.map((column) => column.label),
		values,
		...(options.totals && {
			totals: {
				rowTotals: values.map(sum),
				columnTotals,
				grandTotal: sum(columnTotals)
			}
		}),
		...truncation(result)
	}
}

/**
 * The rows as a table: a column per grouped dimension (its label; a time bucket's date) and
 * per measure, in query order, or the `columns` named. Labels come from `fields`.
 */
export function presentTable<R extends AnyResult>(
	result: R,
	options: {
		columns?: readonly (DimensionOf<R> | MeasureOf<R>)[]
		/** Column labels by key, where the dataset's are not the ones to show. */
		labels?: Renames
	} = {}
): TableOutput<Record<string, string | number | null>> {
	const [first] = result.rows
	const fields = result.fields
	const all: TableColumn[] = fields
		? [
				...fields.groupBy.map(
					(field): TableColumn => ({
						key: field.key,
						label: field.label,
						type:
							field.kind === 'timeBucket'
								? 'date'
								: field.kind === 'number' || field.kind === 'timePart'
									? 'number'
									: 'string'
					})
				),
				...fields.measures.map(
					(field): TableColumn => ({
						key: field.key,
						label: field.label,
						type: 'number',
						nullable: field.valueType !== 'count'
					})
				)
			]
		: Object.entries(first ?? {}).map(([key, value]) => ({
				key,
				label: key,
				type: typeof value === 'object' && value !== null ? 'string' : 'number'
			}))
	const columns = (
		options.columns
			? options.columns.flatMap((key) =>
					all.filter((column) => column.key === key)
				)
			: all
	).map((column) => ({
		...column,
		label: options.labels?.[column.key] ?? column.label
	}))

	return {
		kind: 'table',
		columns,
		rows: result.rows.map((row) =>
			Object.fromEntries(
				columns.map(({ key, type }) => {
					const value = row[key]
					if (typeof value !== 'object' || value === null)
						return [key, measureValue(row, key)]
					const { key: groupKey, label } = value as DimensionValue
					return [key, type === 'string' ? label : groupKey]
				})
			)
		),
		...truncation(result)
	}
}
