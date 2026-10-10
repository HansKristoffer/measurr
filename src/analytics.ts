import { z } from 'zod'
import type { CompiledStatement, Dialect, SelectStatement } from './compile.js'
import type { AnyDataset, AnyDimension } from './dataset.js'
import {
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
	PeriodError,
	type ResolvedPeriod,
	isValidTimezone,
	previousPeriod,
	resolvePeriod
} from './period.js'
import {
	type DatasetQuery,
	type QueryResult,
	type ResultOf,
	buildQuerySchema,
	datasetResultSchema
} from './query.js'

export type Row = Record<string, unknown>

/** A database: a dialect to compile with and a function that runs the compiled SQL. */
export type AnalyticsSource = {
	readonly dialect: Dialect
	/** Runs one read-only statement and returns its rows as plain objects. */
	execute(statement: CompiledStatement): Promise<readonly Row[]>
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
	durationMs: number
	/** Rows returned; 0 on error. */
	rows: number
	outcome: 'success' | 'error'
	/** What the query threw, on error. */
	error?: unknown
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
	/** IANA timezone periods and time buckets resolve in. UTC when omitted. */
	timezone?:
		| ((
				ctx: Ctx
		  ) => string | null | undefined | Promise<string | null | undefined>)
		| undefined
	/** The clock periods and `minutesAgo` resolve against. */
	now?: (() => Date) | undefined
	/**
	 * Called once per `query`, after it succeeds or fails: for metrics and logs. What it
	 * throws or rejects with is swallowed, so it can never fail a query.
	 */
	onQuery?: ((event: AnalyticsQueryEvent, ctx: Ctx) => unknown) | undefined
}

export type DatasetCatalogEntry<Key extends string = string> = {
	key: Key
	label: string
	description: string
	time: { key: string; label: string }[]
	measures: { key: string; label: string; description: string | undefined }[]
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
		ctx: Ctx
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
	 * The input schema for the datasets `authorize` allows `ctx`, for a tool built per caller.
	 * Rejects with `forbidden` when none are allowed.
	 */
	querySchema(options: {
		ctx: Ctx
	}): Promise<z.ZodType<DatasetQuery<DS[number]>>>
	/** The result schema for one dataset. */
	resultSchema(dataset: DS[number]['key']): z.ZodType<QueryResult<Row, Row>>
	/** The datasets `authorize` allows `ctx`, with their measures and dimensions. */
	listDatasets(ctx: Ctx): Promise<DatasetCatalogEntry<DS[number]['key']>[]>
}

export type AnalyticsQuery<A> =
	A extends Analytics<infer DS, never> ? DatasetQuery<DS[number]> : never

export type AnalyticsResult<A, Q> =
	A extends Analytics<infer DS, never> ? ResultOf<DS[number], Q> : never

type ShapedResult = QueryResult<Row, Row>

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

	for (const dataset of datasets) {
		if (byKey.has(dataset.key))
			throw new Error(`Two datasets use the key ${dataset.key}`)
		byKey.set(dataset.key, dataset)

		const source = resolveSource(dataset, options.sources, sourceNames)
		sourceOf.set(dataset.key, source)
		compileEverything(dataset, source.dialect)
	}

	const now = options.now ?? (() => new Date())
	const querySchemas = new Map<string, z.ZodType>()
	const resultSchemas = new Map<string, z.ZodType>()

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

	const querySchemaFor = (keys: readonly string[] | undefined) => {
		const selected = keys ? keys.map(datasetOf) : datasets
		const selectionKey = selected
			.map((dataset) => dataset.key)
			.sort()
			.join(',')

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

	const allowedDatasets = async (ctx: Ctx) => {
		const { authorize } = options
		if (!authorize) return datasets

		const allowed = await Promise.all(
			datasets.map((dataset) => authorize(dataset, ctx))
		)
		return datasets.filter((_, index) => allowed[index])
	}

	const querySchemaForCtx = async (ctx: Ctx) => {
		const allowed = await allowedDatasets(ctx)
		if (allowed.length === 0) {
			throw new AnalyticsError('forbidden', 'No dataset is allowed')
		}
		return querySchemaFor(allowed.map((dataset) => dataset.key))
	}

	/** Parse, authorize, and resolve everything that comes from hooks. */
	const prepare = async (input: unknown, ctx: Ctx): Promise<Prepared> => {
		const parsed = querySchemaFor(undefined).safeParse(input)
		if (!parsed.success) {
			throw new AnalyticsError(
				'invalid_query',
				`Invalid analytics query: ${z.prettifyError(parsed.error)}`,
				parsed.error.issues
			)
		}

		const dataset = datasetOf((parsed.data as ParsedQuery).dataset)
		if (options.authorize && !(await options.authorize(dataset, ctx))) {
			throw new AnalyticsError(
				'forbidden',
				`Not allowed to query ${dataset.key}`
			)
		}

		const tenant: unknown = options.tenant(ctx)
		if (!isTenant(tenant)) {
			throw new AnalyticsError(
				'missing_tenant',
				'Refusing to query without a tenant'
			)
		}

		const timezone = (await options.timezone?.(ctx)) || 'UTC'
		if (!isValidTimezone(timezone)) {
			throw new AnalyticsError(
				'invalid_timezone',
				`Unknown timezone ${timezone}`
			)
		}

		const query = normalizeQuery(dataset, parsed.data as ParsedQuery)
		const at = now()
		let period: ResolvedPeriod | null
		try {
			period =
				'all' in query.period ? null : resolvePeriod(query.period, timezone, at)
		} catch (error) {
			if (error instanceof PeriodError) {
				throw new AnalyticsError('invalid_period', error.message)
			}
			throw error
		}
		// The schema refuses compareToPrevious with an all-time period.
		const previous =
			query.compareToPrevious && period ? previousPeriod(period) : null

		return { dataset, query, tenant, timezone, period, previous, now: at }
	}

	const runQuery = async (input: unknown, ctx: Ctx): Promise<ShapedResult> => {
		const { dataset, query, tenant, timezone, period, previous, now } =
			await prepare(input, ctx)
		const source = sourceFor(dataset)
		const { dialect } = source
		const run = (statement: SelectStatement) =>
			source.execute(dialect.compile(statement))

		const resolvedValues = await resolveOpenValues(
			dataset,
			query,
			tenant,
			now,
			run,
			dialect
		)

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

			const { rows, truncated } = shapeRows(dataset, query, rawRows, dialect)
			const totalsRow = (rawTotals ?? rawRows)[0] ?? {}
			const totals = shapeMeasures(dataset, query.measures, totalsRow, dialect)

			return { rows, totals, truncated }
		}

		const range = ({ from, to }: ResolvedPeriod) => ({ from, to, timezone })
		const [current, before] = await Promise.all([
			runPeriod(period),
			previous &&
				runPeriod(previous).then(({ rows, totals }) => ({
					period: range(previous),
					rows,
					totals
				}))
		])

		return {
			period: period ? range(period) : { all: true, timezone },
			rows: current.rows,
			totals: current.totals,
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

	const query = async (input: unknown, ctx: Ctx): Promise<ShapedResult> => {
		const startedAt = performance.now()
		const dataset = datasetKeyOf(input)
		const durationMs = () => Math.round(performance.now() - startedAt)

		try {
			const result = await runQuery(input, ctx)
			report(
				{
					dataset,
					durationMs: durationMs(),
					rows: result.rows.length,
					outcome: 'success'
				},
				ctx
			)
			return result
		} catch (error) {
			report(
				{ dataset, durationMs: durationMs(), rows: 0, outcome: 'error', error },
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
				: querySchemaFor(schemaOptions?.datasets)) as Analytics<
			DS,
			Ctx
		>['querySchema'],
		resultSchema: (key) => resultSchemaFor(key) as z.ZodType<ShapedResult>,
		listDatasets: async (ctx) =>
			(await allowedDatasets(ctx)).map(
				(dataset) =>
					catalogEntry(dataset) as DatasetCatalogEntry<DS[number]['key']>
			)
	}
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

/** The statement for a period's rows, and for its totals when the query groups. */
function periodStatements(
	dataset: AnyDataset,
	query: NormalizedQuery,
	context: PlanContext
) {
	const grouped = query.groupBy.length > 0

	return {
		rows: planQuery(dataset, query, context, true),
		totals: grouped ? planQuery(dataset, query, context, false) : null
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
function compileEverything(dataset: AnyDataset, dialect: Dialect): void {
	const now = new Date(0)
	const context: PlanContext = {
		tenant: 'tenant',
		timezone: 'UTC',
		period: resolvePeriod({ last: { days: 1 } }, 'UTC', now),
		now,
		resolvedValues: new Map()
	}
	const measures = Object.keys(dataset.measures)
	const base = normalizeQuery(dataset, { dataset: dataset.key, measures })

	try {
		dialect.compile(planQuery(dataset, base, context, true))

		for (const [key, dimension] of Object.entries<AnyDimension>(
			dataset.dimensions
		)) {
			if (dimension.groupable) {
				dialect.compile(
					planQuery(dataset, { ...base, groupBy: [key] }, context, true)
				)
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
				dialect.compile(
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
		measures: Object.entries<{
			label: string
			description: string | undefined
		}>(dataset.measures).map(([key, entry]) => ({
			key,
			label: entry.label,
			description: entry.description
		})),
		dimensions: Object.entries<AnyDimension>(dataset.dimensions).map(
			([key, entry]) => ({
				key,
				label: entry.label,
				description: entry.description,
				kind: entry.kind,
				category: entry.category,
				groupable: entry.groupable,
				filterable: entry.filterable,
				values:
					entry.kind === 'enum' || entry.kind === 'computed'
						? Object.entries(entry.values).map(([value, label]) => ({
								key: value,
								label
							}))
						: undefined
			})
		)
	}
}
