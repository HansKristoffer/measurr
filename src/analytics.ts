import { z } from 'zod'
import type { CompiledStatement, Dialect, SelectStatement } from './compile.js'
import type {
	AnyDataset,
	AnyDimension,
	AnyMeasure,
	Dataset,
	DimensionValue,
	MeasureValue,
	ResolvedMeasure
} from './dataset.js'
import {
	type NormalizedFilter,
	type NormalizedQuery,
	type ParsedQuery,
	type PlanContext,
	type Tenant,
	type TenantId,
	allTenants,
	normalizeQuery,
	planLookup,
	planQuery,
	resultNotes,
	shapeMeasures,
	shapeRows
} from './plan.js'
import {
	type PeriodInput,
	PeriodError,
	type ResolvedPeriod,
	isValidTimezone,
	previousPeriod,
	resolvePeriod
} from './period.js'
import {
	type DatasetQuery,
	type QueryResult,
	type ResultFields,
	type ResultOf,
	type ResultPeriod,
	type ResultWithoutTotals,
	buildQuerySchema,
	datasetResultSchema,
	periodSchema
} from './query.js'

export type Row = Record<string, unknown>

/** A database: a dialect to compile with and a function that runs the compiled SQL. */
export type AnalyticsSource = {
	readonly dialect: Dialect
	/**
	 * Runs one read-only statement and returns its rows as plain objects. `signal` aborts when
	 * the caller gives up (a closed stream), so a driver that supports it can cancel.
	 */
	execute(
		statement: CompiledStatement,
		options?: { signal?: AbortSignal | undefined }
	): Promise<readonly Row[]>
}

/** Per call: a signal that cancels the query, and the metric it runs for. */
export type QueryOptions = {
	/** Aborting rejects the query with the signal's reason and stops its statements. */
	signal?: AbortSignal | undefined
	/** The metric the query runs for; `onQuery` and the cache hear it. */
	metric?: string | undefined
}

export type AnalyticsErrorCode =
	| 'invalid_query'
	| 'forbidden'
	| 'missing_tenant'
	| 'invalid_timezone'
	| 'invalid_period'
	| 'unknown_value'

/** What `details` holds for each error code. */
export type AnalyticsErrorDetails = {
	/** The schema's issues, for a model to fix its query. */
	invalid_query: readonly z.core.$ZodIssue[]
	forbidden: undefined
	missing_tenant: undefined
	invalid_timezone: undefined
	invalid_period: undefined
	/** The values that matched nothing, and the values that exist. */
	unknown_value: {
		dimension: string
		unknown: string[]
		valid: { key: string; label: string }[]
	}
}

export class AnalyticsError<
	C extends AnalyticsErrorCode = AnalyticsErrorCode
> extends Error {
	override readonly name = 'AnalyticsError'
	readonly details: AnalyticsErrorDetails[C]

	constructor(
		readonly code: C,
		message: string,
		...[details]: AnalyticsErrorDetails[C] extends undefined
			? []
			: [details: AnalyticsErrorDetails[C]]
	) {
		super(message)
		this.details = details as AnalyticsErrorDetails[C]
	}
}

/** One `AnalyticsError` type per code, so checking `code` narrows `details`. */
export type AnalyticsErrorOf<
	C extends AnalyticsErrorCode = AnalyticsErrorCode
> = C extends AnalyticsErrorCode ? AnalyticsError<C> : never

/**
 * Whether `error` is an `AnalyticsError` (with `code`, when given). The result narrows by
 * code: `if (isAnalyticsError(error, 'unknown_value')) error.details.valid`.
 */
export function isAnalyticsError<
	C extends AnalyticsErrorCode = AnalyticsErrorCode
>(error: unknown, code?: C): error is AnalyticsErrorOf<C> {
	return (
		error instanceof AnalyticsError &&
		(code === undefined || error.code === code)
	)
}

/** What `onQuery` hears about each `analytics.query` call. */
export type AnalyticsQueryEvent = {
	/** The dataset asked for; null when the input named no known dataset. */
	dataset: string | null
	/** The metric the query ran for, when a metric registry ran it. */
	metric?: string
	durationMs: number
	/** Rows returned; 0 on error. */
	rows: number
	outcome: 'success' | 'error'
	/** Whether `cache` answered the query; absent without a cache or when it never got that far. */
	cache?: 'hit' | 'miss'
	/** What the query threw, on error. */
	error?: unknown
}

/** The measure and dimension keys of a dataset (of any dataset, for a union). */
export type FieldKey<D> =
	D extends Dataset<string, infer M, infer Dm> ? keyof (M & Dm) & string : never

/** The access keys a dataset's measures and dimensions are marked with. */
export type AccessKey<D> =
	D extends Dataset<string, infer M, infer Dm>
		? NonNullable<(M & Dm)[keyof (M & Dm)]['access']>
		: never

/** The resolved measures of a dataset. */
export type ResolvedKey<D> =
	D extends Dataset<string, infer M>
		? {
				[K in keyof M & string]: M[K] extends { kind: 'resolved' } ? K : never
			}[keyof M & string]
		: never

/** The values of the measures resolved measure `K` uses. */
type UsedValues<D, K> =
	D extends Dataset<string, infer M>
		? M[K & keyof M] extends ResolvedMeasure<MeasureResult, infer U>
			? { [Used in U & keyof M]: MeasureValue<M[Used]> }
			: never
		: never

type MeasureResult = ResolvedMeasure['result']

/** What a resolver gets for one period of one query. */
export type ResolverInput<D, K, Ctx> =
	D extends Dataset<string, infer _M, infer Dm>
		? {
				/**
				 * The result rows in order: their grouped dimensions and the measures `K` uses. One
				 * row when the query has no `groupBy`.
				 */
				rows: readonly {
					dimensions: { [G in keyof Dm]?: DimensionValue<Dm[G]> }
					values: UsedValues<D, K>
				}[]
				/** The used measures over every row of the period, ungrouped. */
				totals: UsedValues<D, K>
				groupBy: readonly (keyof Dm & string)[]
				/** The query's filters, open-dimension labels already resolved to keys. */
				filters: readonly NormalizedFilter[]
				/** The period being resolved: the query's, or its previous one. */
				period: ResultPeriod
				tenant: Tenant
				ctx: Ctx
			}
		: never

/** One value per row, in the same order, and one for the totals. */
export type ResolverOutput = {
	rows: readonly (number | null)[]
	totals: number | null
}

export type MeasureResolver<D, K, Ctx> = (
	input: ResolverInput<D, K, Ctx>
) => ResolverOutput | Promise<ResolverOutput>

/** The code for every resolved measure, by dataset and measure. */
export type AnalyticsResolvers<DS extends readonly AnyDataset[], Ctx> = {
	[D in DS[number] as [ResolvedKey<D>] extends [never] ? never : D['key']]: {
		[K in ResolvedKey<D>]: MeasureResolver<D, K, Ctx>
	}
}

export type AnalyticsOptions<DS extends readonly AnyDataset[], Ctx> = {
	datasets: DS
	/** Databases by name; a dataset's `source` picks one, or the only one is used. */
	sources: Record<string, AnalyticsSource>
	/**
	 * The tenant every query is scoped to, or a list of them (an empty list matches no rows).
	 * Queries without one (null, undefined, '', a list holding one of those) are refused.
	 * Return `allTenants` to drop the tenant filter, only for callers allowed to see every
	 * tenant's rows.
	 */
	tenant: (ctx: Ctx) => Tenant | null | undefined
	/**
	 * Whether `ctx` may query `dataset`. Everything is allowed when omitted. It decides what
	 * `listDatasets(ctx)` and `querySchema({ ctx })` offer, and is checked again on every query.
	 */
	authorize?:
		| ((dataset: DS[number], ctx: Ctx) => boolean | Promise<boolean>)
		| undefined
	/**
	 * Whether `ctx` may use the measure or dimension `key` of `dataset`, which is marked with
	 * `access`. Called only for marked fields, once per access key: a ratio also needs the
	 * access of the measures it divides. Required when any field is marked. It decides which
	 * fields `listDatasets(ctx)` and `querySchema({ ctx })` offer, and is checked again on every
	 * query. `access` is the union of the keys the datasets use, so a new key shows up here.
	 */
	authorizeField?:
		| ((
				dataset: DS[number],
				key: FieldKey<DS[number]>,
				access: AccessKey<DS[number]>,
				ctx: Ctx
		  ) => boolean | Promise<boolean>)
		| undefined
	/** IANA timezone periods and time buckets resolve in. UTC when omitted. */
	timezone?:
		| ((
				ctx: Ctx
		  ) => string | null | undefined | Promise<string | null | undefined>)
		| undefined
	/** The clock periods and `minutesAgo` resolve against. */
	now?: (() => Date) | undefined
	/**
	 * The highest `limit` `query` accepts, for app code such as a long time series. The schemas
	 * `querySchema` gives a model keep 100. Defaults to 100.
	 */
	maxLimit?: number | undefined
	/**
	 * How many statements run at once on each source, so a large dashboard cannot take every
	 * pooled connection. Unlimited when omitted.
	 */
	concurrency?: number | undefined
	/**
	 * Called once per `query`, after it succeeds or fails: for metrics and logs. What it
	 * throws or rejects with is swallowed, so it can never fail a query.
	 */
	onQuery?: ((event: AnalyticsQueryEvent, ctx: Ctx) => unknown) | undefined
	/**
	 * Where finished results are kept and looked up. What it throws or rejects with is
	 * swallowed: a failing cache is a miss, never a failed query. With a cache, identical
	 * queries that run at the same time also share one run.
	 */
	cache?: AnalyticsCache<Ctx, DS[number]['key']> | undefined
	/**
	 * The code for `measure.resolved` measures, by dataset and measure key: called once per
	 * period with the result rows and the values of the measures each one uses. Required for
	 * every resolved measure (`createAnalytics` throws otherwise). What it throws fails the
	 * query; a value that is not a finite number counts as null.
	 */
	resolvers?: NoInfer<AnalyticsResolvers<DS, Ctx>> | undefined
}

/**
 * A store for finished results, such as Redis. Keys name the dataset and hash everything that
 * decides the result: the query with its defaults, the tenant scope, the timezone and the
 * resolved days. A query is parsed and authorized before the cache is asked, so a cached result
 * never reaches a caller who may not run the query. Results are plain JSON.
 */
export type AnalyticsCache<Ctx, Key extends string = string> = {
	/**
	 * The stored result, or null/undefined for a miss. Return a miss to bypass the cache for a
	 * caller (a refresh button); its fresh result is still stored. A stored value that is not a
	 * result of this dataset counts as a miss, so a changed definition does not break queries.
	 */
	get(key: string, entry: CacheEntry<Ctx, Key>): unknown
	/** Stores a result; pick the time to live per `dataset` (or per `metric`). */
	set(
		key: string,
		result: QueryResult<Row, Row> | ResultWithoutTotals<Row>,
		entry: CacheEntry<Ctx, Key>
	): unknown
}

/** What the cache is told about a result besides its key. */
export type CacheEntry<Ctx, Key extends string = string> = {
	dataset: Key
	ctx: Ctx
	/** The metric the query runs for, when a metric registry runs it. */
	metric?: string
}

export type DatasetCatalogEntry<Key extends string = string> = {
	key: Key
	label: string
	description: string
	time: { key: string; label: string }[]
	measures: {
		key: string
		label: string
		description: string | undefined
		/** `count`: a whole number, never null. `ratio`: 0-1 (`share`, `ratio`). `number`: the rest. */
		valueType: 'count' | 'number' | 'ratio'
	}[]
	dimensions: {
		key: string
		label: string
		description: string | undefined
		kind: AnyDimension['kind']
		category: AnyDimension['category']
		groupable: boolean
		filterable: boolean
		values: { key: string; label: string }[] | undefined
	}[]
}

export type Analytics<DS extends readonly AnyDataset[], Ctx> = {
	readonly datasets: DS
	/** Parses, authorizes, plans, compiles, runs and shapes one query. */
	query<const Q extends DatasetQuery<DS[number]>>(
		input: Q,
		ctx: Ctx,
		options?: QueryOptions
	): Promise<ResultOf<DS[number], Q>>
	/** The compiled statements a query would run, without running them or resolving labels. */
	explain(
		input: DatasetQuery<DS[number]>,
		ctx: Ctx
	): Promise<CompiledStatement[]>
	/**
	 * The input schema: a discriminated union on `dataset`, for the datasets listed (all when
	 * omitted), typed for those datasets only. One schema is built per set of datasets and
	 * reused.
	 */
	querySchema<const K extends DS[number]['key'] = DS[number]['key']>(options?: {
		datasets?: readonly K[] | undefined
	}): z.ZodType<DatasetQuery<Extract<DS[number], { key: K }>>>
	/**
	 * The input schema for the datasets `ctx` may query, without the fields `authorizeField`
	 * refuses it, for a tool built per caller. Rejects with `forbidden` when none are allowed.
	 */
	querySchema(options: {
		ctx: Ctx
	}): Promise<z.ZodType<DatasetQuery<DS[number]>>>
	/** The result schema for one dataset. */
	resultSchema(dataset: DS[number]['key']): z.ZodType<QueryResult<Row, Row>>
	/**
	 * The timezone `ctx`'s periods and buckets resolve in: the `timezone` hook's answer, UTC
	 * when it has none. Rejects with `invalid_timezone` for a name the runtime does not know.
	 */
	timezone(ctx: Ctx): Promise<string>
	/**
	 * A period in `ctx`'s timezone: its local days and the instants they start and end at, or
	 * null for all time. Rejects with `invalid_period` as `query` would.
	 */
	period(input: PeriodInput, ctx: Ctx): Promise<ResolvedPeriod | null>
	/**
	 * The tenant scope every query for `ctx` gets, for code that reads the same rows another
	 * way (Prisma, another database). Rejects with `missing_tenant` as `query` would.
	 */
	scope(ctx: Ctx): Tenant
	/** The datasets `ctx` may query, with the measures and dimensions it may use. */
	listDatasets(ctx: Ctx): Promise<DatasetCatalogEntry<DS[number]['key']>[]>
}

export type AnalyticsQuery<A> =
	A extends Analytics<infer DS, never> ? DatasetQuery<DS[number]> : never

export type AnalyticsResult<A, Q> =
	A extends Analytics<infer DS, never> ? ResultOf<DS[number], Q> : never

/** A result as the engine builds it: `totals` absent for `totals: false`. */
type ShapedResult = {
	period: ResultPeriod
	rows: Row[]
	totals?: Row
	previous?: {
		period: Extract<ResultPeriod, { from: string }>
		rows: Row[]
		totals?: Row
	}
	notes: string[]
	truncated: boolean
	fields?: ResultFields
}

// biome-ignore lint/suspicious/noExplicitAny: resolvers are typed per dataset where they are declared.
type AnyResolver = (input: any) => ResolverOutput | Promise<ResolverOutput>

/** A measure or dimension marked with `access`, with every access key it needs. */
type RestrictedField = {
	kind: 'measure' | 'dimension'
	key: string
	access: readonly string[]
}

/** A parsed, authorized query with everything the hooks decide resolved. */
type Prepared = {
	dataset: AnyDataset
	query: NormalizedQuery
	tenant: Tenant
	timezone: string
	/** Null for all time. */
	period: ResolvedPeriod | null
	previous: ResolvedPeriod | null
	now: Date
}

export function createAnalytics<const DS extends readonly AnyDataset[], Ctx>(
	options: AnalyticsOptions<DS, Ctx>
): Analytics<DS, Ctx> {
	const datasets: readonly AnyDataset[] = options.datasets
	const sourceNames = Object.keys(options.sources)
	const byKey = new Map<string, AnyDataset>()
	const sourceOf = new Map<string, AnalyticsSource>()
	const restrictedOf = new Map<string, RestrictedField[]>()
	/** A hash of each definition, so a deploy that changes a measure misses the cache. */
	const fingerprints = new Map<string, Promise<string>>()

	for (const dataset of datasets) {
		if (byKey.has(dataset.key))
			throw new Error(`Two datasets use the key ${dataset.key}`)
		byKey.set(dataset.key, dataset)

		const source = resolveSource(dataset, options.sources, sourceNames)
		sourceOf.set(dataset.key, source)
		const compiled = compileEverything(dataset, source.dialect)
		if (options.cache) {
			fingerprints.set(
				dataset.key,
				sha256(compiled + stableJson(catalogEntry(dataset)))
			)
		}

		const restricted = restrictedFields(dataset)
		if (restricted.length > 0 && !options.authorizeField) {
			throw new Error(
				`Dataset ${dataset.key} marks fields with access, but createAnalytics has no authorizeField`
			)
		}
		restrictedOf.set(dataset.key, restricted)
	}

	const resolvers = (options.resolvers ?? {}) as Record<
		string,
		Record<string, AnyResolver> | undefined
	>
	for (const [datasetKey, entries] of Object.entries(resolvers)) {
		const dataset = byKey.get(datasetKey)
		if (!dataset)
			throw new Error(`Resolvers name unknown dataset ${datasetKey}`)
		for (const key of Object.keys(entries ?? {})) {
			const entry: AnyMeasure | undefined = dataset.measures[key]
			if (entry?.kind !== 'resolved') {
				throw new Error(
					`Resolvers name ${datasetKey}.${key}, which is not a resolved measure`
				)
			}
		}
	}
	for (const dataset of datasets) {
		for (const [key, entry] of Object.entries<AnyMeasure>(dataset.measures)) {
			if (entry.kind === 'resolved' && !resolvers[dataset.key]?.[key]) {
				throw new Error(
					`Dataset ${dataset.key} resolves ${key} in the app, but createAnalytics has no resolver for it`
				)
			}
		}
	}

	const now = options.now ?? (() => new Date())
	const querySchemas = new Map<string, z.ZodType>()
	const resultSchemas = new Map<string, z.ZodType>()
	// What `query` parses: every dataset, the app-only fields, and the app's `maxLimit`.
	const parseSchema = buildQuerySchema(datasets, {
		parse: true,
		maxLimit: options.maxLimit
	})
	const limiters = new Map<AnalyticsSource, Acquire>()
	if (options.concurrency !== undefined) {
		for (const source of new Set(Object.values(options.sources)))
			limiters.set(source, semaphore(options.concurrency))
	}
	/** Runs in flight by cache key, so identical queries at the same time share one run. */
	const inFlight = new Map<string, Shared<ShapedResult>>()

	/** Runs one statement within the source's concurrency, unless `signal` has aborted. */
	const execute = async (
		source: AnalyticsSource,
		statement: CompiledStatement,
		signal: AbortSignal | undefined
	) => {
		signal?.throwIfAborted()
		const release = await limiters.get(source)?.(signal)
		try {
			signal?.throwIfAborted()
			return await (signal
				? source.execute(statement, { signal })
				: source.execute(statement))
		} finally {
			release?.()
		}
	}

	const datasetOf = (key: string): AnyDataset => {
		const dataset = byKey.get(key)
		if (!dataset)
			throw new AnalyticsError('invalid_query', `Unknown dataset ${key}`, [])
		return dataset
	}

	const sourceFor = (dataset: AnyDataset) => {
		const source = sourceOf.get(dataset.key)
		if (!source) throw new Error(`No source for ${dataset.key}`)
		return source
	}

	/** One schema per set of datasets (or views of them without some fields). */
	const querySchemaFor = (selected: readonly AnyDataset[]) => {
		const keyOf = (dataset: AnyDataset) => {
			if (byKey.get(dataset.key) === dataset) return dataset.key

			const fields = [
				...Object.keys(dataset.measures),
				...Object.keys(dataset.dimensions)
			]
			return `${dataset.key}(${fields.join(' ')})`
		}
		const selectionKey = selected.map(keyOf).sort().join(',')

		let schema = querySchemas.get(selectionKey)
		if (!schema) {
			schema = buildQuerySchema(selected)
			querySchemas.set(selectionKey, schema)
		}
		return schema
	}

	const resultSchemaFor = (key: string) => {
		let schema = resultSchemas.get(key)
		if (!schema) {
			schema = datasetResultSchema(datasetOf(key))
			resultSchemas.set(key, schema)
		}
		return schema
	}

	/** The marked fields of `dataset` that `ctx` may not use. */
	const deniedFields = async (
		dataset: AnyDataset,
		ctx: Ctx
	): Promise<RestrictedField[]> => {
		const restricted = restrictedOf.get(dataset.key) ?? []
		// Keys and access marks are read from the datasets themselves, so they fit the hook.
		const authorizeField = options.authorizeField as
			| ((
					dataset: AnyDataset,
					key: string,
					access: string,
					ctx: Ctx
			  ) => boolean | Promise<boolean>)
			| undefined
		// createAnalytics refuses marked fields without the hook; deny them all regardless.
		if (restricted.length === 0 || !authorizeField) return restricted

		const mayUse = async (field: RestrictedField) => {
			const answers = await Promise.all(
				field.access.map((access) =>
					authorizeField(dataset, field.key, access, ctx)
				)
			)
			return answers.every(Boolean)
		}

		const allowed = await Promise.all(restricted.map(mayUse))
		return restricted.filter((_, index) => !allowed[index])
	}

	/**
	 * The datasets `ctx` may query, each without the fields it may not use. A dataset without
	 * a tenant column needs `allTenants`, and one without a usable measure is left out.
	 */
	const allowedDatasets = async (ctx: Ctx): Promise<AnyDataset[]> => {
		const everyTenant = options.tenant(ctx) === allTenants
		const views = await Promise.all(
			datasets.map(async (dataset) => {
				if (!dataset.tenantColumn && !everyTenant) return null
				if (options.authorize && !(await options.authorize(dataset, ctx)))
					return null

				const view = withoutFields(dataset, await deniedFields(dataset, ctx))
				return Object.keys(view.measures).length > 0 ? view : null
			})
		)
		return views.filter((view) => view !== null)
	}

	const querySchemaForCtx = async (ctx: Ctx) => {
		const allowed = await allowedDatasets(ctx)
		if (allowed.length === 0) {
			throw new AnalyticsError('forbidden', 'No dataset is allowed')
		}
		return querySchemaFor(allowed)
	}

	const scopeOf = (ctx: Ctx): Tenant => {
		const tenant: unknown = options.tenant(ctx)
		if (!isTenant(tenant)) {
			throw new AnalyticsError(
				'missing_tenant',
				'Refusing to query without a tenant'
			)
		}
		return tenant
	}

	const resolveIn = (
		input: PeriodInput,
		timezone: string,
		at: Date
	): ResolvedPeriod | null => {
		if ('all' in input) return null
		try {
			return resolvePeriod(input, timezone, at)
		} catch (error) {
			if (error instanceof PeriodError) {
				throw new AnalyticsError('invalid_period', error.message)
			}
			throw error
		}
	}

	const periodOf = async (input: PeriodInput, ctx: Ctx) => {
		const parsed = periodSchema.safeParse(input)
		if (!parsed.success) {
			throw new AnalyticsError(
				'invalid_period',
				`Invalid period: ${z.prettifyError(parsed.error)}`
			)
		}
		return resolveIn(parsed.data, await timezoneOf(ctx), now())
	}

	/** Parse, authorize, and resolve everything that comes from hooks. */
	const timezoneOf = async (ctx: Ctx) => {
		const timezone = (await options.timezone?.(ctx)) || 'UTC'
		if (!isValidTimezone(timezone)) {
			throw new AnalyticsError(
				'invalid_timezone',
				`Unknown timezone ${timezone}`
			)
		}
		return timezone
	}

	const prepare = async (input: unknown, ctx: Ctx): Promise<Prepared> => {
		const parsed = parseSchema.safeParse(input)
		if (!parsed.success) {
			throw new AnalyticsError(
				'invalid_query',
				`Invalid analytics query: ${z.prettifyError(parsed.error)}`,
				parsed.error.issues
			)
		}

		const parsedQuery = parsed.data as ParsedQuery
		const dataset = datasetOf(parsedQuery.dataset)
		if (options.authorize && !(await options.authorize(dataset, ctx))) {
			throw new AnalyticsError(
				'forbidden',
				`Not allowed to query ${dataset.key}`
			)
		}

		// Sorting names only asked measures and grouped dimensions, so these cover it.
		const dimensionsUsed = [
			...(parsedQuery.groupBy ?? []),
			...(parsedQuery.filters ?? []).map((filter) => filter.dimension)
		]
		const refused = (await deniedFields(dataset, ctx)).filter((field) =>
			field.kind === 'measure'
				? parsedQuery.measures.includes(field.key)
				: dimensionsUsed.includes(field.key)
		)
		if (refused.length > 0) {
			const names = refused.map((field) => `${field.kind} ${field.key}`)
			throw new AnalyticsError(
				'forbidden',
				`Not allowed to use ${names.join(', ')} of ${dataset.key}`
			)
		}

		const tenant = scopeOf(ctx)
		// Never drop a narrower scope: rows without a tenant are only for every-tenant callers.
		if (!dataset.tenantColumn && tenant !== allTenants) {
			throw new AnalyticsError(
				'forbidden',
				`${dataset.key} has no tenant column; only a caller allowed to see every tenant may query it`
			)
		}

		const timezone = await timezoneOf(ctx)
		const query = normalizeQuery(dataset, parsedQuery)
		const at = now()
		const period = resolveIn(query.period, timezone, at)
		// The schema refuses compareToPrevious with an all-time period.
		const previous =
			query.compareToPrevious && period ? previousPeriod(period) : null

		return { dataset, query, tenant, timezone, period, previous, now: at }
	}

	const runQuery = async (
		prepared: Prepared,
		ctx: Ctx,
		signal: AbortSignal | undefined
	): Promise<ShapedResult> => {
		const { dataset, query, tenant, timezone, period, previous, now } = prepared
		const source = sourceFor(dataset)
		const { dialect } = source
		const run = (statement: SelectStatement) =>
			execute(source, dialect.compile(statement), signal)

		const resolvedValues = await resolveOpenValues(
			dataset,
			query,
			tenant,
			now,
			run,
			dialect
		)

		const range = ({ from, to }: ResolvedPeriod) => ({ from, to, timezone })

		const runPeriod = async (target: ResolvedPeriod | null) => {
			const statements = periodStatements(dataset, query, {
				tenant,
				timezone,
				period: target,
				now,
				resolvedValues
			})
			const [rawRows, rawTotals] = await Promise.all([
				run(statements.rows),
				statements.totals ? run(statements.totals) : null
			])

			const { rows, kept, truncated } = shapeRows(
				dataset,
				query,
				rawRows,
				dialect
			)
			// Without a totals statement, a grouped query's totals stay empty (and unreturned).
			const grouped = query.groupBy.length > 0
			const totalsRow = (rawTotals ?? (grouped ? [] : rawRows))[0] ?? {}
			const totals = shapeMeasures(dataset, query.measures, totalsRow, dialect)

			for (const key of query.measures) {
				const entry: AnyMeasure | undefined = dataset.measures[key]
				if (entry?.kind !== 'resolved') continue

				const used = (raw: Row) =>
					shapeMeasures(dataset, entry.uses, raw, dialect)
				const resolver = resolvers[dataset.key]?.[key]
				if (!resolver) throw new Error(`No resolver for ${dataset.key}.${key}`)

				const output = await resolver({
					rows: kept.map((raw, index) => ({
						dimensions: Object.fromEntries(
							query.groupBy.map((group) => [group, rows[index]?.[group]])
						),
						values: used(raw)
					})),
					totals: used(totalsRow),
					groupBy: query.groupBy,
					filters: query.filters.map((filter) => {
						const resolved = resolvedValues.get(filter.dimension)
						return resolved && 'values' in filter
							? { ...filter, values: [...resolved] }
							: filter
					}),
					period: target ? range(target) : { all: true, timezone },
					tenant,
					ctx
				})
				if (output.rows.length !== rows.length) {
					throw new Error(
						`The resolver for ${dataset.key}.${key} returned ${output.rows.length} values for ${rows.length} rows`
					)
				}

				const value = (raw: number | null | undefined) => {
					const finite =
						typeof raw === 'number' && Number.isFinite(raw) ? raw : null
					return entry.result === 'count' ? (finite ?? 0) : finite
				}
				rows.forEach((row, index) => {
					row[key] = value(output.rows[index])
				})
				totals[key] = value(output.totals)
			}

			return { rows, ...(query.totals && { totals }), truncated }
		}

		const [current, before] = await Promise.all([
			runPeriod(period),
			previous &&
				runPeriod(previous).then(({ rows, totals }) => ({
					period: range(previous),
					rows,
					...(totals && { totals })
				}))
		])

		return {
			period: period ? range(period) : { all: true, timezone },
			rows: current.rows,
			...(current.totals && { totals: current.totals }),
			...(before && { previous: before }),
			notes: resultNotes(dataset, query),
			truncated: current.truncated
		}
	}

	const datasetKeyOf = (input: unknown) => {
		if (typeof input !== 'object' || input === null) return null
		const key = 'dataset' in input ? input.dataset : undefined
		return typeof key === 'string' && byKey.has(key) ? key : null
	}

	const report = (event: AnalyticsQueryEvent, ctx: Ctx) => {
		try {
			// Promise.resolve covers async hooks, which reject instead of throwing.
			Promise.resolve(options.onQuery?.(event, ctx)).catch(() => {})
		} catch {
			// Metrics and logs must never fail the query they describe.
		}
	}

	/** The cached result, or null; a failing or malformed cache entry is a miss. */
	const cachedResult = async (
		key: string,
		entry: CacheEntry<Ctx>
	): Promise<ShapedResult | null> => {
		try {
			const value = await options.cache?.get(key, entry)
			if (value === null || value === undefined) return null
			const parsed = resultSchemaFor(entry.dataset).safeParse(value)
			return parsed.success ? (parsed.data as ShapedResult) : null
		} catch {
			return null
		}
	}

	const store = (key: string, result: ShapedResult, entry: CacheEntry<Ctx>) => {
		try {
			Promise.resolve(
				options.cache?.set(key, result as QueryResult<Row, Row>, entry)
			).catch(() => {})
		} catch {
			// A cache that cannot store is a slower query, not a failed one.
		}
	}

	const query = async (
		input: unknown,
		ctx: Ctx,
		queryOptions: QueryOptions = {}
	): Promise<ShapedResult> => {
		const { signal, metric } = queryOptions
		const startedAt = performance.now()
		const dataset = datasetKeyOf(input)
		const durationMs = () => Math.round(performance.now() - startedAt)
		let cache: AnalyticsQueryEvent['cache']

		try {
			signal?.throwIfAborted()
			const prepared = await prepare(input, ctx)
			const entry: CacheEntry<Ctx> = {
				dataset: prepared.dataset.key,
				ctx,
				...(metric !== undefined && { metric })
			}
			const fingerprint = fingerprints.get(prepared.dataset.key)
			const key =
				options.cache && fingerprint
					? await cacheKey(prepared, await fingerprint)
					: null
			let result = key ? await cachedResult(key, entry) : null
			if (key) cache = result ? 'hit' : 'miss'
			if (!result) {
				result = key
					? await share(
							inFlight,
							key,
							async (shared) => {
								const fresh = await runQuery(prepared, ctx, shared)
								store(key, fresh, entry)
								return fresh
							},
							signal
						)
					: await runQuery(prepared, ctx, signal)
			}

			report(
				{
					dataset,
					...(metric !== undefined && { metric }),
					durationMs: durationMs(),
					rows: result.rows.length,
					outcome: 'success',
					...(cache && { cache })
				},
				ctx
			)
			return {
				...result,
				fields: resultFields(prepared.dataset, prepared.query)
			}
		} catch (error) {
			report(
				{
					dataset,
					...(metric !== undefined && { metric }),
					durationMs: durationMs(),
					rows: 0,
					outcome: 'error',
					...(cache && { cache }),
					error
				},
				ctx
			)
			throw error
		}
	}

	const explain = async (
		input: unknown,
		ctx: Ctx
	): Promise<CompiledStatement[]> => {
		const { dataset, query, tenant, timezone, period, previous, now } =
			await prepare(input, ctx)
		const { dialect } = sourceFor(dataset)
		const compiled: CompiledStatement[] = []

		for (const target of previous ? [period, previous] : [period]) {
			const statements = periodStatements(dataset, query, {
				tenant,
				timezone,
				period: target,
				now,
				resolvedValues: new Map()
			})
			compiled.push(dialect.compile(statements.rows))
			if (statements.totals) compiled.push(dialect.compile(statements.totals))
		}

		return compiled
	}

	return {
		datasets: options.datasets,
		query: query as Analytics<DS, Ctx>['query'],
		explain,
		querySchema: ((
			schemaOptions?: { datasets?: readonly string[] } | { ctx: Ctx }
		) =>
			schemaOptions && 'ctx' in schemaOptions
				? querySchemaForCtx(schemaOptions.ctx)
				: querySchemaFor(
						schemaOptions?.datasets?.map(datasetOf) ?? datasets
					)) as Analytics<DS, Ctx>['querySchema'],
		resultSchema: (key) =>
			resultSchemaFor(key) as z.ZodType<QueryResult<Row, Row>>,
		timezone: timezoneOf,
		period: periodOf,
		scope: scopeOf,
		listDatasets: async (ctx) =>
			(await allowedDatasets(ctx)).map(
				(dataset) =>
					catalogEntry(dataset) as DatasetCatalogEntry<DS[number]['key']>
			)
	}
}

/**
 * The cache key of a prepared query: its dataset, then a SHA-256 of everything that decides
 * the result. Resolved days are part of it, so `last 30 days` moves on at local midnight.
 */
async function cacheKey(
	prepared: Prepared,
	fingerprint: string
): Promise<string> {
	const { dataset, query, tenant, timezone, period, previous } = prepared
	const days = (target: ResolvedPeriod | null) =>
		target && [target.from, target.to]
	const scope =
		tenant === allTenants
			? { all: true }
			: Array.isArray(tenant)
				? [...new Set(tenant.map((id) => JSON.stringify(id)))].sort()
				: tenant
	const text = stableJson({
		definition: fingerprint,
		query,
		tenant: scope,
		timezone,
		period: days(period),
		previous: days(previous)
	})

	return `measurr:${dataset.key}:${await sha256(text)}`
}

async function sha256(text: string): Promise<string> {
	const digest = await crypto.subtle.digest(
		'SHA-256',
		new TextEncoder().encode(text)
	)
	return Array.from(new Uint8Array(digest), (byte) =>
		byte.toString(16).padStart(2, '0')
	).join('')
}

type Acquire = (signal: AbortSignal | undefined) => Promise<() => void>

/** At most `max` holders at once; the rest wait in order, and leave the queue on abort. */
function semaphore(max: number): Acquire {
	if (!Number.isInteger(max) || max < 1)
		throw new Error(
			`concurrency must be a whole number of at least 1, not ${max}`
		)
	let active = 0
	const queue: (() => void)[] = []
	const release = () => {
		const next = queue.shift()
		if (next) next()
		else active--
	}

	return async (signal) => {
		if (active < max) {
			active++
			return release
		}
		await new Promise<void>((resolve, reject) => {
			const onAbort = () => {
				queue.splice(queue.indexOf(wake), 1)
				reject(signal?.reason)
			}
			const wake = () => {
				signal?.removeEventListener('abort', onAbort)
				resolve()
			}
			queue.push(wake)
			signal?.addEventListener('abort', onAbort, { once: true })
		})
		return release
	}
}

type Shared<T> = {
	promise: Promise<T>
	controller: AbortController
	waiting: number
}

/**
 * One run of `start` for every caller that asks for `key` while it is in flight. A caller's
 * abort rejects only its own wait; the run stops when every caller has aborted.
 */
function share<T>(
	inFlight: Map<string, Shared<T>>,
	key: string,
	start: (signal: AbortSignal) => Promise<T>,
	signal: AbortSignal | undefined
): Promise<T> {
	let entry = inFlight.get(key)
	if (!entry) {
		const controller = new AbortController()
		const created: Shared<T> = {
			controller,
			waiting: 0,
			promise: start(controller.signal).finally(() => {
				if (inFlight.get(key) === created) inFlight.delete(key)
			})
		}
		inFlight.set(key, created)
		entry = created
	}
	const shared = entry
	shared.waiting++
	if (!signal) return shared.promise

	return new Promise<T>((resolve, reject) => {
		const onAbort = () => {
			if (--shared.waiting === 0) {
				if (inFlight.get(key) === shared) inFlight.delete(key)
				shared.controller.abort(signal.reason)
			}
			reject(signal.reason)
		}
		signal.addEventListener('abort', onAbort, { once: true })
		shared.promise.then(resolve, reject).finally(() => {
			signal.removeEventListener('abort', onAbort)
		})
	})
}

/** JSON with object keys sorted, so equal values give equal text. */
function stableJson(value: unknown): string {
	return JSON.stringify(value, (_key, inner: unknown) =>
		inner && typeof inner === 'object' && !Array.isArray(inner)
			? Object.fromEntries(
					Object.entries(inner).sort(([a], [b]) => (a < b ? -1 : 1))
				)
			: inner
	)
}

/**
 * Fails closed: only a non-empty string, a finite number, a list of those or `allTenants`
 * scopes a query, even when a JavaScript caller's hook returns something its type does not
 * allow.
 */
function isTenant(value: unknown): value is Tenant {
	return (
		value === allTenants ||
		isTenantId(value) ||
		(Array.isArray(value) && value.every(isTenantId))
	)
}

function isTenantId(value: unknown): value is TenantId {
	return (
		(typeof value === 'string' && value !== '') ||
		(typeof value === 'number' && Number.isFinite(value))
	)
}

/**
 * The statement for a period's rows, and for its totals when the query groups and wants them
 * (or a resolved measure needs them).
 */
function periodStatements(
	dataset: AnyDataset,
	query: NormalizedQuery,
	context: PlanContext
) {
	const grouped = query.groupBy.length > 0
	const resolved = query.measures.some(
		(key) =>
			(dataset.measures[key] as AnyMeasure | undefined)?.kind === 'resolved'
	)

	return {
		rows: planQuery(dataset, query, context, true),
		totals:
			grouped && (query.totals || resolved)
				? planQuery(dataset, query, context, false)
				: null
	}
}

function resolveSource(
	dataset: AnyDataset,
	sources: Record<string, AnalyticsSource>,
	sourceNames: string[]
): AnalyticsSource {
	const name =
		dataset.source ?? (sourceNames.length === 1 ? sourceNames[0] : undefined)
	if (!name) {
		throw new Error(
			`Dataset ${dataset.key} names no source, and there are several: ${sourceNames.join(', ')}`
		)
	}

	const source = sources[name]
	if (!source)
		throw new Error(`Dataset ${dataset.key} uses unknown source ${name}`)

	return source
}

/**
 * Compiles every measure, grouping and filter once, so a definition the dialect cannot render
 * fails when the app starts instead of on the first query.
 */
function compileEverything(dataset: AnyDataset, dialect: Dialect): string {
	const now = new Date(0)
	const context: PlanContext = {
		tenant: dataset.tenantColumn ? 'tenant' : allTenants,
		timezone: 'UTC',
		period: resolvePeriod({ last: { days: 1 } }, 'UTC', now),
		now,
		resolvedValues: new Map()
	}
	const measures = Object.keys(dataset.measures)
	const base = normalizeQuery(dataset, { dataset: dataset.key, measures })
	const texts: string[] = []
	const compile = (statement: SelectStatement) => {
		texts.push(dialect.compile(statement).text)
	}

	try {
		compile(planQuery(dataset, base, context, true))

		for (const [key, dimension] of Object.entries<AnyDimension>(
			dataset.dimensions
		)) {
			if (dimension.groupable) {
				compile(planQuery(dataset, { ...base, groupBy: [key] }, context, true))
			}
			if (dimension.filterable) {
				const filter =
					dimension.category === 'numeric'
						? { dimension: key, op: 'between' as const, from: 0, to: 1 }
						: dimension.category === 'time'
							? {
									dimension: key,
									op: 'between' as const,
									from: '2000-01-01',
									to: '2000-01-02'
								}
							: { dimension: key, op: 'in' as const, values: ['value'] }
				compile(
					planQuery(dataset, { ...base, filters: [filter] }, context, true)
				)
			}
		}
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error)
		throw new Error(
			`Dataset ${dataset.key} does not compile for ${dialect.name}: ${message}`
		)
	}
	return texts.join('\n')
}

/**
 * Turns the keys or labels given for open dimensions (tags, teams) into keys. An unknown value
 * fails with the valid values listed, so a model can fix its query in one retry.
 */
async function resolveOpenValues(
	dataset: AnyDataset,
	query: NormalizedQuery,
	tenant: Tenant,
	now: Date,
	run: (statement: SelectStatement) => Promise<readonly Row[]>,
	dialect: Dialect
): Promise<Map<string, (string | number)[]>> {
	const resolved = new Map<string, (string | number)[]>()

	for (const filter of query.filters) {
		if (filter.op !== 'in' && filter.op !== 'notIn') continue
		const dimension: AnyDimension | undefined =
			dataset.dimensions[filter.dimension]
		if (dimension?.category !== 'open') continue

		const wanted = filter.values.map(String)
		const found = await run(
			planLookup(dataset, filter.dimension, tenant, wanted, now)
		)
		const keys = new Set<string | number>()
		const unknown: string[] = []

		for (const value of wanted) {
			const matches = found.filter(
				(row) =>
					String(row.key) === value ||
					String(row.label ?? '').toLowerCase() === value.toLowerCase()
			)
			if (matches.length === 0) unknown.push(value)
			for (const match of matches) keys.add(decodeKey(match.key, dialect))
		}

		if (unknown.length > 0) {
			const valid = (
				await run(planLookup(dataset, filter.dimension, tenant, null, now))
			).map((row) => ({
				key: String(decodeKey(row.key, dialect)),
				label: String(row.label ?? row.key)
			}))
			const list = valid
				.map((entry) => `${entry.label} (${entry.key})`)
				.join(', ')
			const quoted = unknown.map((value) => `"${value}"`).join(', ')
			throw new AnalyticsError(
				'unknown_value',
				`Unknown ${dimension.label.toLowerCase()}: ${quoted}. Valid values: ${list || 'none'}.`,
				{ dimension: filter.dimension, unknown, valid }
			)
		}

		resolved.set(filter.dimension, [...keys])
	}

	return resolved
}

function decodeKey(value: unknown, dialect: Dialect): string | number {
	if (typeof value === 'string') return value

	return dialect.decodeNumber(value) ?? String(value)
}

/**
 * Every marked field of `dataset` with the access keys it needs: its own, and for a ratio
 * those of the measures it divides, which it would leak otherwise.
 */
function restrictedFields(dataset: AnyDataset): RestrictedField[] {
	const measures: Record<string, AnyMeasure> = dataset.measures
	// defineDataset refuses ratio cycles, and resolved measures use only SQL measures.
	const accessOf = (key: string): string[] => {
		const entry = measures[key]
		if (!entry) return []
		const own = entry.access === undefined ? [] : [entry.access]
		switch (entry.kind) {
			case 'ratio':
				return [
					...own,
					...accessOf(entry.numerator),
					...accessOf(entry.denominator)
				]
			case 'resolved':
				return [...own, ...entry.uses.flatMap(accessOf)]
			default:
				return own
		}
	}

	return [
		...Object.keys(measures).map((key) => ({
			kind: 'measure' as const,
			key,
			access: [...new Set(accessOf(key))]
		})),
		...Object.entries<AnyDimension>(dataset.dimensions).map(([key, entry]) => ({
			kind: 'dimension' as const,
			key,
			access: entry.access === undefined ? [] : [entry.access]
		}))
	].filter((field) => field.access.length > 0)
}

/** `dataset` without the given fields; the dataset itself when there are none. */
function withoutFields(
	dataset: AnyDataset,
	fields: readonly RestrictedField[]
): AnyDataset {
	if (fields.length === 0) return dataset

	const keep = <Field>(
		kind: RestrictedField['kind'],
		entries: Record<string, Field>
	): Record<string, Field> =>
		Object.fromEntries(
			Object.entries(entries).filter(
				([key]) =>
					!fields.some((field) => field.kind === kind && field.key === key)
			)
		)
	return {
		...dataset,
		measures: keep('measure', dataset.measures),
		dimensions: keep('dimension', dataset.dimensions)
	}
}

function catalogEntry(dataset: AnyDataset): DatasetCatalogEntry {
	return {
		key: dataset.key,
		label: dataset.label,
		description: dataset.description,
		time: Object.entries<{ label: string }>(dataset.time).map(
			([key, field]) => ({
				key,
				label: field.label
			})
		),
		measures: Object.entries<AnyMeasure>(dataset.measures).map(
			([key, entry]) => ({
				key,
				label: entry.label,
				description: entry.description,
				valueType: entry.result
			})
		),
		dimensions: Object.entries<AnyDimension>(dataset.dimensions).map(
			([key, entry]) => ({
				key,
				label: entry.label,
				description: entry.description,
				kind: entry.kind,
				category: entry.category,
				groupable: entry.groupable,
				filterable: entry.filterable,
				values: closedValues(entry)
			})
		)
	}
}

function closedValues(dimension: AnyDimension) {
	return dimension.kind === 'enum' || dimension.kind === 'computed'
		? Object.entries(dimension.values).map(([key, label]) => ({ key, label }))
		: undefined
}

/** What a result's keys are, from the definitions: grouped dimensions, then measures. */
function resultFields(
	dataset: AnyDataset,
	query: NormalizedQuery
): ResultFields {
	return {
		groupBy: query.groupBy.map((key) => {
			const dimension: AnyDimension = dataset.dimensions[key]
			const values = closedValues(dimension)
			return {
				key,
				label: dimension.label,
				kind: dimension.kind,
				...(dimension.kind === 'timeBucket' && { unit: dimension.unit }),
				...(values && { values })
			}
		}),
		measures: query.measures.map((key) => {
			const entry: AnyMeasure = dataset.measures[key]
			return { key, label: entry.label, valueType: entry.result }
		})
	}
}
