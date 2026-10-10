import type {
	Dialect,
	JoinClause,
	SelectItem,
	SelectStatement
} from './compile.js'
import type { AnyDataset, AnyDimension, AnyMeasure } from './dataset.js'
import type { ExprNode, ParamValue } from './expr.js'
import type { PeriodInput, ResolvedPeriod } from './period.js'
import { DEFAULT_LIMIT } from './query.js'

/** A parsed query with every default filled in and duplicates removed. */
export type NormalizedQuery = {
	dataset: string
	measures: string[]
	groupBy: string[]
	filters: NormalizedFilter[]
	period: PeriodInput
	time: string
	compareToPrevious: boolean
	sort: { by: string; direction: 'asc' | 'desc' } | null
	limit: number
}

export type NormalizedFilter =
	| { dimension: string; op: 'in' | 'notIn'; values: (string | number)[] }
	| {
			dimension: string
			op: 'between'
			from: string | number
			to: string | number
	  }
	| { dimension: string; op: 'isEmpty' | 'isNotEmpty' }

/** The parsed shape the schema produces (all optional fields possibly absent). */
export type ParsedQuery = {
	dataset: string
	measures: readonly string[]
	groupBy?: readonly string[] | undefined
	filters?: readonly NormalizedFilter[] | undefined
	period?: PeriodInput | undefined
	time?: string | undefined
	compareToPrevious?: boolean | undefined
	sort?: { by: string; direction?: 'asc' | 'desc' | undefined } | undefined
	limit?: number | undefined
}

export function normalizeQuery(
	dataset: AnyDataset,
	parsed: ParsedQuery
): NormalizedQuery {
	const filters = (parsed.filters ?? []).map((filter) =>
		filter.op === 'in' || filter.op === 'notIn'
			? { ...filter, values: [...new Set(filter.values)] }
			: filter
	)

	return {
		dataset: dataset.key,
		measures: [...new Set(parsed.measures)],
		// Order matters: the first grouped dimension leads the rows.
		groupBy: [...new Set(parsed.groupBy ?? [])],
		filters,
		period: parsed.period ?? dataset.defaultPeriod,
		time: parsed.time ?? dataset.defaultTime,
		compareToPrevious: parsed.compareToPrevious ?? false,
		sort: parsed.sort
			? { by: parsed.sort.by, direction: parsed.sort.direction ?? 'desc' }
			: null,
		limit: parsed.limit ?? DEFAULT_LIMIT
	}
}

/**
 * What `tenant(ctx)` returns to query every tenant at once, for platform admins. It is a
 * symbol, so no query input (JSON, a model's tool call) can ever carry it.
 */
export const allTenants: unique symbol = Symbol('measurr.allTenants')

export type TenantId = string | number

/** One tenant's id, a list of them (an empty list matches no rows), or `allTenants`. */
export type Tenant = TenantId | readonly TenantId[] | typeof allTenants

/** What the planner needs besides the query: values from the hooks and resolved labels. */
export type PlanContext = {
	tenant: Tenant
	timezone: string
	/** Null for an all-time period: no time filter. */
	period: ResolvedPeriod | null
	/** The moment the query runs. */
	now: Date
	/** Keys for filters on open dimensions, after label resolution, by dimension. */
	resolvedValues: ReadonlyMap<string, readonly (string | number)[]>
}

const param = (value: ParamValue): ExprNode => ({ kind: 'param', value })

const and = (items: ExprNode[]): ExprNode =>
	items.length === 1 && items[0]
		? items[0]
		: { kind: 'logical', op: 'and', items }

function measureOf(dataset: AnyDataset, key: string): AnyMeasure {
	const entry: AnyMeasure | undefined = dataset.measures[key]
	if (!entry) throw new Error(`Dataset ${dataset.key} has no measure ${key}`)

	return entry
}

function dimensionOf(dataset: AnyDataset, key: string): AnyDimension {
	const entry: AnyDimension | undefined = dataset.dimensions[key]
	if (!entry) throw new Error(`Dataset ${dataset.key} has no dimension ${key}`)

	return entry
}

/** A measure as one aggregate expression; shares and ratios divide after aggregation. */
function measureNode(dataset: AnyDataset, key: string): ExprNode {
	const entry = measureOf(dataset, key)

	switch (entry.kind) {
		case 'aggregate':
			return entry.node
		case 'share': {
			const numeratorWhere = entry.denominator
				? and([entry.numerator, entry.denominator])
				: entry.numerator
			return {
				kind: 'arithmetic',
				op: '/',
				left: {
					kind: 'aggregate',
					fn: 'count',
					arg: null,
					where: numeratorWhere
				},
				right: {
					kind: 'aggregate',
					fn: 'count',
					arg: null,
					where: entry.denominator
				}
			}
		}
		case 'ratio':
			return {
				kind: 'arithmetic',
				op: '/',
				left: measureNode(dataset, entry.numerator),
				right: measureNode(dataset, entry.denominator)
			}
	}
}

type DimensionNodes = {
	key: ExprNode
	label: ExprNode | null
	virtualJoin: JoinClause | null
}

function dimensionNodes(
	dataset: AnyDataset,
	key: string,
	timezone: string
): DimensionNodes {
	const entry = dimensionOf(dataset, key)

	switch (entry.kind) {
		case 'enum':
		case 'computed':
		case 'number':
			return { key: entry.expr, label: null, virtualJoin: null }
		case 'relation':
			return { key: entry.key, label: entry.name, virtualJoin: null }
		case 'manyToMany':
			return {
				key: entry.key,
				label: entry.name,
				virtualJoin: { table: entry.table, type: 'left', on: entry.on }
			}
		case 'timeBucket':
		case 'timePart': {
			const field = dataset.time[entry.time]
			if (!field)
				throw new Error(
					`Dataset ${dataset.key} has no time field ${entry.time}`
				)
			return {
				key:
					entry.kind === 'timeBucket'
						? {
								kind: 'timeBucket',
								unit: entry.unit,
								item: field.column,
								timezone
							}
						: {
								kind: 'timePart',
								part: entry.part,
								item: field.column,
								timezone
							},
				label: null,
				virtualJoin: null
			}
		}
	}
}

/** Tenant, scope and period: the conditions every statement of a query carries. */
function baseWhere(
	dataset: AnyDataset,
	tenant: Tenant,
	period: { time: string; start: Date; end: Date } | null
): ExprNode[] {
	const where: ExprNode[] = []
	if (tenant !== allTenants) {
		const ids = typeof tenant === 'object' ? [...new Set(tenant)] : [tenant]
		const [only] = ids
		// One id compiles exactly like the scalar; an empty list renders as a false condition.
		where.push(
			ids.length === 1 && only !== undefined
				? {
						kind: 'compare',
						op: '=',
						left: dataset.tenantColumn,
						right: param(only)
					}
				: {
						kind: 'in',
						item: dataset.tenantColumn,
						values: ids.map(param),
						negated: false
					}
		)
	}
	if (dataset.scope) where.push(dataset.scope)

	if (period) {
		const field = dataset.time[period.time]
		if (!field)
			throw new Error(`Dataset ${dataset.key} has no time field ${period.time}`)
		where.push(
			{
				kind: 'compare',
				op: '>=',
				left: field.column,
				right: param(period.start)
			},
			{ kind: 'compare', op: '<', left: field.column, right: param(period.end) }
		)
	}

	return where
}

function filterNode(
	dataset: AnyDataset,
	filter: NormalizedFilter,
	context: PlanContext
): ExprNode {
	const entry = dimensionOf(dataset, filter.dimension)
	const { key } = dimensionNodes(dataset, filter.dimension, context.timezone)

	if (entry.kind === 'manyToMany') {
		const linked = (
			condition: ExprNode | null,
			negated: boolean
		): ExprNode => ({
			kind: 'exists',
			table: entry.table,
			where: condition ? and([entry.on, condition]) : entry.on,
			negated
		})
		switch (filter.op) {
			case 'isEmpty':
			case 'isNotEmpty':
				return linked(null, filter.op === 'isEmpty')
			case 'between':
				throw new Error(`${filter.dimension} does not support between`)
			case 'in':
			case 'notIn': {
				const values =
					context.resolvedValues.get(filter.dimension) ?? filter.values
				const matches: ExprNode = {
					kind: 'in',
					item: key,
					values: values.map(param),
					negated: false
				}
				return linked(matches, filter.op === 'notIn')
			}
		}
	}

	switch (filter.op) {
		case 'isEmpty':
			return { kind: 'isNull', item: key, negated: false }
		case 'isNotEmpty':
			return { kind: 'isNull', item: key, negated: true }
		case 'between':
			return and([
				{ kind: 'compare', op: '>=', left: key, right: param(filter.from) },
				{ kind: 'compare', op: '<=', left: key, right: param(filter.to) }
			])
		case 'in':
		case 'notIn': {
			const values =
				context.resolvedValues.get(filter.dimension) ?? filter.values
			const list: ExprNode = {
				kind: 'in',
				item: key,
				values: values.map(param),
				negated: filter.op === 'notIn'
			}
			if (filter.op === 'in') return list
			// "Not one of these" keeps rows without a value, unlike SQL's NOT IN.
			return {
				kind: 'logical',
				op: 'or',
				items: [list, { kind: 'isNull', item: key, negated: false }]
			}
		}
	}
}

/** Output column aliases. Keys come from definitions, never from input. */
export const columnAlias = {
	measure: (key: string) => `m_${key}`,
	groupKey: (key: string) => `g_${key}`,
	groupLabel: (key: string) => `g_${key}__label`
}

/**
 * The statement for a query's rows, or for its totals when `grouped` is false. Totals never
 * group, so a many-to-many grouping cannot inflate them.
 */
export function planQuery(
	dataset: AnyDataset,
	query: NormalizedQuery,
	context: PlanContext,
	grouped: boolean
): SelectStatement {
	const select: SelectItem[] = []
	const groupBy: number[] = []
	const virtualJoins: JoinClause[] = []
	const groupKeys = grouped ? query.groupBy : []

	for (const key of groupKeys) {
		const nodes = dimensionNodes(dataset, key, context.timezone)
		if (nodes.virtualJoin) virtualJoins.push(nodes.virtualJoin)

		groupBy.push(select.length)
		select.push({ alias: columnAlias.groupKey(key), node: nodes.key })
		if (nodes.label) {
			groupBy.push(select.length)
			select.push({ alias: columnAlias.groupLabel(key), node: nodes.label })
		}
	}
	for (const key of query.measures) {
		select.push({
			alias: columnAlias.measure(key),
			node: measureNode(dataset, key)
		})
	}

	const where = [
		...baseWhere(
			dataset,
			context.tenant,
			context.period && {
				time: query.time,
				start: context.period.start,
				end: context.period.end
			}
		),
		...query.filters.map((filter) => filterNode(dataset, filter, context))
	]

	return {
		from: dataset.from,
		virtualJoins,
		where,
		select,
		groupBy,
		orderBy: groupKeys.length > 0 ? orderBy(dataset, query, select) : [],
		limit: grouped && groupKeys.length > 0 ? query.limit + 1 : null,
		now: context.now
	}
}

function orderBy(
	dataset: AnyDataset,
	query: NormalizedQuery,
	select: readonly SelectItem[]
): SelectStatement['orderBy'] {
	const indexOf = (alias: string) =>
		select.findIndex((item) => item.alias === alias)
	const order: { index: number; direction: 'asc' | 'desc' }[] = []

	const timeKey = query.groupBy.find((key) => {
		const kind = dimensionOf(dataset, key).kind
		return kind === 'timeBucket' || kind === 'timePart'
	})
	const sort =
		query.sort ??
		(timeKey
			? { by: timeKey, direction: 'asc' as const }
			: { by: query.measures[0] ?? '', direction: 'desc' as const })

	const sortIndex =
		sort.by in dataset.measures
			? indexOf(columnAlias.measure(sort.by))
			: indexOf(columnAlias.groupKey(sort.by))
	if (sortIndex >= 0)
		order.push({ index: sortIndex, direction: sort.direction })

	// Ties break on the group keys, so the same query always returns rows in the same order.
	for (const key of query.groupBy) {
		const index = indexOf(columnAlias.groupKey(key))
		if (index >= 0 && index !== sortIndex)
			order.push({ index, direction: 'asc' })
	}

	return order
}

/**
 * Looks up an open dimension's keys and names. With `values`, only entries whose key or name
 * (case-insensitive) matches; without, the first entries by name, to list valid values.
 */
export function planLookup(
	dataset: AnyDataset,
	dimensionKey: string,
	tenant: Tenant,
	values: readonly string[] | null,
	now: Date
): SelectStatement {
	const nodes = dimensionNodes(dataset, dimensionKey, 'UTC')
	const label = nodes.label ?? nodes.key
	const where = baseWhere(dataset, tenant, null)

	where.push({ kind: 'isNull', item: nodes.key, negated: true })
	if (values) {
		where.push({
			kind: 'logical',
			op: 'or',
			items: [
				{
					kind: 'in',
					item: { kind: 'toText', item: nodes.key },
					values: values.map(param),
					negated: false
				},
				{
					kind: 'in',
					item: { kind: 'lower', item: label },
					values: values.map((value) => param(value.toLowerCase())),
					negated: false
				}
			]
		})
	}

	return {
		from: dataset.from,
		virtualJoins: nodes.virtualJoin ? [nodes.virtualJoin] : [],
		where,
		select: [
			{ alias: 'key', node: nodes.key },
			{ alias: 'label', node: label }
		],
		groupBy: [0, 1],
		orderBy: [{ index: 1, direction: 'asc' }],
		limit: values ? 500 : 50,
		now
	}
}

// ---------------------------------------------------------------------------------------------
// Shaping

const WEEKDAYS = [
	'Monday',
	'Tuesday',
	'Wednesday',
	'Thursday',
	'Friday',
	'Saturday',
	'Sunday'
]

export type ShapedValue = { key: string | number | null; label: string }
export type ShapedRow = Record<string, ShapedValue | number | null>

function decodeKey(
	dimension: AnyDimension,
	raw: unknown,
	dialect: Dialect
): string | number | null {
	if (raw === null || raw === undefined) return null

	switch (dimension.kind) {
		case 'number':
		case 'timePart':
			return dialect.decodeNumber(raw)
		case 'relation':
		case 'manyToMany':
			if (typeof raw === 'string') return raw
			return dialect.decodeNumber(raw) ?? String(raw)
		default:
			return String(raw)
	}
}

function labelOf(
	dimension: AnyDimension,
	key: string | number | null,
	rawLabel: unknown
): string {
	switch (dimension.kind) {
		case 'enum':
		case 'computed':
			return key === null
				? (dimension.empty ?? 'None')
				: (dimension.values[String(key)] ?? String(key))
		case 'relation':
		case 'manyToMany':
			if (key === null) return dimension.empty ?? 'None'
			return rawLabel === null || rawLabel === undefined
				? String(key)
				: String(rawLabel)
		case 'timeBucket':
			if (key === null) return 'None'
			return dimension.labelFor?.(String(key)) ?? String(key)
		case 'timePart':
			if (typeof key !== 'number') return 'None'
			if (dimension.labelFor) return dimension.labelFor(key)
			return dimension.part === 'isodow'
				? (WEEKDAYS[key - 1] ?? String(key))
				: `${String(key).padStart(2, '0')}:00`
		case 'number':
			if (typeof key !== 'number') return 'None'
			return dimension.labelFor?.(key) ?? String(key)
	}
}

/** Decodes measures in one raw row; counts are never null. */
export function shapeMeasures(
	dataset: AnyDataset,
	measures: readonly string[],
	raw: Record<string, unknown>,
	dialect: Dialect
): Record<string, number | null> {
	const values: Record<string, number | null> = {}
	for (const key of measures) {
		const value = dialect.decodeNumber(raw[columnAlias.measure(key)])
		values[key] =
			measureOf(dataset, key).result === 'count' ? (value ?? 0) : value
	}

	return values
}

export function shapeRows(
	dataset: AnyDataset,
	query: NormalizedQuery,
	rawRows: readonly Record<string, unknown>[],
	dialect: Dialect
): { rows: ShapedRow[]; truncated: boolean } {
	const truncated = query.groupBy.length > 0 && rawRows.length > query.limit
	const kept = truncated ? rawRows.slice(0, query.limit) : rawRows

	const rows = kept.map((raw) => {
		const row: ShapedRow = {}
		for (const key of query.groupBy) {
			const dimension = dimensionOf(dataset, key)
			const value = decodeKey(
				dimension,
				raw[columnAlias.groupKey(key)],
				dialect
			)
			row[key] = {
				key: value,
				label: labelOf(dimension, value, raw[columnAlias.groupLabel(key)])
			}
		}

		return { ...row, ...shapeMeasures(dataset, query.measures, raw, dialect) }
	})

	return { rows, truncated }
}

/** Notes a reader needs to read the numbers right. */
export function resultNotes(
	dataset: AnyDataset,
	query: NormalizedQuery
): string[] {
	const notes: string[] = []

	for (const key of query.groupBy) {
		const dimension = dimensionOf(dataset, key)
		if (dimension.kind !== 'manyToMany') continue
		notes.push(
			dimension.note ??
				`A row with several ${dimension.label.toLowerCase()} values counts once per value, so ${dimension.label.toLowerCase()} rows can add up to more than the total.`
		)
	}

	return notes
}
