/**
 * The contract test kit: the same checks for every dataset, run against a seeded database.
 * Framework-free: `checkDatasetContract` returns a report and `assertDatasetContract` throws
 * with every failure listed, so it works from `bun:test`, vitest or a script.
 */
import { type AnalyticsSource, createAnalytics } from './analytics.js'
import {
	type AnyDataset,
	type AnyDimension,
	dimension,
	measure
} from './dataset.js'
import type { PeriodInput } from './period.js'
import { MAX_MEASURES } from './query.js'

export type ContractCheck = {
	name: string
	ok: boolean
	message: string | undefined
}
export type ContractReport = { ok: boolean; checks: ContractCheck[] }

export type ContractOptions = {
	dataset: AnyDataset
	source: AnalyticsSource
	/** A tenant with seeded rows in the period. */
	tenant: string | number
	/** A tenant with no rows; defaults to a sentinel that no real tenant uses. */
	emptyTenant?: string | number
	/** A timezone far from UTC makes bucketing mistakes visible. Defaults to Pacific/Auckland. */
	timezone?: string
	/** Defaults to the last 365 days. */
	period?: PeriodInput
	now?: () => Date
}

const COUNT = '__contractCount'
const dayKey = (time: string) => `__contractDay_${time}`

type ProbeRow = Record<string, { key: unknown; label: string } | number | null>
type ProbeResult = {
	rows: ProbeRow[]
	totals: Record<string, number | null>
	truncated: boolean
}

/**
 * Checks that every measure, grouping and filter compiles and runs, that groups add up to the
 * total, that labels resolve, that another tenant's rows never count, and that day buckets
 * agree with periods in the timezone.
 */
export async function checkDatasetContract(
	options: ContractOptions
): Promise<ContractReport> {
	const { dataset } = options
	const timezone = options.timezone ?? 'Pacific/Auckland'
	const period = options.period ?? { last: { days: 365 } }
	const emptyTenant =
		options.emptyTenant ??
		(typeof options.tenant === 'number' ? -1 : '__contract_empty_tenant__')

	const probe: AnyDataset = {
		...dataset,
		measures: {
			...dataset.measures,
			[COUNT]: measure.count({ label: 'Rows' })
		},
		dimensions: {
			...dataset.dimensions,
			...Object.fromEntries(
				Object.keys(dataset.time).map((time) => [
					dayKey(time),
					dimension.timeBucket(time, 'day')
				])
			)
		}
	}
	const analytics = createAnalytics({
		datasets: [probe],
		sources: { main: options.source },
		tenant: (ctx: { tenant: string | number }) => ctx.tenant,
		timezone: () => timezone,
		...(options.now && { now: options.now })
	})

	const run = async (
		query: Record<string, unknown>,
		tenant: string | number = options.tenant
	): Promise<ProbeResult> => {
		const input = { dataset: dataset.key, period, limit: 100, ...query }
		return (await analytics.query(input as never, {
			tenant
		})) as unknown as ProbeResult
	}

	const checks: ContractCheck[] = []
	const check = async (
		name: string,
		body: () => Promise<string | undefined>
	) => {
		try {
			const problem = await body()
			checks.push({ name, ok: problem === undefined, message: problem })
		} catch (error) {
			checks.push({
				name,
				ok: false,
				message: error instanceof Error ? error.message : String(error)
			})
		}
	}

	const total = (await run({ measures: [COUNT] })).totals[COUNT] ?? 0
	if (total === 0) {
		checks.push({
			name: 'seeded rows',
			ok: false,
			message: `Tenant ${options.tenant} has no rows in the period; the checks below prove little`
		})
	}

	for (const key of Object.keys(dataset.measures)) {
		await check(`measure ${key}`, async () => {
			const value = (await run({ measures: [key] })).totals[key]
			if (value !== null && typeof value !== 'number')
				return `returned ${String(value)}`
			if (typeof value === 'number' && Number.isNaN(value))
				return 'returned NaN'
			return undefined
		})
	}

	const dimensions = Object.entries<AnyDimension>(dataset.dimensions)
	for (const [key, entry] of dimensions) {
		if (entry.groupable) {
			await check(`group by ${key}`, async () => {
				const result = await run({ measures: [COUNT], groupBy: [key] })
				if (entry.kind === 'manyToMany' || result.truncated) return undefined

				const sum = result.rows.reduce(
					(acc, row) => acc + Number(row[COUNT] ?? 0),
					0
				)
				return sum === total
					? undefined
					: `groups add up to ${sum}, the total is ${total}`
			})
		}

		if (entry.filterable) {
			await check(`filter ${key} by emptiness`, async () => {
				const empty = await run({
					measures: [COUNT],
					filters: [{ dimension: key, op: 'isEmpty' }]
				})
				const notEmpty = await run({
					measures: [COUNT],
					filters: [{ dimension: key, op: 'isNotEmpty' }]
				})
				const sum = (empty.totals[COUNT] ?? 0) + (notEmpty.totals[COUNT] ?? 0)
				return sum === total
					? undefined
					: `isEmpty + isNotEmpty is ${sum}, the total is ${total}`
			})
		}

		if (entry.filterable && entry.groupable && entry.category === 'open') {
			await check(`filter ${key} by label`, async () => {
				const grouped = await run({ measures: [COUNT], groupBy: [key] })
				const first = grouped.rows.find((row) => {
					const value = row[key]
					return (
						typeof value === 'object' && value !== null && value.key !== null
					)
				})
				const value = first?.[key]
				if (!first || typeof value !== 'object' || value === null)
					return undefined

				const filtered = await run({
					measures: [COUNT],
					filters: [{ dimension: key, op: 'in', values: [value.label] }]
				})
				const expected = Number(first[COUNT])
				const actual = filtered.totals[COUNT]
				return actual === expected
					? undefined
					: `filtering by the label "${value.label}" counts ${actual}, its group counts ${expected}`
			})
		}

		if (entry.filterable && entry.category === 'closed') {
			await check(`filter ${key} by value`, async () => {
				const [first] = Object.keys(
					entry.kind === 'enum' || entry.kind === 'computed' ? entry.values : {}
				)
				if (first === undefined) return 'lists no values'
				await run({
					measures: [COUNT],
					filters: [{ dimension: key, op: 'in', values: [first] }]
				})
				return undefined
			})
		}
	}

	await check('tenant isolation', async () => {
		const measures = Object.keys(probe.measures)
		const leaked: [string, number | null][] = []
		for (let start = 0; start < measures.length; start += MAX_MEASURES) {
			const batch = measures.slice(start, start + MAX_MEASURES)
			const other = await run({ measures: batch }, emptyTenant)
			leaked.push(
				...Object.entries(other.totals).filter(
					([, value]) => value !== 0 && value !== null
				)
			)
		}
		if (leaked.length > 0) {
			return `an empty tenant sees ${leaked.map(([key, value]) => `${key}=${value}`).join(', ')}`
		}

		for (const [key, entry] of dimensions) {
			if (!entry.groupable) continue
			const grouped = await run(
				{ measures: [COUNT], groupBy: [key] },
				emptyTenant
			)
			if (grouped.rows.length > 0)
				return `an empty tenant sees ${grouped.rows.length} ${key} groups`
		}
		return undefined
	})

	for (const time of Object.keys(dataset.time)) {
		await check(`day buckets of ${time} in ${timezone}`, async () => {
			const days = await run({
				measures: [COUNT],
				groupBy: [dayKey(time)],
				time,
				sort: { by: COUNT, direction: 'desc' }
			})

			for (const row of days.rows.slice(0, 5)) {
				const bucket = row[dayKey(time)]
				if (
					typeof bucket !== 'object' ||
					bucket === null ||
					typeof bucket.key !== 'string'
				)
					continue

				const day = await run({
					measures: [COUNT],
					time,
					period: { from: bucket.key, to: bucket.key }
				})
				if (day.totals[COUNT] !== row[COUNT]) {
					return `the ${bucket.key} bucket counts ${row[COUNT]}, the period ${bucket.key} counts ${day.totals[COUNT]}`
				}
			}
			return undefined
		})
	}

	return { ok: checks.every((entry) => entry.ok), checks }
}

/** Runs `checkDatasetContract` and throws with every failed check listed. */
export async function assertDatasetContract(
	options: ContractOptions
): Promise<ContractReport> {
	const report = await checkDatasetContract(options)
	const failed = report.checks.filter((entry) => !entry.ok)
	if (failed.length > 0) {
		const lines = failed.map((entry) => `- ${entry.name}: ${entry.message}`)
		throw new Error(
			`Dataset ${options.dataset.key} breaks the contract:\n${lines.join('\n')}`
		)
	}

	return report
}
