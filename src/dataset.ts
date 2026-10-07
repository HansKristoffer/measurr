import {
	type Expr,
	type ExprNode,
	type SqlType,
	type Table,
	type TableRef,
	type TimeBucketUnit,
	type TimePartName,
	directChildren,
	rootOf
} from './expr.js'

declare const ratioBrand: unique symbol

/** A share or ratio between 0 and 1. Branded so nobody renders 0.42 as "0.42%". */
export type Ratio = number & { readonly [ratioBrand]: 'zeroToOne' }

type Described = {
	label: string
	description?: string | undefined
}

// ---------------------------------------------------------------------------------------------
// Measures

/**
 * `count` results are never null. `number` results (sum, avg, median) are null for an empty
 * group. `ratio` results (share, ratio) are a 0-1 `Ratio`, null when the base is zero.
 */
export type MeasureResult = 'count' | 'number' | 'ratio'

export type AggregateMeasure<
	R extends 'count' | 'number' = 'count' | 'number'
> = {
	readonly kind: 'aggregate'
	readonly result: R
	readonly label: string
	readonly description: string | undefined
	readonly node: Extract<ExprNode, { kind: 'aggregate' }>
}

export type ShareMeasure = {
	readonly kind: 'share'
	readonly result: 'ratio'
	readonly label: string
	readonly description: string | undefined
	readonly numerator: ExprNode
	readonly denominator: ExprNode | null
}

export type RatioMeasure<
	A extends string = string,
	B extends string = string
> = {
	readonly kind: 'ratio'
	readonly result: 'ratio'
	readonly label: string
	readonly description: string | undefined
	readonly numerator: A
	readonly denominator: B
}

export type AnyMeasure = AggregateMeasure | ShareMeasure | RatioMeasure

/** The TypeScript type of a measure's value in a result row. */
export type MeasureValue<M> = M extends { result: 'count' }
	? number
	: M extends { result: 'number' }
		? number | null
		: Ratio | null

type Filtered = Described & { where?: Expr<'boolean'> | undefined }

function aggregate<R extends 'count' | 'number'>(
	result: R,
	fn: Extract<ExprNode, { kind: 'aggregate' }>['fn'],
	arg: Expr<SqlType> | null,
	options: Filtered
): AggregateMeasure<R> {
	return {
		kind: 'aggregate',
		result,
		label: options.label,
		description: options.description,
		node: {
			kind: 'aggregate',
			fn,
			arg: arg?.node ?? null,
			where: options.where?.node ?? null
		}
	}
}

export const measure = {
	/** Number of rows, optionally only those matching `where`. */
	count(options: Filtered): AggregateMeasure<'count'> {
		return aggregate('count', 'count', null, options)
	},

	/** Number of rows matching `condition`. */
	countWhere(
		condition: Expr<'boolean'>,
		options: Described
	): AggregateMeasure<'count'> {
		return aggregate('count', 'count', null, { ...options, where: condition })
	},

	/** Number of distinct non-null values of `expr`. */
	countDistinct(
		expr: Expr<SqlType>,
		options: Filtered
	): AggregateMeasure<'count'> {
		return aggregate('count', 'countDistinct', expr, options)
	},

	sum(expr: Expr<'number'>, options: Filtered): AggregateMeasure<'number'> {
		return aggregate('number', 'sum', expr, options)
	},

	avg(expr: Expr<'number'>, options: Filtered): AggregateMeasure<'number'> {
		return aggregate('number', 'avg', expr, options)
	},

	median(expr: Expr<'number'>, options: Filtered): AggregateMeasure<'number'> {
		return aggregate('number', 'median', expr, options)
	},

	/**
	 * The share of rows matching `numerator` among rows matching `denominator` (all rows when
	 * omitted). A `Ratio` from 0 to 1.
	 */
	share(
		options: Described & {
			numerator: Expr<'boolean'>
			denominator?: Expr<'boolean'> | undefined
		}
	): ShareMeasure {
		return {
			kind: 'share',
			result: 'ratio',
			label: options.label,
			description: options.description,
			numerator: options.numerator.node,
			denominator: options.denominator?.node ?? null
		}
	},

	/**
	 * One measure of this dataset over another, computed after aggregation. Both keys must be
	 * measures of the same dataset; `defineDataset` checks them.
	 */
	ratio<const A extends string, const B extends string>(
		numerator: A,
		denominator: B,
		options: Described
	): RatioMeasure<A, B> {
		return {
			kind: 'ratio',
			result: 'ratio',
			label: options.label,
			description: options.description,
			numerator,
			denominator
		}
	}
}

// ---------------------------------------------------------------------------------------------
// Dimensions

/**
 * How a dimension filters:
 * - `closed`: a fixed set of keys (enum, computed) - `in`, `notIn`, `isEmpty`, `isNotEmpty`;
 * - `open`: keys from the data (relation, many-to-many) - the same operators, with values given
 *   as keys or labels and resolved at query time;
 * - `numeric`: numbers (numeric columns, weekday, hour) - `between`, `isEmpty`, `isNotEmpty`;
 * - `time`: time buckets keyed by ISO date - `between`, `isEmpty`, `isNotEmpty`.
 */
export type DimensionCategory = 'closed' | 'open' | 'numeric' | 'time'

type DimensionOptions<
	G extends boolean = boolean,
	F extends boolean = boolean
> = Described & {
	/** Only offered for grouping. */
	groupOnly?: G | undefined
	/** Only offered for filtering. */
	filterOnly?: F | undefined
}

/** Time dimensions name themselves after their unit unless given a label. */
type TimeDimensionOptions<G extends boolean, F extends boolean, Key> = Omit<
	DimensionOptions<G, F>,
	'label'
> & {
	label?: string | undefined
	labelFor?: ((key: Key) => string) | undefined
}

/**
 * `groupOnly: true` makes `filterable` the literal `false` (and `filterOnly`, `groupable`), so
 * queries cannot filter or group by what the dimension does not offer.
 */
export type DimensionAccess<G extends boolean, F extends boolean> = {
	readonly groupable: [F] extends [true] ? false : boolean
	readonly filterable: [G] extends [true] ? false : boolean
}

type DimensionBase<C extends DimensionCategory, Key> = {
	readonly category: C
	readonly label: string
	readonly description: string | undefined
	readonly groupable: boolean
	readonly filterable: boolean
	/** Phantom: the key type in result rows. */
	readonly keyType?: Key
}

/** `Empty` is `null` when the expression can be null, `never` when it cannot. */
export type EnumDimension<
	K extends string = string,
	Empty extends null = null
> = DimensionBase<'closed', K | Empty> & {
	readonly kind: 'enum' | 'computed'
	readonly expr: ExprNode
	readonly values: Readonly<Record<K, string>>
	readonly empty: string | undefined
}

export type RelationDimension<K = unknown> = DimensionBase<'open', K> & {
	readonly kind: 'relation'
	readonly key: ExprNode
	readonly name: ExprNode
	readonly empty: string | undefined
}

export type ManyToManyDimension = DimensionBase<'open', string> & {
	readonly kind: 'manyToMany'
	readonly table: TableRef
	readonly on: ExprNode
	readonly key: ExprNode
	readonly name: ExprNode
	readonly empty: string | undefined
	readonly note: string | undefined
}

export type NumberDimension = DimensionBase<'numeric', number> & {
	readonly kind: 'number'
	readonly expr: ExprNode
	readonly labelFor: ((key: number) => string) | undefined
}

export type TimePartDimension<T extends string = string> = DimensionBase<
	'numeric',
	number
> & {
	readonly kind: 'timePart'
	readonly time: T
	readonly part: TimePartName
	readonly labelFor: ((key: number) => string) | undefined
}

export type TimeBucketDimension<T extends string = string> = DimensionBase<
	'time',
	string
> & {
	readonly kind: 'timeBucket'
	readonly time: T
	readonly unit: TimeBucketUnit
	readonly labelFor: ((key: string) => string) | undefined
}

export type AnyDimension =
	| EnumDimension
	| RelationDimension
	| ManyToManyDimension
	| NumberDimension
	| TimePartDimension
	| TimeBucketDimension

/**
 * `{ key, label }` as it appears in a result row for this dimension. Enum and computed keys
 * are null only when their expression can be null; any other key is null when the row has no
 * value (no related row, a null column, a time field the period does not apply to).
 */
export type DimensionValue<Dim> = Dim extends {
	kind: 'enum' | 'computed'
	keyType?: infer K
}
	? { key: K; label: string }
	: Dim extends { keyType?: infer K }
		? { key: K | null; label: string }
		: never

/** `null` when an expression's values `V` include null, otherwise `never`. */
type EmptyOf<V> = null extends V ? null : never

/**
 * Makes `expr` fail typecheck when it can produce a value `Allowed` does not list, naming the
 * missing values. Expressions typed only as `string` pass; `defineDataset` checks those.
 */
type CoversValues<V, Allowed> =
	string extends NonNullable<V>
		? unknown
		: [Exclude<NonNullable<V>, Allowed>] extends [never]
			? unknown
			: { readonly missingFromValues: Exclude<NonNullable<V>, Allowed> }

/** What a closed dimension's null key is called. */
type EmptyOption = {
	/** The label of rows whose value is null. "None" when omitted. */
	empty?: string | undefined
}

function base(options: DimensionOptions) {
	return {
		label: options.label,
		description: options.description,
		groupable: options.filterOnly !== true,
		filterable: options.groupOnly !== true
	}
}

/** Narrows `groupable` and `filterable` (which `base` computed) to what the options say. */
function withAccess<
	D extends AnyDimension,
	G extends boolean,
	F extends boolean
>(
	_options:
		| { groupOnly?: G | undefined; filterOnly?: F | undefined }
		| undefined,
	dimension: D
): D & DimensionAccess<G, F> {
	return dimension as D & DimensionAccess<G, F>
}

export const dimension = {
	/**
	 * A column holding one value of a closed set, such as a Prisma enum. `labels` must name
	 * every value, so adding an enum value fails typecheck until it has a label, and a column
	 * typed with values outside `values` fails too. A nullable column gives null keys.
	 */
	enum<
		const E extends Record<string, string>,
		V extends string | null,
		G extends boolean = boolean,
		F extends boolean = boolean
	>(
		expr: Expr<'string', V> & CoversValues<V, E[keyof E]>,
		values: E,
		options: DimensionOptions<G, F> &
			EmptyOption & { labels: Record<E[keyof E], string> }
	): EnumDimension<E[keyof E], EmptyOf<V>> & DimensionAccess<G, F> {
		for (const value of Object.values(values)) {
			if (!(value in options.labels)) {
				throw new Error(`${options.label}: the value ${value} has no label`)
			}
		}

		return withAccess(options, {
			...base(options),
			category: 'closed',
			kind: 'enum',
			expr: expr.node,
			values: options.labels,
			empty: options.empty
		})
	},

	/**
	 * A value computed from other columns with the expression builders, usually `caseWhen`.
	 * `values` lists every value the expression can produce, with its label; a plain value of
	 * the expression missing from `values` fails typecheck. A `caseWhen` without `otherwise`
	 * gives null keys.
	 */
	computed<
		V extends string | null,
		const K extends string,
		G extends boolean = boolean,
		F extends boolean = boolean
	>(
		options: DimensionOptions<G, F> &
			EmptyOption & {
				expr: Expr<'string', V> & CoversValues<V, NoInfer<K>>
				values: Record<K, string>
			}
	): EnumDimension<K, EmptyOf<V>> & DimensionAccess<G, F> {
		return withAccess(options, {
			...base(options),
			category: 'closed',
			kind: 'computed',
			expr: options.expr.node,
			values: options.values,
			empty: options.empty
		})
	},

	/**
	 * A to-one relation such as a team. The key type comes from the `key` column, so a branded
	 * id column types the key in filters and rows. Rows without a related record get the
	 * `empty` label and a null key.
	 */
	relation<
		Key extends string | number,
		G extends boolean = boolean,
		F extends boolean = boolean
	>(
		options: DimensionOptions<G, F> & {
			key: Expr<Key extends number ? 'number' : 'string', Key | null>
			name: Expr<'string'>
			empty?: string | undefined
		}
	): RelationDimension<Key> & DimensionAccess<G, F> {
		return withAccess(options, {
			...base(options),
			category: 'open',
			kind: 'relation',
			key: options.key.node,
			name: options.name.node,
			empty: options.empty
		})
	},

	/**
	 * A to-many relation through a link table, such as tags. Grouping counts a row once per
	 * related value, so totals for such a grouping come from a separate query. Filtering
	 * compiles to `EXISTS`, so it never multiplies rows.
	 *
	 * `through.table` is the link table as a standalone `table()` (further joins hang off it),
	 * and `through.on` links it to the dataset's table.
	 */
	manyToMany<
		Row = unknown,
		G extends boolean = boolean,
		F extends boolean = boolean
	>(
		options: DimensionOptions<G, F> & {
			through: {
				table: Table<Row>
				on: Expr<'boolean'>
				key: Expr<'string' | 'number'>
				name: Expr<'string'>
			}
			/** Explains the overlap to the reader of a grouped result. */
			note?: string | undefined
			empty?: string | undefined
		}
	): ManyToManyDimension & DimensionAccess<G, F> {
		return withAccess(options, {
			...base(options),
			category: 'open',
			kind: 'manyToMany',
			table: options.through.table.ref,
			on: options.through.on.node,
			key: options.through.key.node,
			name: options.through.name.node,
			empty: options.empty,
			note: options.note
		})
	},

	/** A numeric column, grouped by its exact values and filtered with `between`. */
	number<G extends boolean = boolean, F extends boolean = boolean>(
		expr: Expr<'number'>,
		options: DimensionOptions<G, F> & {
			labelFor?: ((key: number) => string) | undefined
		}
	): NumberDimension & DimensionAccess<G, F> {
		return withAccess(options, {
			...base(options),
			category: 'numeric',
			kind: 'number',
			expr: expr.node,
			labelFor: options.labelFor
		})
	},

	/** Day, ISO week (starting Monday) or month of a time field, in the tenant's timezone. */
	timeBucket<
		const T extends string,
		G extends boolean = boolean,
		F extends boolean = boolean
	>(
		time: T,
		unit: TimeBucketUnit,
		options?: TimeDimensionOptions<G, F, string>
	): TimeBucketDimension<T> & DimensionAccess<G, F> {
		return withAccess(options, {
			...base({
				...options,
				label: options?.label ?? unit[0]?.toUpperCase() + unit.slice(1)
			}),
			category: 'time',
			kind: 'timeBucket',
			time,
			unit,
			labelFor: options?.labelFor
		})
	},

	/** ISO weekday (1 = Monday) or hour (0-23) of a time field, in the tenant's timezone. */
	timePart<
		const T extends string,
		G extends boolean = boolean,
		F extends boolean = boolean
	>(
		time: T,
		part: TimePartName,
		options?: TimeDimensionOptions<G, F, number>
	): TimePartDimension<T> & DimensionAccess<G, F> {
		return withAccess(options, {
			...base({
				...options,
				label: options?.label ?? (part === 'isodow' ? 'Weekday' : 'Hour')
			}),
			category: 'numeric',
			kind: 'timePart',
			time,
			part,
			labelFor: options?.labelFor
		})
	}
}

// ---------------------------------------------------------------------------------------------
// Datasets

export type TimeField = { readonly column: ExprNode; readonly label: string }

export type Dataset<
	K extends string = string,
	M extends Record<string, AnyMeasure> = Record<string, AnyMeasure>,
	Dm extends Record<string, AnyDimension> = Record<string, AnyDimension>,
	T extends string = string
> = {
	readonly key: K
	readonly label: string
	readonly description: string
	readonly from: TableRef
	readonly source: string | undefined
	readonly tenantColumn: ExprNode
	readonly scope: ExprNode | null
	readonly time: Readonly<Record<T, TimeField>>
	readonly defaultTime: T
	readonly measures: M
	readonly dimensions: Dm
}

// biome-ignore lint/suspicious/noExplicitAny: the widest dataset, used only as a constraint.
export type AnyDataset = Dataset<string, any, any, string>

/** Ratio measures may only name other measures of the same dataset. */
type CheckMeasures<M> = {
	[Key in keyof M]: M[Key] extends { kind: 'ratio' }
		? {
				numerator: Exclude<keyof M & string, Key>
				denominator: Exclude<keyof M & string, Key>
			}
		: unknown
}

/** Time dimensions may only name declared time fields. */
type CheckDimensions<Dm, T extends string> = {
	[Key in keyof Dm]: Dm[Key] extends { kind: 'timeBucket' | 'timePart' }
		? { time: T }
		: unknown
}

export type DatasetDefinition<
	K extends string,
	M extends Record<string, AnyMeasure>,
	Dm extends Record<string, AnyDimension>,
	T extends string
> = {
	key: K
	label: string
	/** Tells a reader (and a model) what one row of the dataset is. */
	description: string
	from: { readonly ref: TableRef }
	/** Which source (database) the dataset runs on; the default when there is one source. */
	source?: string | undefined
	/** The column every query is filtered by; the value comes from `tenant(ctx)`. */
	tenantColumn: Expr<SqlType>
	/** Always applied, for example excluding test rows. */
	scope?: Expr<'boolean'> | undefined
	time: Record<T, { column: Expr<'timestamp'>; label: string }>
	/** The time field periods apply to when a query names none; the first one by default. */
	defaultTime?: NoInfer<T> | undefined
	measures: M & CheckMeasures<M>
	dimensions: Dm & CheckDimensions<Dm, NoInfer<T>>
}

/**
 * Declares a dataset: one fact table with its tenant column, time fields, measures and
 * dimensions. Keys stay literal types, so queries and result rows are typed from it.
 */
export function defineDataset<
	const K extends string,
	const M extends Record<string, AnyMeasure>,
	const Dm extends Record<string, AnyDimension>,
	const T extends string
>(definition: DatasetDefinition<K, M, Dm, T>): Dataset<K, M, Dm, T> {
	const timeEntries = Object.entries<{
		column: Expr<'timestamp'>
		label: string
	}>(definition.time)
	const firstTime = timeEntries[0]
	if (!firstTime) {
		throw new Error(
			`Dataset ${definition.key}: declare at least one time field`
		)
	}

	const time = Object.fromEntries(
		timeEntries.map(([key, field]) => [
			key,
			{ column: field.column.node, label: field.label }
		])
	) as Record<T, TimeField>

	const dataset: Dataset<K, M, Dm, T> = {
		key: definition.key,
		label: definition.label,
		description: definition.description,
		from: definition.from.ref,
		source: definition.source,
		tenantColumn: definition.tenantColumn.node,
		scope: definition.scope?.node ?? null,
		time,
		defaultTime: definition.defaultTime ?? (firstTime[0] as T),
		measures: definition.measures,
		dimensions: definition.dimensions
	}

	return validateDataset(dataset)
}

/**
 * Checks what the types cannot: every column is reachable from the dataset's table, ratio
 * bases exist without cycles, and computed values cover the expression's plain values.
 */
function validateDataset<DS extends AnyDataset>(dataset: DS): DS {
	const fail = (message: string): never => {
		throw new Error(`Dataset ${dataset.key}: ${message}`)
	}

	const check = (
		node: ExprNode,
		where: string,
		extraRoots: readonly TableRef[] = []
	) => {
		visitScoped(node, [dataset.from, ...extraRoots], (inner, roots) => {
			if (inner.kind === 'column') {
				const root = rootOf(inner.table)
				if (!roots.includes(root)) {
					fail(
						`${where} reads ${inner.table.name}.${inner.column}, which is not joined to ${dataset.from.name}`
					)
				}
			}
		})
	}

	check(dataset.tenantColumn, 'tenantColumn')
	if (dataset.scope) check(dataset.scope, 'scope')
	for (const [key, field] of Object.entries<TimeField>(dataset.time)) {
		check(field.column, `time field ${key}`)
	}

	const measures: Record<string, AnyMeasure> = dataset.measures
	for (const [key, entry] of Object.entries(measures)) {
		if (entry.kind === 'aggregate') check(entry.node, `measure ${key}`)
		if (entry.kind === 'share') {
			check(entry.numerator, `measure ${key}`)
			if (entry.denominator) check(entry.denominator, `measure ${key}`)
		}
		if (entry.kind === 'ratio') checkRatio(measures, key, [], fail)
	}

	const dimensions: Record<string, AnyDimension> = dataset.dimensions
	for (const [key, entry] of Object.entries(dimensions)) {
		const where = `dimension ${key}`
		switch (entry.kind) {
			case 'enum':
			case 'number':
				check(entry.expr, where)
				break
			case 'computed':
				check(entry.expr, where)
				for (const value of plainCaseValues(entry.expr)) {
					if (!(value in entry.values)) {
						fail(
							`${where} can produce "${value}", which is missing from its values`
						)
					}
				}
				break
			case 'relation':
				check(entry.key, where)
				check(entry.name, where)
				break
			case 'manyToMany':
				if (entry.table.join) {
					fail(
						`${where}: through.table must be a standalone table(), not a join`
					)
				}
				check(entry.on, where, [entry.table])
				check(entry.key, where, [entry.table])
				check(entry.name, where, [entry.table])
				break
			case 'timeBucket':
			case 'timePart':
				if (!(entry.time in dataset.time))
					fail(`${where} names unknown time field ${entry.time}`)
				break
		}
	}

	return dataset
}

function checkRatio(
	measures: Record<string, AnyMeasure>,
	key: string,
	path: string[],
	fail: (message: string) => never
): void {
	if (path.includes(key))
		fail(`ratio measures form a cycle: ${[...path, key].join(' -> ')}`)

	const entry = measures[key]
	if (!entry) fail(`ratio measure ${path.at(-1)} names unknown measure ${key}`)
	if (entry?.kind !== 'ratio') return

	checkRatio(measures, entry.numerator, [...path, key], fail)
	checkRatio(measures, entry.denominator, [...path, key], fail)
}

/**
 * Walks an expression while tracking which table roots are in scope: an `exists` subquery
 * brings its own table into scope for its condition, and a joined column's `ON` clause is
 * checked too.
 */
function visitScoped(
	node: ExprNode,
	roots: readonly TableRef[],
	visit: (node: ExprNode, roots: readonly TableRef[]) => void,
	seenJoins = new Set<TableRef>()
): void {
	visit(node, roots)

	if (node.kind === 'exists') {
		visitScoped(node.where, [...roots, node.table], visit, seenJoins)
		return
	}
	if (node.kind === 'column' && node.table.join && !seenJoins.has(node.table)) {
		// An ON clause reads its own table, so visit each one once.
		seenJoins.add(node.table)
		visitScoped(node.table.join.on, roots, visit, seenJoins)
		return
	}

	for (const child of directChildren(node)) {
		visitScoped(child, roots, visit, seenJoins)
	}
}

/** The plain string values a computed expression can produce. */
function plainCaseValues(node: ExprNode): string[] {
	if (node.kind === 'param' && typeof node.value === 'string')
		return [node.value]
	if (node.kind === 'case') {
		return [
			...node.branches.flatMap((branch) => plainCaseValues(branch.result)),
			...(node.otherwise ? plainCaseValues(node.otherwise) : [])
		]
	}
	if (node.kind === 'coalesce') return node.items.flatMap(plainCaseValues)

	return []
}
