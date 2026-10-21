/**
 * Chart-ready shapes of a query result: a KPI, a time series, a distribution, a pivot and a
 * leaderboard. Pure functions over `analytics.query` results, with the previous period when the
 * query compared with it. They add no numbers the result does not hold.
 */
import { bucketStarts } from './period.js'
import type { ResultPeriod } from './query.js'

type DimensionValue = { key: string | number | null; label: string }
type Measures = Record<string, number | null>

/** Any `analytics.query` result. */
type AnyResult = {
	period: ResultPeriod
	rows: readonly Record<string, unknown>[]
	totals: Measures
	previous?: {
		period: ResultPeriod
		rows: readonly Record<string, unknown>[]
		totals: Measures
	}
	truncated: boolean
}

type MeasureOf<R extends AnyResult> = keyof R['totals'] & string
type DimensionOf<R extends AnyResult> = Exclude<
	keyof R['rows'][number] & string,
	MeasureOf<R>
>

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
	unit: 'day' | 'week' | 'month'
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
	/** The measure over every row, so a many-to-many split can add up to more. */
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
	const value = result.totals[measure] ?? null
	if (!result.previous) return { kind: 'kpi', value }

	const previous = result.previous.totals[measure] ?? null
	const change =
		value === null || previous === null || previous === 0
			? null
			: (value - previous) / Math.abs(previous)

	return { kind: 'kpi', value, previous, change }
}

/**
 * One series per value of `series` (or one series named after the measure), with a point for
 * every bucket of the period: buckets without rows get `fill` (0 by default; pass null for
 * averages). Series come in the order they first appear in the rows. Group by the bucket
 * dimension and set a `limit` that covers every bucket and series, or the result is truncated.
 */
export function toTimeseries<R extends AnyResult>(
	result: R,
	options: {
		bucket: DimensionOf<R>
		unit: 'day' | 'week' | 'month'
		measure: MeasureOf<R>
		series?: DimensionOf<R> | undefined
		fill?: number | null
	}
): TimeseriesShape {
	const { bucket, unit, measure, series } = options
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
	return {
		kind: 'timeseries',
		unit,
		series: distinct(result.rows.map(seriesOf)).map(({ key, label }) => ({
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
	options: { by: DimensionOf<R>; measure: MeasureOf<R> }
): DistributionShape {
	const { by, measure } = options
	const total = result.totals[measure] ?? null
	const previous =
		result.previous &&
		new Map(
			result.previous.rows.map((row) => [
				dimensionValue(row, by).key,
				measureValue(row, measure)
			])
		)

	return {
		kind: 'distribution',
		total,
		segments: result.rows.map((row) => {
			const { key, label } = dimensionValue(row, by)
			const value = measureValue(row, measure)
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
		total: result.totals[options.measure] ?? null,
		truncated: result.truncated
	}
}

/** The rows in query order (sort the query by `measure`), ranked from 1. */
export function toLeaderboard<R extends AnyResult>(
	result: R,
	options: { by: DimensionOf<R>; measure: MeasureOf<R> }
): LeaderboardShape {
	const measures = Object.keys(result.totals)

	return {
		kind: 'leaderboard',
		items: result.rows.map((row, index) => ({
			...dimensionValue(row, options.by),
			rank: index + 1,
			value: measureValue(row, options.measure),
			values: Object.fromEntries(
				measures.map((key) => [key, measureValue(row, key)])
			)
		})),
		truncated: result.truncated
	}
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
		bucket: DimensionOf<R> & ('day' | 'week' | 'month')
		measure: MeasureOf<R>
		/** The dimension each series is; one series named after the measure without it. */
		series?: DimensionOf<R> | undefined
		/** Wire keys for series keys (or the measure). */
		keys?: Renames
		/** Labels by wire key, where the dataset's are not the ones to show. */
		labels?: Renames
		chartType?: 'line' | 'bar'
	}
): TimeSeriesOutput {
	const shape = toTimeseries(result, {
		bucket: options.bucket,
		unit: options.bucket,
		measure: options.measure,
		series: options.series
	})

	return {
		kind: 'timeseries',
		granularity: options.bucket,
		series: shape.series.map((series) => {
			const key = rename(options.keys, series.key)
			return {
				key,
				label: options.labels?.[key] ?? series.label,
				points: series.points.map((point) => ({
					ts: new Date(`${point.bucket}T00:00:00.000Z`),
					value: point.value ?? 0
				})),
				...(options.chartType && { chartType: options.chartType })
			}
		})
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
		...(options.chartType && { chartType: options.chartType })
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
		}))
	}
}
