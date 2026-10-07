import {
	type Dialect,
	type SqlRenderer,
	decodeNumber,
	renderStatement
} from '../compile.js'

export type PostgresDialectOptions = {
	/**
	 * How time columns are stored:
	 * - `timestamptz` (default): `timestamp with time zone`;
	 * - `utc`: `timestamp without time zone` holding UTC wall-clock time, which is what Prisma's
	 *   `DateTime` creates.
	 */
	timestamps?: 'timestamptz' | 'utc'
}

/**
 * Postgres: `$n` parameters, double-quoted identifiers, `FILTER (WHERE ...)` aggregates and
 * buckets with `AT TIME ZONE`. Values are passed untyped so Postgres infers them from the
 * column they meet, which keeps enum columns working.
 */
export function postgresDialect(options: PostgresDialectOptions = {}): Dialect {
	const timestamps = options.timestamps ?? 'timestamptz'

	const local = (expr: string, timezone: string) =>
		timestamps === 'utc'
			? `((${expr}) AT TIME ZONE 'UTC' AT TIME ZONE '${timezone}')`
			: `((${expr}) AT TIME ZONE '${timezone}')`

	const renderer: SqlRenderer = {
		name: 'postgres',
		quote: (identifier) => `"${identifier.replaceAll('"', '""')}"`,
		param(value, index) {
			const placeholder = `$${index}`
			if (!(value instanceof Date)) return { placeholder, value }

			const iso = value.toISOString()
			return {
				placeholder,
				value:
					timestamps === 'utc' ? iso.replace('T', ' ').replace('Z', '') : iso
			}
		},
		aggregate(fn, arg, where) {
			const filter = where ? ` FILTER (WHERE ${where})` : ''
			switch (fn) {
				case 'count':
					return `count(*)${filter}`
				case 'countDistinct':
					return `count(DISTINCT ${arg})${filter}`
				case 'sum':
					return `sum(${arg})${filter}`
				case 'avg':
					return `avg(${arg})${filter}`
				case 'median':
					return `percentile_cont(0.5) WITHIN GROUP (ORDER BY (${arg})::double precision)${filter}`
			}
		},
		divide: (left, right) =>
			`((${left})::double precision / NULLIF(${right}, 0))`,
		toText: (expr) => `CAST(${expr} AS text)`,
		timeBucket: (unit, expr, timezone) =>
			`to_char(date_trunc('${unit}', ${local(expr, timezone)}), 'YYYY-MM-DD')`,
		timePart: (part, expr, timezone) =>
			`CAST(extract(${part} FROM ${local(expr, timezone)}) AS integer)`
	}

	return {
		name: 'postgres',
		compile: (statement) => renderStatement(statement, renderer),
		decodeNumber
	}
}
