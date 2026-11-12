/**
 * Sources whose rows come from a function instead of a database: an API (a CRM, a billing
 * system) or arrays in memory. The planned statement is evaluated here, in JavaScript: the
 * source loads the rows of each table the statement reads, then joins, filters, groups and
 * aggregates them the way the Postgres dialect's SQL would.
 *
 * Every query reads the rows it counts, so this suits thousands of records behind a cache, not
 * millions. Sync larger data to a database and define the dataset there.
 */
import type { AnalyticsSource } from './analytics.js'
import {
	CompileError,
	type CompiledStatement,
	type Dialect,
	type JoinClause,
	type SelectStatement,
	collectJoins,
	decodeNumber
} from './compile.js'
import { postgresDialect } from './dialects/postgres.js'
import { type ExprNode, type TableRef, directChildren } from './expr.js'
import { addDays, isoWeekday, localDate, localHour } from './period.js'
import { type Shared, share } from './share.js'

type Row = Record<string, unknown>

/** A plain value a filter compares a column with. */
export type RowFilterValue = string | number | boolean | Date

/**
 * A condition on one column that every row the statement counts must meet. The source applies
 * every condition again to the rows it gets, so a loader may use the ones its API can express
 * and ignore the rest.
 */
export type RowFilter =
	| {
			column: string
			op: '=' | '<>' | '>' | '>=' | '<' | '<='
			value: RowFilterValue
	  }
	| { column: string; op: 'in' | 'notIn'; values: readonly RowFilterValue[] }
	| { column: string; op: 'isNull' | 'isNotNull' }

/** What a statement needs from one table. */
export type RowRequest = {
	/** The table's name, as given to `table()`. */
	table: string
	/** The columns the statement reads; every row must hold them under these names. */
	columns: readonly string[]
	/**
	 * Conditions the rows must meet, for the API to narrow what it returns: the tenant, the
	 * period and plain filters for a dataset's own table, the keys of the rows that refer to it
	 * for a joined one. Returning more rows than these allow is slower, never wrong.
	 */
	filters: readonly RowFilter[]
	/** Aborts when nobody waits for the rows any more. */
	signal?: AbortSignal | undefined
}

export type RowSourceOptions = {
	/**
	 * The rows of `request.table`. Timestamps may be `Date`s, ISO strings or epoch milliseconds,
	 * numbers may be numeric strings and booleans `'true'` or `'false'`, as APIs return them.
	 */
	load: (request: RowRequest) => readonly Row[] | Promise<readonly Row[]>
}

/** Carries the planned statement from `compile` to `execute`; survives a spread, not JSON. */
const PLANNED = Symbol('measurr.planned')

/**
 * A source whose rows come from `load`: an API, a file, another service. Use it as any other
 * source in `createAnalytics({ sources })`.
 *
 * ```ts
 * const hubspot = rowSource({
 *   load: ({ table, columns, filters, signal }) => searchHubSpot(table, columns, filters, signal)
 * })
 * ```
 *
 * A dataset's tenant, scope and period reach `load` as filters on their columns, and are
 * applied again to what it returns: rows must carry the tenant column, and a loader that
 * ignores a filter can make a query slower but cannot widen it. `analytics.explain` shows the
 * statement as the Postgres SQL it is equal to.
 */
export function rowSource(options: RowSourceOptions): AnalyticsSource {
	const describe = postgresDialect()
	const dialect: Dialect = {
		name: 'rows',
		compile(statement) {
			rejectUnsupported(statement)
			return { ...describe.compile(statement), [PLANNED]: statement }
		},
		decodeNumber
	}
	/** Loads in flight by table and filters, with the columns each one asked for. */
	const inFlight = new Map<string, Shared<readonly Row[]>>()
	const columnsInFlight = new Map<string, ReadonlySet<string>>()

	const load = async (
		request: RowRequest,
		signal: AbortSignal | undefined
	): Promise<readonly Row[]> => {
		// No key to match: the rows are not needed, and the API is not asked.
		const empty = request.filters.some(
			(filter) => filter.op === 'in' && filter.values.length === 0
		)
		if (empty) return []

		const start = async (shared: AbortSignal | undefined) =>
			options.load({ ...request, signal: shared })
		const key = JSON.stringify([request.table, request.filters])
		const loading = columnsInFlight.get(key)
		// A query's totals read a subset of what its rows read: one load answers both.
		if (inFlight.has(key)) {
			return loading && request.columns.every((column) => loading.has(column))
				? share(inFlight, key, start, signal)
				: start(signal)
		}
		columnsInFlight.set(key, new Set(request.columns))
		return share(
			inFlight,
			key,
			(shared) =>
				start(shared).finally(() => {
					columnsInFlight.delete(key)
				}),
			signal
		)
	}

	return {
		dialect,
		execute: (compiled, execution) => {
			const statement = (compiled as PlannedStatement)[PLANNED]
			if (!statement) {
				throw new Error(
					'A row source can only run statements its own dialect compiled'
				)
			}
			return evaluate(statement, load, execution?.signal)
		}
	}
}

/**
 * A source over arrays in memory, by table name: for tests, fixtures and small reference data.
 * Name the row types to have the rows checked against them, so a misspelt column fails
 * typecheck instead of counting as null:
 *
 * ```ts
 * const source = memorySource<{ orders: Order; regions: Region }>({
 * 	orders: [{ id: 'o1', tenantId: 't1', amount: 120, createdAt: new Date() }],
 * 	regions: []
 * })
 * ```
 *
 * A row may leave columns out; they read as null.
 */
export function memorySource<
	Tables extends Record<string, object> = Record<string, Row>
>(
	tables: NoInfer<{
		readonly [Name in keyof Tables]: readonly Partial<Tables[Name]>[]
	}>
): AnalyticsSource {
	const byName: Readonly<Record<string, readonly Row[] | undefined>> = tables
	return rowSource({
		load: ({ table }) => {
			const rows = byName[table]
			if (!rows) throw new Error(`The memory source has no table ${table}`)
			return rows
		}
	})
}

type PlannedStatement = CompiledStatement & { [PLANNED]?: SelectStatement }

/** The rows bound to each table of a statement; null for a left join without a match. */
type Scope = ReadonlyMap<TableRef, Row | null>

type Context = {
	now: Date
	/** By `exists` node: whether its subquery has a row for the scope. */
	exists: Map<ExprNode, (scope: Scope) => boolean>
}

type Load = (
	request: RowRequest,
	signal: AbortSignal | undefined
) => Promise<readonly Row[]>

/** A subquery inside a join condition would need rows before the join that gives them. */
function rejectUnsupported(statement: SelectStatement): void {
	const seen = new Set<TableRef>()
	const check = (on: ExprNode, table: TableRef) => {
		visit(on, (node) => {
			if (node.kind === 'exists') {
				throw new CompileError(
					`A row source cannot run exists() inside the join condition of ${table.name}`
				)
			}
		})
	}
	const nodes = [
		...statement.select.map((item) => item.node),
		...statement.where
	]
	for (const join of statement.virtualJoins) check(join.on, join.table)
	for (const node of nodes) {
		visit(node, (inner) => {
			if (inner.kind !== 'column') return
			for (let ref = inner.table; ref.join && !seen.has(ref); ) {
				seen.add(ref)
				check(ref.join.on, ref)
				ref = ref.join.parent
			}
		})
	}
}

/** Visits every node of a tree, subqueries included. */
function visit(node: ExprNode, each: (node: ExprNode) => void): void {
	each(node)
	for (const child of directChildren(node)) visit(child, each)
}

/** The `exists` nodes of a tree, without those inside another one's subquery. */
function existsNodes(node: ExprNode): Extract<ExprNode, { kind: 'exists' }>[] {
	if (node.kind === 'exists') return [node]
	return directChildren(node).flatMap(existsNodes)
}

/** The conditions that must all hold for `node` to: `a AND b` is `a` and `b`. */
function conjuncts(node: ExprNode): ExprNode[] {
	return node.kind === 'logical' && node.op === 'and'
		? node.items.flatMap(conjuncts)
		: [node]
}

async function evaluate(
	statement: SelectStatement,
	load: Load,
	signal: AbortSignal | undefined
): Promise<Row[]> {
	const context: Context = { now: statement.now, exists: new Map() }
	const nodes = [
		...statement.select.map((item) => item.node),
		...statement.where
	]
	const columns = columnsRead(statement)
	const rowsOf = (table: TableRef, filters: RowFilter[]) =>
		load(
			{
				table: table.name,
				columns: [...(columns.get(table) ?? [])],
				filters
			},
			signal
		)

	const conditions = statement.where.flatMap(conjuncts)
	const root = await rowsOf(
		statement.from,
		conditions.flatMap((node) => plainFilter(node, statement.from, context))
	)
	let scopes: Scope[] = root.map((row) => new Map([[statement.from, row]]))
	for (const join of collectJoins(
		nodes,
		statement.from,
		statement.virtualJoins
	))
		scopes = await joined(scopes, join, rowsOf, context)

	for (const node of nodes) await prepareExists(node, scopes, rowsOf, context)
	const matching = scopes.filter((scope) =>
		statement.where.every((node) => isTrue(rowValue(node, scope, context)))
	)

	const keys = statement.groupBy.map((index) => {
		const item = statement.select[index]
		if (!item)
			throw new Error(`GROUP BY refers to missing select item ${index}`)
		return item.node
	})
	// Without GROUP BY the aggregates are over every row, also when there are none.
	const groups = keys.length > 0 ? groupBy(matching, keys, context) : [matching]
	const rows = groups.map((group) => {
		const row: Row = {}
		for (const item of statement.select)
			row[item.alias] = groupValue(item.node, group, context)
		return row
	})

	const order = statement.orderBy.map(({ index, direction }) => ({
		alias: statement.select[index]?.alias ?? '',
		direction
	}))
	rows.sort((a, b) => {
		for (const { alias, direction } of order) {
			const sorted = compareForOrder(a[alias], b[alias])
			if (sorted !== 0) return direction === 'asc' ? sorted : -sorted
		}
		return 0
	})

	return statement.limit === null ? rows : rows.slice(0, statement.limit)
}

/** The columns a statement reads from each table, join conditions included. */
function columnsRead(statement: SelectStatement): Map<TableRef, Set<string>> {
	const columns = new Map<TableRef, Set<string>>()
	const joins = new Set<TableRef>()
	const read = (node: ExprNode) =>
		visit(node, (inner) => {
			if (inner.kind !== 'column') return
			const known = columns.get(inner.table) ?? new Set<string>()
			columns.set(inner.table, known.add(inner.column))
			for (let ref = inner.table; ref.join && !joins.has(ref); ) {
				joins.add(ref)
				read(ref.join.on)
				ref = ref.join.parent
			}
		})

	for (const item of statement.select) read(item.node)
	for (const node of statement.where) read(node)
	for (const join of statement.virtualJoins) read(join.on)
	return columns
}

/** `node` as a filter on a column of `table`, when it compares one with plain values. */
function plainFilter(
	node: ExprNode,
	table: TableRef,
	context: Context
): RowFilter[] {
	const column = (operand: ExprNode) =>
		operand.kind === 'column' && operand.table === table ? operand.column : null
	const plain = (operand: ExprNode): RowFilterValue | null => {
		if (operand.kind === 'param') return operand.value
		return operand.kind === 'minutesAgo'
			? (rowValue(operand, new Map(), context) as Date)
			: null
	}

	switch (node.kind) {
		case 'compare': {
			const flipped = {
				'=': '=',
				'<>': '<>',
				'>': '<',
				'>=': '<=',
				'<': '>',
				'<=': '>='
			} as const
			const [left, right] = [column(node.left), column(node.right)]
			const [leftValue, rightValue] = [plain(node.left), plain(node.right)]
			if (left !== null && rightValue !== null)
				return [{ column: left, op: node.op, value: rightValue }]
			if (right !== null && leftValue !== null)
				return [{ column: right, op: flipped[node.op], value: leftValue }]
			return []
		}
		case 'in': {
			const item = column(node.item)
			const values = node.values.map(plain)
			// `NOT IN ()` holds for every row: nothing to narrow.
			if (item === null || (node.negated && values.length === 0)) return []
			return values.every((value) => value !== null)
				? [{ column: item, op: node.negated ? 'notIn' : 'in', values }]
				: []
		}
		case 'isNull': {
			const item = column(node.item)
			return item === null
				? []
				: [{ column: item, op: node.negated ? 'isNotNull' : 'isNull' }]
		}
		default:
			return []
	}
}

/**
 * The keys of `table` the rows in `scopes` refer to, when one of `conditions` is
 * `table.column = other.column`: only those rows can match.
 */
function keyFilter(
	conditions: readonly ExprNode[],
	table: TableRef,
	scopes: readonly Scope[],
	context: Context
): RowFilter[] {
	for (const node of conditions) {
		if (node.kind !== 'compare' || node.op !== '=') continue
		for (const [own, other] of [
			[node.left, node.right],
			[node.right, node.left]
		] as const) {
			if (own.kind !== 'column' || own.table !== table) continue
			if (other.kind !== 'column' || other.table === table) continue
			if (!scopes.every((scope) => scope.has(other.table))) continue

			const values = new Set<RowFilterValue>()
			for (const scope of scopes) {
				const value = rowValue(other, scope, context)
				if (value === null) continue
				if (!isIndexable(value)) return []
				values.add(typeof value === 'bigint' ? Number(value) : value)
			}
			return [{ column: own.column, op: 'in', values: [...values] }]
		}
	}
	return []
}

type RowsOf = (table: TableRef, filters: RowFilter[]) => Promise<readonly Row[]>

/** `scopes` with the rows of `join.table` that meet its condition bound to each. */
async function joined(
	scopes: Scope[],
	join: JoinClause,
	rowsOf: RowsOf,
	context: Context
): Promise<Scope[]> {
	const rows = await rowsOf(
		join.table,
		keyFilter(conjuncts(join.on), join.table, scopes, context)
	)
	const matches = matcher(
		rows.map((row): Scope => new Map([[join.table, row]])),
		new Set([join.table]),
		join.on,
		context
	)

	return scopes.flatMap((scope) => {
		const found = matches(scope)
		if (found.length > 0 || join.type === 'inner') return found
		return [new Map(scope).set(join.table, null)]
	})
}

/**
 * Loads what every `exists` in `node` needs and records how to answer it: the subquery's own
 * table with its joins, narrowed to the keys the outer rows refer to.
 */
async function prepareExists(
	node: ExprNode,
	outer: readonly Scope[],
	rowsOf: RowsOf,
	context: Context
): Promise<void> {
	for (const exists of existsNodes(node)) {
		if (context.exists.has(exists)) continue
		const conditions = conjuncts(exists.where)
		const rows = await rowsOf(exists.table, [
			...conditions.flatMap((inner) =>
				plainFilter(inner, exists.table, context)
			),
			...keyFilter(conditions, exists.table, outer, context)
		])
		let inner: Scope[] = rows.map((row) => new Map([[exists.table, row]]))
		const joins = collectJoins([exists.where], exists.table, [])
		for (const join of joins) inner = await joined(inner, join, rowsOf, context)

		// A subquery inside this one is answered for this one's rows.
		await prepareExists(exists.where, inner, rowsOf, context)
		const matches = matcher(
			inner,
			new Set([exists.table, ...joins.map((join) => join.table)]),
			exists.where,
			context
		)
		context.exists.set(exists, (scope) => matches(scope).length > 0)
	}
}

const isIndexable = (value: unknown): value is string | number | bigint =>
	typeof value === 'string' ||
	typeof value === 'number' ||
	typeof value === 'bigint'

/**
 * For an outer scope, the `inner` scopes that meet `condition`, each merged with it. Uses an
 * index when the condition holds `inner.column = <something outside>`, as join and `exists`
 * conditions do.
 */
function matcher(
	inner: readonly Scope[],
	innerTables: ReadonlySet<TableRef>,
	condition: ExprNode,
	context: Context
): (outer: Scope) => Scope[] {
	const isInside = (node: ExprNode) => {
		let inside = false
		visit(node, (part) => {
			if (part.kind === 'column' && innerTables.has(part.table)) inside = true
		})
		return inside
	}
	let key: { inner: ExprNode; outer: ExprNode } | undefined
	for (const node of conjuncts(condition)) {
		if (node.kind !== 'compare' || node.op !== '=') continue
		const [left, right] = [node.left, node.right]
		if (left.kind === 'column' && isInside(left) && !isInside(right))
			key = { inner: left, outer: right }
		else if (right.kind === 'column' && isInside(right) && !isInside(left))
			key = { inner: right, outer: left }
		if (key) break
	}

	let index: Map<string, Scope[]> | undefined
	if (key) {
		index = new Map()
		for (const scope of inner) {
			const value = rowValue(key.inner, scope, context)
			if (value === null) continue
			if (!isIndexable(value)) {
				index = undefined
				break
			}
			const bucket = index.get(String(value))
			if (bucket) bucket.push(scope)
			else index.set(String(value), [scope])
		}
	}

	return (outer) => {
		let candidates = inner
		if (key && index) {
			const value = rowValue(key.outer, outer, context)
			// The condition needs the two to be equal, and nothing equals null.
			if (value === null) return []
			if (isIndexable(value)) candidates = index.get(String(value)) ?? []
		}

		const matches: Scope[] = []
		for (const candidate of candidates) {
			const merged = new Map([...outer, ...candidate])
			if (isTrue(rowValue(condition, merged, context))) matches.push(merged)
		}
		return matches
	}
}

function groupBy(
	scopes: readonly Scope[],
	keys: readonly ExprNode[],
	context: Context
): Scope[][] {
	const groups = new Map<string, Scope[]>()
	for (const scope of scopes) {
		const id = JSON.stringify(
			keys.map((key) => identity(rowValue(key, scope, context)))
		)
		const group = groups.get(id)
		if (group) group.push(scope)
		else groups.set(id, [scope])
	}
	return [...groups.values()]
}

/** A value as JSON that is equal for equal values: instants by time, numbers by value. */
function identity(value: unknown): unknown {
	if (value instanceof Date) return ['instant', value.getTime()]
	if (typeof value === 'bigint') return Number(value)
	if (typeof value === 'object' && value !== null) return decodeNumber(value)
	return value
}

/** A select item for one group: aggregates over its rows, anything else from its first row. */
function groupValue(
	node: ExprNode,
	group: readonly Scope[],
	context: Context
): unknown {
	switch (node.kind) {
		case 'aggregate':
			return aggregate(node, group, context)
		case 'arithmetic':
			return arithmetic(
				node.op,
				groupValue(node.left, group, context),
				groupValue(node.right, group, context)
			)
		default: {
			const [first] = group
			return first ? rowValue(node, first, context) : null
		}
	}
}

function aggregate(
	node: Extract<ExprNode, { kind: 'aggregate' }>,
	group: readonly Scope[],
	context: Context
): number | null {
	const { arg, where } = node
	const rows = where
		? group.filter((scope) => isTrue(rowValue(where, scope, context)))
		: group
	if (node.fn === 'count' || !arg) return rows.length

	const values = rows
		.map((scope) => rowValue(arg, scope, context))
		.filter((value) => value !== null)
	if (node.fn === 'countDistinct')
		return new Set(values.map((value) => JSON.stringify(identity(value)))).size

	const numbers = values
		.map(decodeNumber)
		.filter((number) => number !== null)
		.sort((a, b) => a - b)
	// An empty group is null, as in SQL.
	if (numbers.length === 0) return null
	const sum = numbers.reduce((total, number) => total + number, 0)
	switch (node.fn) {
		case 'sum':
			return sum
		case 'avg':
			return sum / numbers.length
		case 'median': {
			// Between the two middle values, as `percentile_cont(0.5)` does.
			const middle = (numbers.length - 1) / 2
			const low = numbers[Math.floor(middle)] ?? 0
			const high = numbers[Math.ceil(middle)] ?? 0
			return low + (high - low) * (middle - Math.floor(middle))
		}
	}
}

function arithmetic(
	op: '+' | '-' | '*' | '/',
	left: unknown,
	right: unknown
): number | null {
	const [a, b] = [decodeNumber(left), decodeNumber(right)]
	if (a === null || b === null) return null
	switch (op) {
		case '+':
			return a + b
		case '-':
			return a - b
		case '*':
			return a * b
		case '/':
			return b === 0 ? null : a / b
	}
}

/** The value of an expression for one row, with SQL's rules for null. */
function rowValue(node: ExprNode, scope: Scope, context: Context): unknown {
	const value = (inner: ExprNode) => rowValue(inner, scope, context)

	switch (node.kind) {
		case 'column':
			return scope.get(node.table)?.[node.column] ?? null
		case 'param':
			return node.value
		case 'minutesAgo':
			return new Date(context.now.getTime() - node.minutes * 60_000)
		case 'compare': {
			const order = compare(value(node.left), value(node.right))
			if (order === null) return null
			switch (node.op) {
				case '=':
					return order === 0
				case '<>':
					return order !== 0
				case '>':
					return order > 0
				case '>=':
					return order >= 0
				case '<':
					return order < 0
				case '<=':
					return order <= 0
			}
			break
		}
		case 'logical': {
			// AND is false as soon as one item is; OR is true as soon as one is; else null wins.
			const decided = node.op === 'or'
			let unknown = false
			for (const item of node.items) {
				const result = toBoolean(value(item))
				if (result === decided) return decided
				if (result === null) unknown = true
			}
			return unknown ? null : !decided
		}
		case 'not': {
			const result = toBoolean(value(node.item))
			return result === null ? null : !result
		}
		case 'isNull':
			return (value(node.item) === null) !== node.negated
		case 'in': {
			const item = value(node.item)
			if (item === null) return null
			let unknown = false
			for (const candidate of node.values) {
				const order = compare(item, value(candidate))
				if (order === 0) return !node.negated
				if (order === null) unknown = true
			}
			return unknown ? null : node.negated
		}
		case 'case': {
			const branch = node.branches.find((entry) => isTrue(value(entry.when)))
			if (branch) return value(branch.result)
			return node.otherwise ? value(node.otherwise) : null
		}
		case 'exists': {
			const answer = context.exists.get(node)
			if (!answer) throw new Error(`exists(${node.table.name}) was not loaded`)
			return answer(scope) !== node.negated
		}
		case 'coalesce': {
			for (const item of node.items) {
				const result = value(item)
				if (result !== null) return result
			}
			return null
		}
		case 'arithmetic':
			return arithmetic(node.op, value(node.left), value(node.right))
		case 'lower': {
			const text = value(node.item)
			return text === null ? null : String(text).toLowerCase()
		}
		case 'toText': {
			const item = value(node.item)
			if (item === null) return null
			return item instanceof Date ? item.toISOString() : String(item)
		}
		case 'aggregate':
			throw new Error('An aggregate has no value for a single row')
		case 'timeBucket': {
			const instant = toInstant(value(node.item))
			if (!instant) return null
			const day = localDate(instant, node.timezone)
			if (node.unit === 'day') return day
			return node.unit === 'week'
				? addDays(day, -(isoWeekday(day) - 1))
				: `${day.slice(0, 8)}01`
		}
		case 'timePart': {
			const instant = toInstant(value(node.item))
			if (!instant) return null
			return node.part === 'isodow'
				? isoWeekday(localDate(instant, node.timezone))
				: localHour(instant, node.timezone)
		}
	}
}

const isTrue = (value: unknown) => toBoolean(value) === true

/** A boolean as databases and APIs give it: `true`, `'true'`, `1`. Anything else is null. */
function toBoolean(value: unknown): boolean | null {
	if (typeof value === 'boolean') return value
	if (value === 'true' || value === 1) return true
	if (value === 'false' || value === 0) return false
	return null
}

/** An instant from a `Date`, an ISO string (UTC when it names no zone) or epoch milliseconds. */
function toInstant(value: unknown): Date | null {
	if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value
	if (typeof value === 'number') return new Date(value)
	if (typeof value !== 'string' || value.trim() === '') return null
	if (/^\d+$/.test(value)) return new Date(Number(value))

	const zoned = /(?:Z|[+-]\d{2}:?\d{2})$/i.test(value) || !value.includes(':')
	const time = Date.parse(zoned ? value : `${value.replace(' ', 'T')}Z`)
	return Number.isNaN(time) ? null : new Date(time)
}

/**
 * How two values compare: negative, zero or positive, or null when either is null or they
 * cannot be compared. Values take the type of the other side, so `'12' > 5` and an ISO string
 * compares with a `Date`. Text compares by code unit.
 */
function compare(a: unknown, b: unknown): number | null {
	if (a === null || a === undefined || b === null || b === undefined)
		return null
	if (a instanceof Date || b instanceof Date) {
		const [x, y] = [toInstant(a), toInstant(b)]
		return x && y ? x.getTime() - y.getTime() : null
	}
	if (typeof a === 'boolean' || typeof b === 'boolean') {
		const [x, y] = [toBoolean(a), toBoolean(b)]
		return x === null || y === null ? null : Number(x) - Number(y)
	}
	if (typeof a !== 'string' || typeof b !== 'string') {
		const [x, y] = [decodeNumber(a), decodeNumber(b)]
		return x === null || y === null ? null : x - y
	}
	return a < b ? -1 : a > b ? 1 : 0
}

/** For ORDER BY: null sorts after every value, as in Postgres. */
function compareForOrder(a: unknown, b: unknown): number {
	const [aMissing, bMissing] = [
		a === null || a === undefined,
		b === null || b === undefined
	]
	if (aMissing || bMissing) return Number(aMissing) - Number(bMissing)
	return compare(a, b) ?? 0
}
