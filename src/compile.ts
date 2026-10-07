import {
	type AggregateFn,
	type ExprNode,
	type ParamValue,
	type TableRef,
	type TimeBucketUnit,
	type TimePartName,
	rootOf,
	walk
} from './expr.js'

/**
 * A planned query, still free of SQL. The planner builds it; a dialect renders it. Joins are
 * not listed: the renderer adds exactly the joins the statement's columns need.
 */
export type SelectStatement = {
	readonly from: TableRef
	/**
	 * Joins for standalone tables (a many-to-many link table) that apply only when one of
	 * their columns is used.
	 */
	readonly virtualJoins: readonly JoinClause[]
	readonly where: readonly ExprNode[]
	readonly select: readonly SelectItem[]
	/** Indexes into `select`. */
	readonly groupBy: readonly number[]
	readonly orderBy: readonly { index: number; direction: 'asc' | 'desc' }[]
	readonly limit: number | null
	/** The moment the query runs; `minutesAgo` expressions count back from it. */
	readonly now: Date
}

export type SelectItem = { readonly alias: string; readonly node: ExprNode }

export type JoinClause = {
	readonly table: TableRef
	readonly type: 'left' | 'inner'
	readonly on: ExprNode
}

/** SQL text plus its positional parameters. */
export type CompiledStatement = {
	readonly text: string
	readonly values: readonly unknown[]
}

/**
 * Everything a database needs: it renders statements and decodes what comes back. A dialect
 * has no driver dependency; the app's `execute` runs the SQL. Postgres ships in this package;
 * another database plugs in by implementing this, usually through a `SqlRenderer`.
 */
export type Dialect = {
	readonly name: string
	compile(statement: SelectStatement): CompiledStatement
	/**
	 * Numbers may arrive as strings or bigints (numerics, 64-bit integers), or as decimal
	 * objects (Prisma's `Decimal`).
	 */
	decodeNumber(value: unknown): number | null
}

/** The places where SQL differs between databases. `renderStatement` handles the rest. */
export type SqlRenderer = {
	readonly name: string
	quote(identifier: string): string
	/** Registers a parameter and returns its placeholder. `index` is 1-based. */
	param(
		value: ParamValue,
		index: number
	): { placeholder: string; value: unknown }
	aggregate(fn: AggregateFn, arg: string | null, where: string | null): string
	/** Floating-point division that is null when dividing by zero. */
	divide(left: string, right: string): string
	toText(expr: string): string
	/** A `YYYY-MM-DD` string of the bucket's first day in `timezone`. */
	timeBucket(unit: TimeBucketUnit, expr: string, timezone: string): string
	/** An integer: ISO weekday 1-7 or hour 0-23 in `timezone`. */
	timePart(part: TimePartName, expr: string, timezone: string): string
}

export class CompileError extends Error {
	override readonly name = 'CompileError'
}

/**
 * Decodes numbers the way drivers return them: numbers, numeric strings, bigints and decimal
 * objects with a `toNumber()` method (Prisma's `Decimal`, decimal.js). Anything else is null.
 */
export function decodeNumber(value: unknown): number | null {
	if (value === null || value === undefined) return null
	if (typeof value === 'number') return Number.isNaN(value) ? null : value
	if (typeof value === 'bigint') return Number(value)
	if (typeof value === 'string') {
		// Number('') is 0; an empty string is no number.
		const parsed = value.trim() === '' ? Number.NaN : Number(value)
		return Number.isNaN(parsed) ? null : parsed
	}
	if (
		typeof value === 'object' &&
		'toNumber' in value &&
		typeof value.toNumber === 'function'
	) {
		return decodeNumber(value.toNumber())
	}

	return null
}

export function renderStatement(
	statement: SelectStatement,
	renderer: SqlRenderer
): CompiledStatement {
	return new RenderContext(renderer, statement.now).render(statement)
}

class RenderContext {
	private readonly aliases = new Map<TableRef, string>()
	private readonly usedAliases = new Set<string>()
	private readonly values: unknown[] = []

	constructor(
		private readonly renderer: SqlRenderer,
		private readonly now: Date
	) {}

	render(statement: SelectStatement): CompiledStatement {
		const r = this.renderer
		const nodes = [
			...statement.select.map((item) => item.node),
			...statement.where
		]
		const joins = collectJoins(nodes, statement.from, statement.virtualJoins)

		const select = statement.select.map(
			(item) => `${this.expr(item.node)} AS ${r.quote(item.alias)}`
		)
		const lines = [
			`SELECT ${select.join(', ')}`,
			`FROM ${this.tableSource(statement.from, joins)}`
		]

		if (statement.where.length > 0) {
			lines.push(
				`WHERE ${statement.where.map((node) => this.expr(node)).join(' AND ')}`
			)
		}
		if (statement.groupBy.length > 0) {
			// By position: a repeated expression would bind its parameters again, and Postgres
			// treats `$1` in SELECT and `$3` in GROUP BY as different expressions.
			const refs = statement.groupBy.map((index) => {
				if (!statement.select[index])
					throw new CompileError(
						`GROUP BY refers to missing select item ${index}`
					)
				return String(index + 1)
			})
			lines.push(`GROUP BY ${refs.join(', ')}`)
		}
		if (statement.orderBy.length > 0) {
			const refs = statement.orderBy.map(({ index, direction }) => {
				const item = statement.select[index]
				if (!item)
					throw new CompileError(
						`ORDER BY refers to missing select item ${index}`
					)
				return `${r.quote(item.alias)} ${direction === 'asc' ? 'ASC' : 'DESC'}`
			})
			lines.push(`ORDER BY ${refs.join(', ')}`)
		}
		if (statement.limit !== null)
			lines.push(`LIMIT ${Math.trunc(statement.limit)}`)

		return { text: lines.join('\n'), values: this.values }
	}

	private alias(ref: TableRef): string {
		const existing = this.aliases.get(ref)
		if (existing) return existing

		const base = ref.alias ?? ref.name
		let alias = base
		for (let n = 2; this.usedAliases.has(alias); n++) alias = `${base}_${n}`

		this.aliases.set(ref, alias)
		this.usedAliases.add(alias)
		return alias
	}

	private tableSource(root: TableRef, joins: readonly JoinClause[]): string {
		const q = this.renderer.quote
		const parts = [`${q(root.name)} AS ${q(this.alias(root))}`]

		for (const join of joins) {
			const keyword = join.type === 'left' ? 'LEFT JOIN' : 'INNER JOIN'
			const source = `${q(join.table.name)} AS ${q(this.alias(join.table))}`
			parts.push(`${keyword} ${source} ON ${this.expr(join.on)}`)
		}

		return parts.join(' ')
	}

	/**
	 * `SELECT 1 FROM <table and its joins> WHERE <where>`. The FROM is rendered first so table
	 * aliases are assigned in reading order.
	 */
	private existsSubquery(table: TableRef, where: ExprNode): string {
		const from = this.tableSource(table, collectJoins([where], table, []))

		return `SELECT 1 FROM ${from} WHERE ${this.expr(where)}`
	}

	private param(value: ParamValue): string {
		const index = this.values.length + 1
		const { placeholder, value: bound } = this.renderer.param(value, index)
		this.values.push(bound)

		return placeholder
	}

	private expr(node: ExprNode): string {
		const r = this.renderer

		switch (node.kind) {
			case 'column':
				return `${r.quote(this.alias(node.table))}.${r.quote(node.column)}`
			case 'param':
				return this.param(node.value)
			case 'minutesAgo':
				return this.param(new Date(this.now.getTime() - node.minutes * 60_000))
			case 'compare':
				return `(${this.expr(node.left)} ${node.op} ${this.expr(node.right)})`
			case 'logical': {
				if (node.items.length === 0)
					return node.op === 'and' ? '(1 = 1)' : '(1 = 0)'
				const joiner = node.op === 'and' ? ' AND ' : ' OR '
				return `(${node.items.map((item) => this.expr(item)).join(joiner)})`
			}
			case 'not':
				return `(NOT ${this.expr(node.item)})`
			case 'isNull':
				return `(${this.expr(node.item)} IS ${node.negated ? 'NOT ' : ''}NULL)`
			case 'in': {
				if (node.values.length === 0)
					return node.negated ? '(1 = 1)' : '(1 = 0)'
				const values = node.values.map((value) => this.expr(value)).join(', ')
				return `(${this.expr(node.item)} ${node.negated ? 'NOT IN' : 'IN'} (${values}))`
			}
			case 'case': {
				const branches = node.branches
					.map(
						(branch) =>
							`WHEN ${this.expr(branch.when)} THEN ${this.expr(branch.result)}`
					)
					.join(' ')
				const otherwise = node.otherwise
					? ` ELSE ${this.expr(node.otherwise)}`
					: ''
				return `(CASE ${branches}${otherwise} END)`
			}
			case 'exists': {
				const body = this.existsSubquery(node.table, node.where)
				return `(${node.negated ? 'NOT ' : ''}EXISTS (${body}))`
			}
			case 'coalesce':
				return `coalesce(${node.items.map((item) => this.expr(item)).join(', ')})`
			case 'arithmetic': {
				const left = this.expr(node.left)
				const right = this.expr(node.right)
				if (node.op === '/') return r.divide(left, right)
				return `(${left} ${node.op} ${right})`
			}
			case 'lower':
				return `lower(${this.expr(node.item)})`
			case 'toText':
				return r.toText(this.expr(node.item))
			case 'aggregate':
				return r.aggregate(
					node.fn,
					node.arg ? this.expr(node.arg) : null,
					node.where ? this.expr(node.where) : null
				)
			case 'timeBucket':
				return r.timeBucket(node.unit, this.expr(node.item), node.timezone)
			case 'timePart':
				return r.timePart(node.part, this.expr(node.item), node.timezone)
		}
	}
}

/**
 * The joins `nodes` need, parents before children and `ON` dependencies before the join that
 * uses them. Columns of other roots (such as a subquery's own table) are left alone.
 */
export function collectJoins(
	nodes: readonly ExprNode[],
	root: TableRef,
	virtualJoins: readonly JoinClause[]
): JoinClause[] {
	const virtualByRoot = new Map(virtualJoins.map((join) => [join.table, join]))
	const ordered: JoinClause[] = []
	const added = new Set<TableRef>([root])

	const visit = (node: ExprNode) =>
		walk(node, (inner) => {
			if (inner.kind !== 'column') return
			const columnRoot = rootOf(inner.table)
			if (columnRoot === root || virtualByRoot.has(columnRoot))
				ensure(inner.table)
		})

	const ensure = (ref: TableRef) => {
		if (added.has(ref)) return

		if (ref.join) {
			ensure(ref.join.parent)
			added.add(ref)
			visit(ref.join.on)
			ordered.push({ table: ref, type: ref.join.type, on: ref.join.on })
			return
		}

		const virtual = virtualByRoot.get(ref)
		if (!virtual) return
		added.add(ref)
		visit(virtual.on)
		ordered.push(virtual)
	}

	for (const node of nodes) visit(node)

	return ordered
}
