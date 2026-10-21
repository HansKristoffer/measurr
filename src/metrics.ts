/**
 * Named dashboard metrics: one query over a dataset and the shape it is drawn in. The
 * registry runs a batch of them for a caller and yields each as it finishes; the period, the
 * previous period and the tenant scope come from the request and `ctx`, never from a metric.
 */
import { z } from 'zod'
import type { Analytics } from './analytics.js'
import type { AnyDataset } from './dataset.js'
import { streamBatch } from './handler.js'
import { localDate } from './period.js'
import type { DatasetQuery, QueryResult, ResultOf } from './query.js'
import type {
	MetricOutput,
	OutputForKind,
	OutputKind,
	TimeGranularity
} from './shapes.js'

/** The buckets a time series is grouped by. */
export type MetricBucket = 'day' | 'week' | 'month'

/** What a metric's `query` and `shape` are run with. */
export type MetricRun<Filters> = {
	/** The metric's own filters, parsed with its `filterSchema`. */
	filters: Filters
	/** The time-bucket dimension to group a series by: the granularity, as near as it gets. */
	bucket: MetricBucket
	granularity: TimeGranularity
}

/** A result as `shape` receives it: one period, without `previous`. */
export type MetricQueryResult<DS, Q> =
	ResultOf<DS, Q> extends QueryResult<infer Row, infer Totals, infer _Period>
		? Omit<QueryResult<Row, Totals>, 'previous'>
		: never

export type MetricDefinition<
	DS extends AnyDataset,
	Key extends string,
	Kind extends OutputKind,
	Filters,
	Q extends DatasetQuery<DS>,
	Output extends OutputForKind<Kind>,
	Role extends string = string
> = {
	key: Key
	kind: Kind
	description: string
	/** For `canRun`; the registry does not read it. */
	allowedRoles?: readonly Role[] | undefined
	/** False for a snapshot of now: it counts all time and has no previous period. */
	supportsTimeRange: boolean
	filterSchema: z.ZodType<Filters>
	/** The query, without `period` or `compareToPrevious`: the registry sets those. */
	query: (run: MetricRun<Filters>) => Q
	/** Called once for the period and once for the previous period. */
	shape: (result: MetricQueryResult<DS, Q>, run: MetricRun<Filters>) => Output
}

/**
 * `defineMetric` for metrics over the datasets `DS` (a union), with `allowedRoles` typed as
 * `Role`. Types only, so metric modules need not import the analytics instance:
 *
 * ```ts
 * export const defineMetric = metricDefiner<(typeof datasets)[number], Role>()
 * ```
 */
export function metricDefiner<
	DS extends AnyDataset,
	Role extends string = string
>() {
	return <
		const Key extends string,
		const Kind extends OutputKind,
		Filters,
		const Q extends DatasetQuery<DS>,
		Output extends OutputForKind<Kind>
	>(
		definition: MetricDefinition<DS, Key, Kind, Filters, Q, Output, Role>
	) => definition
}

/** Any metric, as the registry holds them. */
export type AnyMetric = {
	key: string
	kind: OutputKind
	description: string
	allowedRoles?: readonly string[] | undefined
	supportsTimeRange: boolean
	// biome-ignore lint/suspicious/noExplicitAny: every metric has its own filters and result
	filterSchema: z.ZodType<any>
	// biome-ignore lint/suspicious/noExplicitAny: every metric has its own filters and result
	query: (run: MetricRun<any>) => DatasetQuery<AnyDataset>
	// biome-ignore lint/suspicious/noExplicitAny: every metric has its own filters and result
	shape: (result: any, run: MetricRun<any>) => MetricOutput
}

export type MetricKeyOf<R extends { metrics: readonly AnyMetric[] }> =
	R['metrics'][number]['key']

export type MetricOf<
	R extends { metrics: readonly AnyMetric[] },
	K extends MetricKeyOf<R>
> = Extract<R['metrics'][number], { key: K }>

export type MetricOutputOf<
	R extends { metrics: readonly AnyMetric[] },
	K extends MetricKeyOf<R>
> = ReturnType<MetricOf<R, K>['shape']>

export type MetricFiltersOf<
	R extends { metrics: readonly AnyMetric[] },
	K extends MetricKeyOf<R>
> = z.infer<MetricOf<R, K>['filterSchema']>

export type MetricKeysOfKind<
	R extends { metrics: readonly AnyMetric[] },
	Kind extends OutputKind
> = Extract<R['metrics'][number], { kind: Kind }>['key']

/** One metric's numbers: the period, and the previous period on the same buckets. */
export type MetricResult<Output = MetricOutput> = {
	current: Output
	previous?: Output
	supportsTimeRange: boolean
}

/** One metric's result or error, as each finishes. */
export type MetricChunk<M extends AnyMetric = AnyMetric> = M extends AnyMetric
	? {
			key: M['key']
			/** The request's name for it; the key unless one request asks for a metric twice. */
			requestKey: string
			/** Whether this is the last chunk of the request. */
			done: boolean
		} & (
			| { result: MetricResult<ReturnType<M['shape']>>; error?: undefined }
			| { error: string; result?: undefined }
		)
	: never

export type MetricsRequest<Key extends string = string> = {
	metrics: readonly {
		key: Key
		requestKey?: string | undefined
		filters?: unknown
	}[]
	/** Instants; the registry counts the local days they fall on in `analytics.timezone(ctx)`. */
	from?: Date | undefined
	to?: Date | undefined
	/** Inferred from the range when omitted: day up to 31 days, week up to 90, else month. */
	granularity?: TimeGranularity | undefined
	compareToPrevious?: boolean | undefined
}

export type MetricRegistry<M extends readonly AnyMetric[], Ctx> = {
	readonly metrics: M
	/** The keys, for a request schema or a catalog. */
	readonly keys: [M[number]['key'], ...M[number]['key'][]]
	/** The request schema; `.extend` it with the app's own fields. */
	readonly requestSchema: z.ZodObject<{
		metrics: z.ZodArray<
			z.ZodObject<{
				key: z.ZodEnum<{ [K in M[number]['key']]: K }>
				requestKey: z.ZodOptional<z.ZodString>
				filters: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnknown>>
			}>
		>
		from: z.ZodOptional<z.ZodDate>
		to: z.ZodOptional<z.ZodDate>
		granularity: z.ZodOptional<z.ZodEnum<{ [G in TimeGranularity]: G }>>
		compareToPrevious: z.ZodDefault<z.ZodBoolean>
	}>
	get<K extends M[number]['key']>(key: K): Extract<M[number], { key: K }>
	/** The metrics `canRun` allows for `ctx`. */
	available(ctx: Ctx): Promise<M[number][]>
	/**
	 * Runs the requested metrics in parallel and yields each as it finishes. A metric `ctx` may
	 * not run, or whose filters do not parse, fails alone. A metric that supports a time range
	 * counts `from` to `to` (all time without them) and compares with the previous period when
	 * asked; a snapshot counts all time.
	 */
	run(
		request: MetricsRequest<M[number]['key']>,
		ctx: Ctx
	): AsyncGenerator<MetricChunk<M[number]>, void, undefined>
}

export type MetricRegistryOptions<
	DS extends readonly AnyDataset[],
	M extends readonly AnyMetric[],
	Ctx
> = {
	analytics: Analytics<DS, Ctx>
	metrics: M
	/** Whether `ctx` may run `metric`. Every metric runs when omitted. */
	canRun?:
		| ((metric: M[number], ctx: Ctx) => boolean | Promise<boolean>)
		| undefined
	/** Hears a `shape` that throws; the metric fails with "The metric could not be drawn". */
	onShapeError?:
		| ((error: unknown, metric: M[number], ctx: Ctx) => unknown)
		| undefined
}

const GRANULARITIES = [
	'hour',
	'day',
	'week',
	'month',
	'quarter',
	'year'
] as const satisfies readonly TimeGranularity[]

export function createMetricRegistry<
	DS extends readonly AnyDataset[],
	const M extends readonly AnyMetric[],
	Ctx
>(options: MetricRegistryOptions<DS, M, Ctx>): MetricRegistry<M, Ctx> {
	type Metric = M[number]
	const { analytics, metrics } = options
	const byKey = new Map<string, Metric>()
	for (const metric of metrics) {
		if (byKey.has(metric.key))
			throw new Error(`Two metrics use the key ${metric.key}`)
		byKey.set(metric.key, metric)
	}
	const keys = metrics.map((metric) => metric.key) as [
		Metric['key'],
		...Metric['key'][]
	]
	if (keys.length === 0) throw new Error('A registry needs a metric')

	const canRun = (metric: Metric, ctx: Ctx) =>
		options.canRun ? options.canRun(metric, ctx) : true

	const requestSchema = z.object({
		metrics: z
			.array(
				z.object({
					key: z.enum(keys),
					requestKey: z.string().optional(),
					filters: z.record(z.string(), z.unknown()).optional()
				})
			)
			.min(1, 'At least one metric required'),
		from: z.date().optional(),
		to: z.date().optional(),
		granularity: z.enum(GRANULARITIES).optional(),
		compareToPrevious: z.boolean().default(false)
	})

	async function* run(
		request: MetricsRequest<Metric['key']>,
		ctx: Ctx
	): AsyncGenerator<MetricChunk<Metric>, void, undefined> {
		const timezone = await analytics.timezone(ctx)
		const granularity =
			request.granularity ?? inferGranularity(request.from, request.to)
		const bucket = bucketFor(granularity)
		const range =
			request.from && request.to
				? {
						from: localDate(request.from, timezone),
						to: localDate(request.to, timezone)
					}
				: null

		const failed: { key: string; requestKey: string; error: string }[] = []
		// A metric's run and its query meet again by request key.
		const runs = new Map<string, { metric: Metric; run: MetricRun<unknown> }>()
		const queries: Record<string, DatasetQuery<DS[number]>> = {}

		for (const requested of request.metrics) {
			const requestKey = requested.requestKey ?? requested.key
			const fail = (error: string) =>
				failed.push({ key: requested.key, requestKey, error })
			const metric = byKey.get(requested.key)
			if (!metric) {
				fail('Unknown metric')
				continue
			}
			if (!(await canRun(metric, ctx))) {
				fail('Access denied')
				continue
			}
			const filters = metric.filterSchema.safeParse(requested.filters ?? {})
			if (!filters.success) {
				fail(`Invalid filters: ${filters.error.message}`)
				continue
			}

			const metricRun = { filters: filters.data, bucket, granularity }
			const period = metric.supportsTimeRange ? range : null
			queries[requestKey] = {
				...metric.query(metricRun),
				period: period ?? { all: true },
				compareToPrevious: period !== null && !!request.compareToPrevious
			} as DatasetQuery<DS[number]>
			runs.set(requestKey, { metric, run: metricRun })
		}

		const total = failed.length + runs.size
		let yielded = 0
		const next = (chunk: object) =>
			({ ...chunk, done: ++yielded === total }) as MetricChunk<Metric>

		for (const chunk of failed) yield next(chunk)

		for await (const chunk of streamBatch(analytics, queries, ctx)) {
			const prepared = runs.get(chunk.key)
			if (!prepared) continue
			const { metric, run: metricRun } = prepared
			const base = { key: metric.key, requestKey: chunk.key }

			if ('error' in chunk) {
				yield next({ ...base, error: chunk.error.message })
				continue
			}

			let result: MetricResult
			try {
				const { previous, ...current } = chunk.result
				const output = metric.shape(current, metricRun)
				result = {
					current: output,
					supportsTimeRange: metric.supportsTimeRange
				}
				if (previous) {
					result.previous = alignPrevious(
						metric.shape({ ...current, ...previous }, metricRun),
						output
					)
				}
			} catch (error) {
				try {
					await options.onShapeError?.(error, metric, ctx)
				} catch {}
				yield next({ ...base, error: 'The metric could not be drawn' })
				continue
			}
			yield next({ ...base, result })
		}
	}

	return {
		metrics,
		keys,
		requestSchema,
		get: (key) => byKey.get(key) as never,
		available: async (ctx) => {
			const allowed = await Promise.all(
				metrics.map((metric) => canRun(metric, ctx))
			)
			return metrics.filter((_, index) => allowed[index])
		},
		run
	}
}

function bucketFor(granularity: TimeGranularity): MetricBucket {
	if (granularity === 'hour' || granularity === 'day') return 'day'
	if (granularity === 'week') return 'week'
	return 'month'
}

function inferGranularity(from?: Date, to?: Date): TimeGranularity {
	if (!from || !to) return 'day'
	const days = (to.getTime() - from.getTime()) / 86_400_000
	if (days <= 31) return 'day'
	if (days <= 90) return 'week'
	return 'month'
}

/** The previous period's points on the current period's buckets, so a chart overlays them. */
function alignPrevious(
	previous: MetricOutput,
	current: MetricOutput
): MetricOutput {
	if (previous.kind !== 'timeseries' || current.kind !== 'timeseries')
		return previous

	return {
		...previous,
		series: previous.series.map((series) => {
			const points = current.series.find(
				(entry) => entry.key === series.key
			)?.points
			return {
				...series,
				points: series.points.map((point, index) => ({
					...point,
					ts: points?.[index]?.ts ?? point.ts
				}))
			}
		})
	}
}
