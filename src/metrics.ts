/**
 * Named dashboard metrics: a query over a dataset and the shape it is drawn in, or a `resolve`
 * function for numbers a dataset cannot give. The registry runs a batch of them for a caller
 * and yields each as it finishes; the period, the previous period and the tenant scope come
 * from the request and `ctx`, never from a metric.
 */
import { z } from 'zod'
import {
	type Analytics,
	AnalyticsError,
	type AnalyticsErrorCode,
	type QueryBatch
} from './analytics.js'
import type { AnyDataset } from './dataset.js'
import {
	localDate,
	type PeriodInput,
	previousPeriod,
	type ResolvedPeriod
} from './period.js'
import type { Tenant } from './plan.js'
import {
	type DatasetQuery,
	periodOutput,
	periodSchema,
	type QueryRules,
	type ResultOf,
	type ResultPeriod
} from './query.js'
import type {
	MetricOutput,
	OutputForKind,
	OutputKind,
	OutputKindMap,
	TimeGranularity
} from './shapes.js'

/** The buckets a time series is grouped by. */
export type MetricBucket = 'day' | 'week' | 'month'

/** What a metric's `query` and `shape` are run with. */
export type MetricRun<Filters, Ctx = unknown> = {
	/** The metric's own filters, parsed with its `filterSchema`. */
	filters: Filters
	/** The time-bucket dimension to group a series by: the granularity, as near as it gets. */
	bucket: MetricBucket
	granularity: TimeGranularity
	/** The caller, for a filter such as "assigned to me". Its tenant scope is applied anyway. */
	ctx: Ctx
}

/** What a `resolve` metric runs with: also the period, the tenant scope and a signal. */
export type MetricResolveRun<Filters, Ctx = unknown> = MetricRun<
	Filters,
	Ctx
> & {
	/** The local days to count, or null for all time (a snapshot, or no period asked). */
	period: ResolvedPeriod | null
	/** What `analytics.scope(ctx)` gives: filter every read by it. */
	tenant: Tenant
	/** Aborts when the caller stops listening. */
	signal: AbortSignal
}

/**
 * The query the registry runs for a metric's `query`: a grouped query gets no totals unless it
 * says `totals: true`, since they cost a statement per period and the presenters do not read
 * them. A query that does not group has them for free.
 */
type AsRun<Q> = Q extends { totals: boolean }
	? Q
	: Q extends { groupBy: readonly [] }
		? Q
		: Q extends { groupBy: readonly unknown[] }
			? Q & { totals: false }
			: Q

/** A result as `shape` receives it: one period, without `previous`. */
export type MetricQueryResult<DS, Q> = ForShape<ResultOf<DS, AsRun<Q>>>
type ForShape<R> = R extends unknown
	? Omit<R, 'previous' | 'period'> & { period: ResultPeriod }
	: never

/** A metric that takes no filters. */
type NoFilters = z.ZodType<Record<string, never>, Record<string, never>>

type MetricBase<
	Key extends string,
	Kind extends OutputKind,
	Schema extends z.ZodType
> = {
	key: Key
	kind: Kind
	description: string
	/**
	 * False for a snapshot of now: it counts all time and has no previous period. True when
	 * omitted.
	 */
	supportsTimeRange?: boolean | undefined
	/** Parses the request's filters for this metric; no filters when omitted. */
	filterSchema?: Schema | undefined
}

/** A metric over a dataset: the query, and the output its result is drawn in. */
export type MetricDefinition<
	DS extends AnyDataset,
	Key extends string,
	Kind extends OutputKind,
	Schema extends z.ZodType,
	Q extends DatasetQuery<DS>,
	Output extends OutputForKind<Kind>,
	Ctx = unknown
> = MetricBase<Key, Kind, Schema> & {
	/**
	 * The query, without `period` or `compareToPrevious`: the registry sets those. A grouped
	 * query runs without totals unless it says `totals: true`, and a `timeseries` or `pivot`
	 * metric that names no `limit` gets the highest one the analytics instance allows.
	 */
	query: (run: MetricRun<z.output<Schema>, Ctx>) => Q
	/** Called once for the period and once for the previous period. */
	shape: (
		result: MetricQueryResult<DS, Q>,
		run: MetricRun<z.output<Schema>, Ctx>
	) => Output
	resolve?: undefined
}

/**
 * A metric the app computes itself (Prisma, another database), with the period, the previous
 * period and the tenant scope still decided by the registry.
 */
export type ResolveMetricDefinition<
	Key extends string,
	Kind extends OutputKind,
	Schema extends z.ZodType,
	Output extends OutputForKind<Kind>,
	Ctx = unknown
> = MetricBase<Key, Kind, Schema> & {
	/** Called once for the period and, with `compareToPrevious`, once for the previous one. */
	resolve: (
		run: MetricResolveRun<z.output<Schema>, Ctx>
	) => Output | Promise<Output>
	query?: undefined
	shape?: undefined
}

/** What a metric's query leaves out: the registry sets both from the request. */
type SetByRegistry = { period?: undefined; compareToPrevious?: undefined }

/** The datasets (as a union) and the context of an analytics instance's type. */
type DatasetOf<A> = A extends {
	readonly datasets: infer DS extends readonly AnyDataset[]
}
	? DS[number]
	: never
type CtxOf<A> = A extends { scope(ctx: infer Ctx): unknown } ? Ctx : never

/**
 * `defineMetric` for the metrics of an analytics instance: queries are typed by its datasets
 * and `run.ctx` by its context. `Extra` is the app's own fields (the roles a metric allows,
 * catalog metadata), which the registry carries to `canRun` and `available` without reading
 * them. Types only, so metric modules import nothing at runtime:
 *
 * ```ts
 * export const defineMetric = metricDefiner<
 * 	typeof analytics,
 * 	{ allowedRoles?: readonly Role[] }
 * >()
 * ```
 */
export function metricDefiner<
	A extends { readonly datasets: readonly AnyDataset[] },
	Extra extends object = Record<never, never>
>() {
	return <
		const Key extends string,
		const Kind extends OutputKind,
		const Q extends QueryRules<DatasetOf<A>, Q> &
			SetByRegistry &
			DatasetQuery<DatasetOf<A>>,
		Output extends OutputForKind<Kind>,
		Schema extends z.ZodType = NoFilters
	>(
		definition: (
			| MetricDefinition<DatasetOf<A>, Key, Kind, Schema, Q, Output, CtxOf<A>>
			| ResolveMetricDefinition<Key, Kind, Schema, Output, CtxOf<A>>
		) &
			Extra
	) => definition
}

/** Any metric, as the registry holds them. */
export type AnyMetric = {
	key: string
	kind: OutputKind
	description: string
	supportsTimeRange?: boolean | undefined
	// biome-ignore lint/suspicious/noExplicitAny: every metric has its own filters and result
	filterSchema?: z.ZodType<any> | undefined
} & (
	| {
			// biome-ignore lint/suspicious/noExplicitAny: every metric has its own filters and result
			query: (run: MetricRun<any, any>) => DatasetQuery<AnyDataset>
			// biome-ignore lint/suspicious/noExplicitAny: every metric has its own filters and result
			shape: (result: any, run: MetricRun<any, any>) => MetricOutput
			resolve?: undefined
	  }
	| {
			resolve: (
				// biome-ignore lint/suspicious/noExplicitAny: every metric has its own filters and result
				run: MetricResolveRun<any, any>
			) => MetricOutput | Promise<MetricOutput>
			query?: undefined
			shape?: undefined
	  }
)

/** What metric `M` draws. */
export type OutputOfMetric<M> = M extends {
	// biome-ignore lint/suspicious/noExplicitAny: any run
	resolve: (run: any) => infer O
}
	? Awaited<O>
	: // biome-ignore lint/suspicious/noExplicitAny: any result and run
		M extends { shape: (result: any, run: any) => infer O }
		? O
		: never

export type MetricKeyOf<R extends { metrics: readonly AnyMetric[] }> =
	R['metrics'][number]['key']

export type MetricOf<
	R extends { metrics: readonly AnyMetric[] },
	K extends MetricKeyOf<R>
> = Extract<R['metrics'][number], { key: K }>

export type MetricOutputOf<
	R extends { metrics: readonly AnyMetric[] },
	K extends MetricKeyOf<R>
> = OutputOfMetric<MetricOf<R, K>>

/** The filters metric `K` runs with: what its `filterSchema` parses to. */
export type MetricFiltersOf<
	R extends { metrics: readonly AnyMetric[] },
	K extends MetricKeyOf<R>
> = z.output<FilterSchemaOf<MetricOf<R, K>>>

/** The filters a request gives metric `K`: what its `filterSchema` accepts. */
export type MetricFiltersInputOf<
	R extends { metrics: readonly AnyMetric[] },
	K extends MetricKeyOf<R>
> = z.input<FilterSchemaOf<MetricOf<R, K>>>

type FilterSchemaOf<M> = M extends { filterSchema?: infer S }
	? Exclude<S, undefined> extends z.ZodType
		? Exclude<S, undefined>
		: NoFilters
	: NoFilters

export type MetricKeysOfKind<
	R extends { metrics: readonly AnyMetric[] },
	Kind extends OutputKind
> = Extract<R['metrics'][number], { kind: Kind }>['key']

/** One metric's numbers: the period, and the previous period on the same buckets. */
export type MetricResult<Output = MetricOutput> = {
	current: Output
	previous?: Output
	supportsTimeRange: boolean
	/** The local days counted: all time for a snapshot or a request without a period. */
	period: ResultPeriod
}

/** Why a metric failed: the registry's own codes, or the engine's. */
export type MetricErrorCode =
	| 'unknown_metric'
	| 'invalid_filters'
	/** A time series whose query hit its `limit`: drawn, it would show zeros for real days. */
	| 'truncated'
	| 'shape_failed'
	/** Anything else that threw; the message does not say what. */
	| 'internal'
	| AnalyticsErrorCode

/** A failed metric, as `one` throws it and `onError` hears it for the registry's own codes. */
export class MetricError extends Error {
	override readonly name = 'MetricError'
	constructor(
		readonly code: MetricErrorCode,
		message: string,
		readonly key: string
	) {
		super(message)
	}
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
			| {
					result: MetricResult<OutputOfMetric<M>>
					error?: undefined
					code?: undefined
			  }
			| { error: string; code: MetricErrorCode; result?: undefined }
		)
	: never

/** Results by request key (a metric's key unless the request renamed it), typed per key. */
export type MetricResults<M extends readonly AnyMetric[]> = {
	[K in M[number]['key']]?: MetricResult<
		OutputOfMetric<Extract<M[number], { key: K }>>
	>
} & { [requestKey: string]: MetricResult | undefined }

export type MetricsCollection<M extends readonly AnyMetric[]> = {
	results: MetricResults<M>
	errors: { [requestKey: string]: { code: MetricErrorCode; message: string } }
}

/** The period of a request: `period`, or `from` with an optional `to`, or neither. */
type RequestPeriod = {
	/** Local days in `analytics.timezone(ctx)`, as `analytics.query` takes them. */
	period?: PeriodInput | undefined
	/** Instants; the registry counts the local days they fall on. `to` defaults to today. */
	from?: Date | undefined
	to?: Date | undefined
	/** Inferred from the days when omitted: day up to 31 days, week up to 90, else month. */
	granularity?: TimeGranularity | undefined
	compareToPrevious?: boolean | undefined
}

export type MetricsRequest<Key extends string = string> = RequestPeriod & {
	metrics: readonly {
		key: Key
		requestKey?: string | undefined
		filters?: unknown
	}[]
}

/** Per call: aborting stops the metrics' statements and ends the run with the reason. */
export type RunOptions = { signal?: AbortSignal | undefined }

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
		period: z.ZodOptional<z.ZodType<PeriodInput>>
		from: z.ZodOptional<z.ZodDate>
		to: z.ZodOptional<z.ZodDate>
		granularity: z.ZodOptional<z.ZodEnum<{ [G in TimeGranularity]: G }>>
		compareToPrevious: z.ZodDefault<z.ZodBoolean>
	}>
	get<K extends M[number]['key']>(key: K): Extract<M[number], { key: K }>
	/** The metrics `canRun` allows for `ctx`. */
	available(ctx: Ctx): Promise<M[number][]>
	/**
	 * Runs the requested metrics in parallel and yields each as it finishes. Metrics that count
	 * the same rows without grouping (the same dataset, filters and period) are read in one
	 * statement. A metric `ctx` may not run, or whose filters do not parse, fails alone. A metric that supports a time range
	 * counts the request's period (all time without one) and compares with the previous period
	 * when asked; a snapshot counts all time. A request with `period` and `from`, or `to`
	 * without `from`, rejects with `invalid_period`.
	 */
	run(
		request: MetricsRequest<M[number]['key']>,
		ctx: Ctx,
		options?: RunOptions
	): AsyncGenerator<MetricChunk<M[number]>, void, undefined>
	/** `run`, collected: results and errors by request key. */
	collect(
		request: MetricsRequest<M[number]['key']>,
		ctx: Ctx,
		options?: RunOptions
	): Promise<MetricsCollection<M>>
	/** One metric's result; rejects with a `MetricError` when it fails. */
	one<K extends M[number]['key']>(
		key: K,
		request: RequestPeriod & {
			filters?:
				| z.input<FilterSchemaOf<Extract<M[number], { key: K }>>>
				| undefined
		},
		ctx: Ctx,
		options?: RunOptions
	): Promise<MetricResult<OutputOfMetric<Extract<M[number], { key: K }>>>>
}

/** What `onError` hears with each failure. */
export type MetricFailure<Metric> = {
	key: string
	requestKey: string
	code: MetricErrorCode
	/** Undefined for an unknown key. */
	metric: Metric | undefined
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
	/**
	 * Hears every failed metric: the registry's own errors as `MetricError`, a failed query or
	 * `resolve` and a throwing `shape` with what they threw. What it throws is swallowed.
	 */
	onError?:
		| ((error: unknown, failure: MetricFailure<M[number]>, ctx: Ctx) => unknown)
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

const NO_FILTERS = z.object({})

export function createMetricRegistry<
	DS extends readonly AnyDataset[],
	const M extends readonly AnyMetric[],
	Ctx
>(options: MetricRegistryOptions<DS, M, Ctx>): MetricRegistry<M, Ctx> {
	type Metric = M[number]
	type Chunk = MetricChunk<Metric>
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
		period: (periodSchema as z.ZodType<PeriodInput>).optional(),
		from: z.date().optional(),
		to: z.date().optional(),
		granularity: z.enum(GRANULARITIES).optional(),
		compareToPrevious: z.boolean().default(false)
	})

	const report = async (
		error: unknown,
		failure: MetricFailure<Metric>,
		ctx: Ctx
	) => {
		try {
			await options.onError?.(error, failure, ctx)
		} catch {
			// A log that fails must not fail the metric it describes.
		}
	}

	/** The request's local days, or null for all time. */
	const periodOf = async (
		request: RequestPeriod,
		timezone: string,
		ctx: Ctx
	): Promise<ResolvedPeriod | null> => {
		const { period, from, to } = request
		if (period && (from || to)) {
			throw new AnalyticsError(
				'invalid_period',
				'Give either period or from and to, not both'
			)
		}
		if (period) return analytics.period(period, ctx)
		if (!from) {
			if (to)
				throw new AnalyticsError(
					'invalid_period',
					'A range with an end needs a start (from)'
				)
			return null
		}
		const last = to
			? localDate(to, timezone)
			: (await analytics.period({ preset: 'today' }, ctx))?.to
		return analytics.period(
			{
				from: localDate(from, timezone),
				to: last ?? localDate(from, timezone)
			},
			ctx
		)
	}

	async function* run(
		request: MetricsRequest<Metric['key']>,
		ctx: Ctx,
		runOptions: RunOptions = {}
	): AsyncGenerator<Chunk, void, undefined> {
		runOptions.signal?.throwIfAborted()
		// Our own signal too, so a consumer that stops reading stops the statements.
		const controller = new AbortController()
		const signal = runOptions.signal
			? AbortSignal.any([runOptions.signal, controller.signal])
			: controller.signal

		try {
			const timezone = await analytics.timezone(ctx)
			const period = await periodOf(request, timezone, ctx)
			const granularity =
				request.granularity ?? inferGranularity(period?.days ?? null)
			const bucket = bucketFor(granularity)
			const compare = !!request.compareToPrevious
			const allTime: ResultPeriod = { all: true, timezone }

			type Failed = {
				key: string
				requestKey: string
				error: string
				code: MetricErrorCode
			}
			const failed: Failed[] = []
			const tasks = new Map<string, Promise<object>>()
			// Asked up front, so every metric then starts in the same tick and the queries that
			// count the same rows share a statement.
			const allowed = await Promise.all(
				request.metrics.map((requested) => {
					const metric = byKey.get(requested.key)
					return metric ? canRun(metric, ctx) : false
				})
			)
			const batch = analytics.batch()

			for (const [index, requested] of request.metrics.entries()) {
				const requestKey = requested.requestKey ?? requested.key
				const metric = byKey.get(requested.key)
				const fail = (code: MetricErrorCode, message: string) => {
					failed.push({ key: requested.key, requestKey, error: message, code })
					void report(
						new MetricError(code, message, requested.key),
						{ key: requested.key, requestKey, code, metric },
						ctx
					)
				}
				if (!metric) {
					fail('unknown_metric', 'Unknown metric')
					continue
				}
				if (!allowed[index]) {
					fail('forbidden', 'Access denied')
					continue
				}
				const filters = (metric.filterSchema ?? NO_FILTERS).safeParse(
					requested.filters ?? {}
				)
				if (!filters.success) {
					fail('invalid_filters', `Invalid filters: ${filters.error.message}`)
					continue
				}

				const metricRun: MetricRun<unknown, Ctx> = {
					filters: filters.data,
					bucket,
					granularity,
					ctx
				}
				const supportsTimeRange = metric.supportsTimeRange !== false
				const metricPeriod = supportsTimeRange ? period : null
				tasks.set(
					requestKey,
					runMetric(
						metric,
						metricRun,
						metricPeriod,
						compare,
						signal,
						batch
					).then(
						(result): object => ({
							key: metric.key,
							requestKey,
							result: {
								...result,
								supportsTimeRange,
								period: metricPeriod
									? {
											from: metricPeriod.from,
											to: metricPeriod.to,
											timezone: metricPeriod.timezone
										}
									: allTime
							}
						}),
						(error: unknown): object => {
							const { code, message } = describe(error)
							void report(
								error instanceof ShapeError ? error.cause : error,
								{ key: metric.key, requestKey, code, metric },
								ctx
							)
							return { key: metric.key, requestKey, error: message, code }
						}
					)
				)
			}

			const total = failed.length + tasks.size
			let yielded = 0
			const next = (chunk: object) =>
				({ ...chunk, done: ++yielded === total }) as Chunk

			for (const chunk of failed) yield next(chunk)

			const pending = new Map(
				[...tasks].map(([requestKey, task]) => [
					requestKey,
					task.then((chunk) => ({ requestKey, chunk }))
				])
			)
			while (pending.size > 0) {
				const { requestKey, chunk } = await Promise.race(pending.values())
				signal.throwIfAborted()
				pending.delete(requestKey)
				yield next(chunk)
			}
		} finally {
			controller.abort()
		}
	}

	/** One metric's current and previous outputs; throws what failed. */
	const runMetric = async (
		metric: Metric,
		metricRun: MetricRun<unknown, Ctx>,
		period: ResolvedPeriod | null,
		compare: boolean,
		signal: AbortSignal,
		batch: QueryBatch
	): Promise<{ current: MetricOutput; previous?: MetricOutput }> => {
		const withPrevious = compare && period !== null

		if (metric.resolve) {
			const resolve = metric.resolve
			const tenant = analytics.scope(metricRun.ctx)
			const [current, previous] = await Promise.all([
				resolve({ ...metricRun, period, tenant, signal }),
				withPrevious
					? resolve({
							...metricRun,
							period: previousPeriod(period),
							tenant,
							signal
						})
					: undefined
			])
			return previous
				? { current, previous: alignPrevious(previous, current) }
				: { current }
		}

		const query = metric.query(metricRun)
		const grouped = (query.groupBy?.length ?? 0) > 0
		// A series or a grid needs every row: 20 groups would cut it short.
		const everyRow = metric.kind === 'timeseries' || metric.kind === 'pivot'
		// Built here, so `query` checks it when it runs: `never` skips the rules for a query
		// written in place, which cannot be shown for a generic `DS`.
		const result: { truncated: boolean; previous?: object } & Record<
			string,
			unknown
		> = await analytics.query(
			{
				...query,
				...(grouped && query.totals === undefined && { totals: false }),
				...(everyRow &&
					query.limit === undefined && { limit: analytics.maxLimit }),
				period: period ? { from: period.from, to: period.to } : { all: true },
				compareToPrevious: withPrevious
			} as never,
			metricRun.ctx,
			{ signal, metric: metric.key, batch }
		)
		if (metric.kind === 'timeseries' && result.truncated) {
			throw new MetricError(
				'truncated',
				'The series has more points than its query returns; raise its limit or shorten the period',
				metric.key
			)
		}

		const shape = metric.shape
		const { previous, ...current } = result
		try {
			const output = shape(current, metricRun)
			return previous
				? {
						current: output,
						previous: alignPrevious(
							shape({ ...current, ...previous }, metricRun),
							output
						)
					}
				: { current: output }
		} catch (error) {
			throw new ShapeError(error)
		}
	}

	const collect = async (
		request: MetricsRequest<Metric['key']>,
		ctx: Ctx,
		runOptions?: RunOptions
	): Promise<MetricsCollection<M>> => {
		const results: Record<string, MetricResult> = {}
		const errors: MetricsCollection<M>['errors'] = {}
		for await (const chunk of run(request, ctx, runOptions)) {
			if (chunk.error !== undefined)
				errors[chunk.requestKey] = { code: chunk.code, message: chunk.error }
			else results[chunk.requestKey] = chunk.result
		}
		return { results: results as MetricResults<M>, errors }
	}

	return {
		metrics,
		keys,
		requestSchema: requestSchema as MetricRegistry<M, Ctx>['requestSchema'],
		get: (key) => byKey.get(key) as never,
		available: async (ctx) => {
			const allowed = await Promise.all(
				metrics.map((metric) => canRun(metric, ctx))
			)
			return metrics.filter((_, index) => allowed[index])
		},
		run,
		collect,
		one: async (key, request, ctx, runOptions) => {
			const { filters, ...period } = request
			for await (const chunk of run(
				{ ...period, metrics: [{ key, filters }] },
				ctx,
				runOptions
			)) {
				if (chunk.error !== undefined)
					throw new MetricError(chunk.code, chunk.error, key)
				return chunk.result as never
			}
			throw new MetricError('internal', 'The metric gave no result', key)
		}
	}
}

/** A `shape` that threw, kept apart from a failed query. */
class ShapeError extends Error {
	constructor(override readonly cause: unknown) {
		super('The metric could not be drawn')
	}
}

/** The code and the message a failed metric is sent with; only engine messages pass. */
function describe(error: unknown): { code: MetricErrorCode; message: string } {
	if (error instanceof MetricError || error instanceof AnalyticsError)
		return { code: error.code, message: error.message }
	if (error instanceof ShapeError)
		return { code: 'shape_failed', message: error.message }
	return { code: 'internal', message: 'The query failed' }
}

function bucketFor(granularity: TimeGranularity): MetricBucket {
	if (granularity === 'hour' || granularity === 'day') return 'day'
	if (granularity === 'week') return 'week'
	return 'month'
}

function inferGranularity(days: number | null): TimeGranularity {
	if (days === null || days <= 31) return 'day'
	if (days <= 90) return 'week'
	return 'month'
}

/**
 * The previous period's points on the current period's buckets, so a chart overlays them.
 * The two periods have as many days but can differ by a week or month bucket, so points pair
 * from the end; a previous point before the current period's first bucket is dropped.
 */
function alignPrevious(
	previous: MetricOutput,
	current: MetricOutput
): MetricOutput {
	if (previous.kind !== 'timeseries' || current.kind !== 'timeseries')
		return previous
	// Every series of a period has the same buckets; a series only in the previous period
	// takes them from any current series.
	const fallback = current.series[0]?.points ?? []

	return {
		...previous,
		series: previous.series.map((series) => {
			const points =
				current.series.find((entry) => entry.key === series.key)?.points ??
				fallback
			const offset = series.points.length - points.length
			return {
				...series,
				points: series.points.flatMap((point, index) => {
					const target = points[index - offset]
					if (!target) return []
					const aligned = { ...point, ts: target.ts }
					if (target.bucket === undefined) delete aligned.bucket
					else aligned.bucket = target.bucket
					return [aligned]
				})
			}
		})
	}
}

// ---------------------------------------------------------------------------------------------
// Output schemas: for an endpoint's output contract and for parsing cached outputs.

const optional = <T extends z.ZodType>(schema: T) => schema.optional()
const truncatedFlag = optional(z.literal(true))
const scalarMeta = z.record(
	z.string(),
	z.union([z.string(), z.number(), z.boolean(), z.null()])
)

const kpiSchema = z.object({
	kind: z.literal('kpi'),
	value: z.number(),
	label: optional(z.string()),
	unit: optional(z.string()),
	prefix: optional(z.string()),
	suffix: optional(z.string()),
	trend: optional(z.enum(['up', 'down', 'flat']))
})
const timeseriesSchema = z.object({
	kind: z.literal('timeseries'),
	granularity: z.enum(GRANULARITIES),
	series: z.array(
		z.object({
			key: z.string(),
			label: optional(z.string()),
			points: z.array(
				z.object({
					// Coerced, so a result read back from JSON parses too.
					ts: z.coerce.date(),
					bucket: optional(z.string()),
					value: z.number(),
					label: optional(z.string())
				})
			),
			chartType: optional(z.enum(['line', 'bar'])),
			axis: optional(z.enum(['left', 'right'])),
			meta: optional(scalarMeta)
		})
	),
	truncated: truncatedFlag
})
const distributionSchema = z.object({
	kind: z.literal('distribution'),
	total: z.number(),
	segments: z.array(
		z.object({
			key: z.string(),
			label: z.string(),
			value: z.number(),
			percent: optional(z.number())
		})
	),
	chartType: optional(z.enum(['bar', 'donut', 'pie', 'funnel'])),
	truncated: truncatedFlag
})
const tableSchema = z.object({
	kind: z.literal('table'),
	columns: z.array(
		z.object({
			key: z.string(),
			label: z.string(),
			type: optional(z.enum(['string', 'number', 'date', 'boolean'])),
			nullable: optional(z.boolean())
		})
	),
	rows: z.array(z.record(z.string(), z.unknown())),
	total: optional(z.number()),
	truncated: truncatedFlag
})
const leaderboardSchema = z.object({
	kind: z.literal('leaderboard'),
	items: z.array(
		z.object({
			rank: z.number(),
			id: z.string(),
			label: z.string(),
			value: z.number(),
			meta: optional(scalarMeta)
		})
	),
	total: optional(z.number()),
	truncated: truncatedFlag
})
const dimensionRef = z.object({ key: z.string(), label: z.string() })
const pivotSchema = z.object({
	kind: z.literal('pivot'),
	rowDimension: dimensionRef,
	columnDimension: dimensionRef,
	rows: z.array(z.string()),
	columns: z.array(z.string()),
	values: z.array(z.array(z.number())),
	cellTooltips: optional(z.array(z.array(z.string()))),
	totals: optional(
		z.object({
			rowTotals: optional(z.array(z.number())),
			columnTotals: optional(z.array(z.number())),
			grandTotal: optional(z.number())
		})
	),
	truncated: truncatedFlag
})

/** One schema per output kind. */
export const metricOutputSchemas = {
	kpi: kpiSchema,
	timeseries: timeseriesSchema,
	distribution: distributionSchema,
	table: tableSchema,
	leaderboard: leaderboardSchema,
	pivot: pivotSchema
} as unknown as { [K in OutputKind]: z.ZodType<OutputKindMap[K]> }

/** Any metric output, discriminated by `kind`. */
export const MetricOutputSchema = z.discriminatedUnion('kind', [
	kpiSchema,
	timeseriesSchema,
	distributionSchema,
	tableSchema,
	leaderboardSchema,
	pivotSchema
]) as unknown as z.ZodType<MetricOutput>

/** A `MetricResult`, as `run`, `collect` and `one` give it. */
export const MetricResultSchema = z.object({
	current: MetricOutputSchema,
	previous: optional(MetricOutputSchema),
	supportsTimeRange: z.boolean(),
	period: periodOutput
}) as unknown as z.ZodType<MetricResult>
