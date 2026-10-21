import {
	CompileError,
	type CompiledStatement,
	type Dialect,
	type SelectStatement,
	type SqlRenderer,
	decodeNumber,
	renderStatement
} from '../compile.js'
import { type ExprNode, type ParamValue, walk } from '../expr.js'

/**
 * Settings the statements rely on: SQL NULLs for a left join without a match (ClickHouse fills
 * in default values otherwise, which would turn "no region" into an empty string) and
 * `GROUP BY 1, 2`.
 */
const SETTINGS = 'SETTINGS join_use_nulls = 1, enable_positional_arguments = 1'

/**
 * ClickHouse: typed `{pN:Type}` parameters (pass them with `toQueryParams`), backquoted
 * identifiers, `-If` and `-OrNull` aggregates, and buckets in the tenant's timezone. Time
 * columns are `DateTime` or `DateTime64`, which hold an instant, so no timestamp option is
 * needed.
 *
 * Correlated subqueries are not supported, so `exists` and filters on many-to-many dimensions
 * (mark them `groupOnly`) fail when `createAnalytics` compiles the dataset.
 */
export function clickhouseDialect(): Dialect {
	const zone = (expr: string, timezone: string) =>
		`toTimeZone(${expr}, '${timezone.replaceAll("'", "\\'")}')`

	const renderer: SqlRenderer = {
		name: 'clickhouse',
		quote: (identifier) =>
			`\`${identifier.replaceAll('\\', '\\\\').replaceAll('`', '\\`')}\``,
		param(value, index) {
			const { type, bound } = typedParam(value)
			return { placeholder: `{p${index}:${type}}`, value: bound }
		},
		aggregate(fn, arg, where) {
			// -OrNull makes an empty group null, as in Postgres; count stays a number.
			switch (fn) {
				case 'count':
					return where ? `countIf(${where})` : 'count()'
				case 'countDistinct':
					return where ? `uniqExactIf(${arg}, ${where})` : `uniqExact(${arg})`
				case 'sum':
				case 'avg': {
					const args = where ? `${arg}, ${where}` : arg
					return `${fn}${where ? 'If' : ''}OrNull(${args})`
				}
				case 'median':
					// Interpolates between the middle values, like Postgres' percentile_cont.
					return where
						? `quantileExactInclusiveIfOrNull(0.5)(${arg}, ${where})`
						: `quantileExactInclusiveOrNull(0.5)(${arg})`
			}
		},
		divide: (left, right) => `(toFloat64(${left}) / nullIf(${right}, 0))`,
		toText: (expr) => `toString(${expr})`,
		timeBucket(unit, expr, timezone) {
			const local = zone(expr, timezone)
			switch (unit) {
				case 'day':
					return `toString(toDate(${local}))`
				case 'week':
					return `toString(toMonday(${local}))`
				case 'month':
					return `toString(toStartOfMonth(${local}))`
			}
		},
		timePart: (part, expr, timezone) =>
			part === 'isodow'
				? `toDayOfWeek(${zone(expr, timezone)})`
				: `toHour(${zone(expr, timezone)})`
	}

	return {
		name: 'clickhouse',
		compile(statement) {
			rejectCorrelatedSubqueries(statement)
			const compiled = renderStatement(statement, renderer)
			return { ...compiled, text: `${compiled.text}\n${SETTINGS}` }
		},
		decodeNumber
	}
}

/**
 * The compiled values as the `query_params` the ClickHouse client takes: `{ p1, p2, ... }`.
 *
 * ```ts
 * execute: async (statement) => {
 *   const result = await clickhouse.query({
 *     query: statement.text,
 *     query_params: toQueryParams(statement),
 *     format: 'JSONEachRow'
 *   })
 *   return result.json()
 * }
 * ```
 */
export function toQueryParams(
	statement: CompiledStatement
): Record<string, unknown> {
	return Object.fromEntries(
		statement.values.map((value, index) => [`p${index + 1}`, value])
	)
}

function typedParam(value: ParamValue): { type: string; bound: unknown } {
	if (value === null) return { type: 'Nullable(String)', bound: null }
	if (value instanceof Date) {
		// The UTC instant; a DateTime column compares by instant whatever its own timezone.
		const utc = value.toISOString().replace('T', ' ').replace('Z', '')
		return { type: "DateTime64(3, 'UTC')", bound: utc }
	}

	switch (typeof value) {
		case 'string':
			return { type: 'String', bound: value }
		case 'boolean':
			return { type: 'Bool', bound: value }
		case 'number':
			return {
				type: Number.isSafeInteger(value) ? 'Int64' : 'Float64',
				bound: value
			}
	}
}

function rejectCorrelatedSubqueries(statement: SelectStatement): void {
	const nodes: ExprNode[] = [
		...statement.select.map((item) => item.node),
		...statement.where,
		...statement.virtualJoins.map((join) => join.on)
	]
	for (const node of nodes) {
		walk(node, (inner) => {
			if (inner.kind === 'exists') {
				throw new CompileError(
					`ClickHouse cannot run the correlated EXISTS that ${inner.table.name} needs: avoid exists() and mark many-to-many dimensions groupOnly`
				)
			}
		})
	}
}
