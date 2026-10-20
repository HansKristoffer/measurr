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
		series?: DimensionOf<R>
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
