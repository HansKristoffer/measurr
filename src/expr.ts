/**
 * The expression tree datasets are written with. Builders return `Expr` values that carry a
 * small, dialect-free node tree; no SQL text exists until a dialect renders a planned
 * statement. Every expression knows its SQL type, so `avg` over a string or `timeBucket` over a
 * number fails typecheck.
 */

export type SqlType = 'number' | 'string' | 'boolean' | 'timestamp'

/** A value a query parameter can hold. Timestamps are passed as `Date`. */
export type ParamValue = string | number | boolean | Date | null

export type CompareOp = '=' | '<>' | '>' | '>=' | '<' | '<='

export type TimeBucketUnit = 'day' | 'week' | 'month'
export type TimePartName = 'isodow' | 'hour'
export type AggregateFn = 'count' | 'countDistinct' | 'sum' | 'avg' | 'median'

/**
 * A table occurrence. A joined table points at the table it hangs off and carries its own
 * `ON` clause, so any column read from it brings the join along.
 */
export type TableRef = {
	readonly name: string
	readonly alias: string | undefined
	readonly join: TableJoin | undefined
}

export type TableJoin = {
	readonly type: 'left' | 'inner'
	readonly parent: TableRef
	readonly on: ExprNode
}

export type ExprNode =
	| {
			readonly kind: 'column'
			readonly table: TableRef
			readonly column: string
	  }
	| { readonly kind: 'param'; readonly value: ParamValue }
	| {
			readonly kind: 'compare'
			readonly op: CompareOp
			readonly left: ExprNode
			readonly right: ExprNode
	  }
	| {
			readonly kind: 'logical'
			readonly op: 'and' | 'or'
			readonly items: readonly ExprNode[]
	  }
	| { readonly kind: 'not'; readonly item: ExprNode }
	| {
			readonly kind: 'isNull'
			readonly item: ExprNode
			readonly negated: boolean
	  }
	| {
			readonly kind: 'in'
			readonly item: ExprNode
			readonly values: readonly ExprNode[]
			readonly negated: boolean
	  }
	| {
			readonly kind: 'case'
			readonly branches: readonly {
				readonly when: ExprNode
				readonly result: ExprNode
			}[]
			readonly otherwise: ExprNode | null
	  }
	| {
			readonly kind: 'exists'
			readonly table: TableRef
			readonly where: ExprNode
			readonly negated: boolean
	  }
	| {
			readonly kind: 'coalesce'
			readonly items: readonly ExprNode[]
	  }
	| {
			readonly kind: 'arithmetic'
			readonly op: '+' | '-' | '*' | '/'
			readonly left: ExprNode
			readonly right: ExprNode
	  }
	| { readonly kind: 'lower'; readonly item: ExprNode }
	| { readonly kind: 'toText'; readonly item: ExprNode }
	| {
			readonly kind: 'aggregate'
			readonly fn: AggregateFn
			readonly arg: ExprNode | null
			readonly where: ExprNode | null
	  }
	| {
			readonly kind: 'timeBucket'
			readonly unit: TimeBucketUnit
			readonly item: ExprNode
			readonly timezone: string
	  }
	| {
			readonly kind: 'timePart'
			readonly part: TimePartName
			readonly item: ExprNode
			readonly timezone: string
	  }
	/** The moment the query runs, minus `minutes`; rendered as a timestamp parameter. */
	| { readonly kind: 'minutesAgo'; readonly minutes: number }

/** What a raw value of a SQL type looks like in TypeScript. */
export type ValueOf<T extends SqlType> = T extends 'number'
	? number
	: T extends 'string'
		? string
		: T extends 'boolean'
			? boolean
			: Date

/**
 * An expression of SQL type `T`, or a plain value of `V` that becomes a parameter. `V` narrows
 * plain values, so `eq(order.col('status'), 'PAD')` fails when `status` is an enum. Plain
 * values are never null: compare with `isNull` instead.
 */
export type Operand<T extends SqlType, V = ValueOf<T>> = Expr<T> | V

/** The values an operand or a `caseWhen` branch can produce. */
type ValuesOf<O> = O extends Expr<SqlType, infer V> ? V : O

/** `null` when `V` can be null or undefined (an optional field), otherwise `never`. */
type NullOf<V> = null extends V ? null : undefined extends V ? null : never

/**
 * `T` is the SQL type; `V` is the TypeScript type of its values, including `null` when the
 * expression can be null. `V` defaults to "any value of `T`, or null", the SQL default; columns,
 * literals and `caseWhen` narrow it (an enum's members, a branded id, a non-null column).
 */
export class Expr<T extends SqlType, V = ValueOf<T> | null> {
	/** Phantom: the SQL type this expression evaluates to. Not `declare`: Playwright's Babel transform rejects it. */
	readonly sqlType!: T
	/** Phantom: the values this expression can produce. */
	readonly valueType!: V

	constructor(readonly node: ExprNode) {}

	isNull(): Expr<'boolean', boolean> {
		return new Expr({ kind: 'isNull', item: this.node, negated: false })
	}

	isNotNull(): Expr<'boolean', boolean> {
		return new Expr({ kind: 'isNull', item: this.node, negated: true })
	}

	add(this: Expr<'number'>, other: Operand<'number'>): Expr<'number'> {
		return arithmetic('+', this, other)
	}

	sub(this: Expr<'number'>, other: Operand<'number'>): Expr<'number'> {
		return arithmetic('-', this, other)
	}

	mul(this: Expr<'number'>, other: Operand<'number'>): Expr<'number'> {
		return arithmetic('*', this, other)
	}

	/** Always a floating-point division, and `null` when dividing by zero. */
	div(this: Expr<'number'>, other: Operand<'number'>): Expr<'number'> {
		return arithmetic('/', this, other)
	}
}

function arithmetic(
	op: '+' | '-' | '*' | '/',
	left: Expr<'number'>,
	right: Operand<'number'>
): Expr<'number'> {
	return new Expr({
		kind: 'arithmetic',
		op,
		left: left.node,
		right: toNode(right)
	})
}

/** Maps a column's TypeScript type to its SQL type; `never` for columns we cannot use. */
export type SqlTypeOf<V> = [NonNullable<V>] extends [never]
	? never
	: [NonNullable<V>] extends [Date]
		? 'timestamp'
		: [NonNullable<V>] extends [number | bigint]
			? 'number'
			: [NonNullable<V>] extends [boolean]
				? 'boolean'
				: [NonNullable<V>] extends [string]
					? 'string'
					: [NonNullable<V>] extends [{ toNumber(): number }]
						? 'number'
						: never

/**
 * The value type a column keeps: its own type when it fits its SQL type (an enum, a branded
 * id), plus `null` when the field is nullable or optional.
 */
export type ColumnValueOf<V> =
	| ([NonNullable<V>] extends [ValueOf<SqlTypeOf<V>>]
			? NonNullable<V>
			: ValueOf<SqlTypeOf<V>>)
	| NullOf<V>

/** Keys of `Row` whose values map to a SQL type (JSON and relation fields are excluded). */
export type ColumnKey<Row> = {
	[K in keyof Row]-?: [SqlTypeOf<Row[K]>] extends [never] ? never : K
}[keyof Row] &
	string

/**
 * A typed handle on a table. `Row` is any object type (a Prisma model, a hand-written type);
 * `col` only accepts its keys and returns an expression of the matching SQL type.
 */
export class Table<Row> {
	readonly row!: Row

	constructor(readonly ref: TableRef) {}

	col<K extends ColumnKey<Row>>(
		key: K
	): Expr<SqlTypeOf<Row[K]>, ColumnValueOf<Row[K]>> {
		return new Expr({
			kind: 'column',
			table: this.ref,
			column: key
		})
	}

	/** Joins `other` to this table. Columns of the returned handle bring the join with them. */
	leftJoin<Other>(
		other: Table<Other>,
		on: (joined: Table<Other>) => Expr<'boolean'>
	): Table<Other> {
		return this.join('left', other, on)
	}

	innerJoin<Other>(
		other: Table<Other>,
		on: (joined: Table<Other>) => Expr<'boolean'>
	): Table<Other> {
		return this.join('inner', other, on)
	}

	private join<Other>(
		type: 'left' | 'inner',
		other: Table<Other>,
		on: (joined: Table<Other>) => Expr<'boolean'>
	): Table<Other> {
		const ref: { -readonly [K in keyof TableRef]: TableRef[K] } = {
			name: other.ref.name,
			alias: other.ref.alias,
			join: undefined
		}
		const joined = new Table<Other>(ref)
		ref.join = { type, parent: this.ref, on: on(joined).node }

		return joined
	}
}

/** A table handle. The alias is optional; the compiler makes aliases unique per statement. */
export function table<Row>(name: string, alias?: string): Table<Row> {
	return new Table<Row>({ name, alias, join: undefined })
}

function toNode(value: Expr<SqlType, unknown> | ParamValue): ExprNode {
	if (value instanceof Expr) return value.node

	return { kind: 'param', value }
}

/** A literal value, always sent as a query parameter. */
export function literal<V extends string | number | boolean | Date>(
	value: V
): Expr<
	V extends number
		? 'number'
		: V extends boolean
			? 'boolean'
			: V extends Date
				? 'timestamp'
				: 'string',
	V
> {
	return new Expr({ kind: 'param', value })
}

function compare<T extends SqlType, V extends ParamValue>(
	op: CompareOp,
	left: Expr<T, V>,
	right: Operand<T, NonNullable<V>>
): Expr<'boolean'> {
	return new Expr({
		kind: 'compare',
		op,
		left: left.node,
		right: toNode(right)
	})
}

export function eq<T extends SqlType, V extends ParamValue>(
	left: Expr<T, V>,
	right: Operand<NoInfer<T>, NonNullable<NoInfer<V>>>
): Expr<'boolean'> {
	return compare('=', left, right)
}

export function ne<T extends SqlType, V extends ParamValue>(
	left: Expr<T, V>,
	right: Operand<NoInfer<T>, NonNullable<NoInfer<V>>>
): Expr<'boolean'> {
	return compare('<>', left, right)
}

export function gt<T extends SqlType, V extends ParamValue>(
	left: Expr<T, V>,
	right: Operand<NoInfer<T>, NonNullable<NoInfer<V>>>
): Expr<'boolean'> {
	return compare('>', left, right)
}

export function gte<T extends SqlType, V extends ParamValue>(
	left: Expr<T, V>,
	right: Operand<NoInfer<T>, NonNullable<NoInfer<V>>>
): Expr<'boolean'> {
	return compare('>=', left, right)
}

export function lt<T extends SqlType, V extends ParamValue>(
	left: Expr<T, V>,
	right: Operand<NoInfer<T>, NonNullable<NoInfer<V>>>
): Expr<'boolean'> {
	return compare('<', left, right)
}

export function lte<T extends SqlType, V extends ParamValue>(
	left: Expr<T, V>,
	right: Operand<NoInfer<T>, NonNullable<NoInfer<V>>>
): Expr<'boolean'> {
	return compare('<=', left, right)
}

export function and(...items: Expr<'boolean'>[]): Expr<'boolean'> {
	return new Expr({
		kind: 'logical',
		op: 'and',
		items: items.map((i) => i.node)
	})
}

export function or(...items: Expr<'boolean'>[]): Expr<'boolean'> {
	return new Expr({
		kind: 'logical',
		op: 'or',
		items: items.map((i) => i.node)
	})
}

export function not(item: Expr<'boolean'>): Expr<'boolean'> {
	if (item.node.kind === 'exists') {
		return new Expr({ ...item.node, negated: !item.node.negated })
	}

	return new Expr({ kind: 'not', item: item.node })
}

export function isNull(item: Expr<SqlType, unknown>): Expr<'boolean', boolean> {
	return item.isNull()
}

export function isNotNull(
	item: Expr<SqlType, unknown>
): Expr<'boolean', boolean> {
	return item.isNotNull()
}

type CaseValue = string | number | boolean | Expr<SqlType, unknown>

type CaseType<V> =
	V extends Expr<infer T, unknown>
		? T
		: V extends string
			? 'string'
			: V extends number
				? 'number'
				: V extends boolean
					? 'boolean'
					: never

/**
 * `CASE WHEN ... THEN ... ELSE ... END`. Branches are checked in order. Plain values become
 * parameters; a computed dimension's `values` must list every plain value used here. Without
 * `otherwise`, rows matching no branch are null, and the type says so.
 */
export function caseWhen<const V extends CaseValue>(
	branches: readonly (readonly [Expr<'boolean', unknown>, V])[]
): Expr<CaseType<V>, ValuesOf<V> | null>
export function caseWhen<const V extends CaseValue, const O extends CaseValue>(
	branches: readonly (readonly [Expr<'boolean', unknown>, V])[],
	otherwise: O
): Expr<CaseType<V | O>, ValuesOf<V | O>>
export function caseWhen(
	branches: readonly (readonly [Expr<'boolean', unknown>, CaseValue])[],
	otherwise?: CaseValue
): Expr<SqlType, unknown> {
	if (branches.length === 0) {
		throw new Error('caseWhen needs at least one branch')
	}

	return new Expr({
		kind: 'case',
		branches: branches.map(([when, then]) => ({
			when: when.node,
			result: toNode(then)
		})),
		otherwise: otherwise === undefined ? null : toNode(otherwise)
	})
}

/**
 * A correlated `EXISTS`: true when `from` has a row matching `where`. `where` usually links
 * the subquery table to the outer table, for example
 * `exists(message, eq(message.col('sessionId'), session.col('id')))`.
 */
export function exists<Row>(
	from: Table<Row>,
	where: Expr<'boolean'>
): Expr<'boolean', boolean> {
	return new Expr({
		kind: 'exists',
		table: from.ref,
		where: where.node,
		negated: false
	})
}

/** Null only when every item can be null; a plain fallback value is never null. */
type Coalesced<V, Rest> = [Rest] extends [never]
	? V
	: null extends Rest
		? V | Rest
		: NonNullable<V> | Rest

export function coalesce<
	T extends SqlType,
	V extends ParamValue,
	const R extends readonly Operand<NoInfer<T>>[]
>(first: Expr<T, V>, ...rest: R): Expr<T, Coalesced<V, ValuesOf<R[number]>>> {
	return new Expr({
		kind: 'coalesce',
		items: [first.node, ...rest.map((item) => toNode(item))]
	})
}

/** Matches `item` against a fixed list of values. */
export function inList<T extends SqlType, V extends ParamValue>(
	item: Expr<T, V>,
	values: readonly NonNullable<NoInfer<V>>[]
): Expr<'boolean'> {
	return new Expr({
		kind: 'in',
		item: item.node,
		values: values.map((value) => toNode(value)),
		negated: false
	})
}

/** `item` as text, for example to compare an enum column with a value outside the enum. */
export function toText<V>(
	item: Expr<SqlType, V>
): Expr<'string', string | NullOf<V>> {
	return new Expr({ kind: 'toText', item: item.node })
}

/**
 * The moment the query runs, minus `minutes`, such as "created in the last 15 minutes". The
 * query's clock supplies the moment, so it follows the `now` option of `createAnalytics`.
 */
export function minutesAgo(minutes: number): Expr<'timestamp', Date> {
	return new Expr({ kind: 'minutesAgo', minutes })
}

/** Follows the join chain up to the table that is not joined to anything. */
export function rootOf(ref: TableRef): TableRef {
	let current = ref
	while (current.join) current = current.join.parent

	return current
}

/** The nodes directly below `node`, including an `exists` subquery's condition. */
export function directChildren(node: ExprNode): readonly ExprNode[] {
	switch (node.kind) {
		case 'compare':
		case 'arithmetic':
			return [node.left, node.right]
		case 'logical':
		case 'coalesce':
			return node.items
		case 'not':
		case 'isNull':
		case 'lower':
		case 'toText':
		case 'timeBucket':
		case 'timePart':
			return [node.item]
		case 'in':
			return [node.item, ...node.values]
		case 'case':
			return [
				...node.branches.flatMap((branch) => [branch.when, branch.result]),
				...(node.otherwise ? [node.otherwise] : [])
			]
		case 'aggregate':
			return [
				...(node.arg ? [node.arg] : []),
				...(node.where ? [node.where] : [])
			]
		case 'exists':
			return [node.where]
		case 'column':
		case 'param':
		case 'minutesAgo':
			return []
	}
}

/** Visits every node in a tree, depth first. */
export function walk(node: ExprNode, visit: (node: ExprNode) => void): void {
	visit(node)
	for (const child of directChildren(node)) walk(child, visit)
}
