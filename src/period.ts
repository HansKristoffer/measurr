/**
 * Periods are whole local days in the tenant's timezone. A period `{ from, to }` covers
 * `from` 00:00 up to (not including) the day after `to` 00:00, converted to instants, so the
 * database compares plain timestamps and can use its time index.
 */

export type PeriodPreset =
	| 'today'
	| 'yesterday'
	| 'thisWeek'
	| 'lastWeek'
	| 'thisMonth'
	| 'lastMonth'
	| 'thisYear'

/** A range of days: what `resolvePeriod` turns into instants. */
export type PeriodRange =
	| { last: { days: number } }
	| { from: string; to: string }
	| { preset: PeriodPreset }

/** A range of days, or `{ all: true }` for no time filter. */
export type PeriodInput = PeriodRange | { all: true }

export type ResolvedPeriod = {
	/** First local day, `YYYY-MM-DD`. */
	from: string
	/** Last local day, inclusive. */
	to: string
	timezone: string
	/** Inclusive start instant. */
	start: Date
	/** Exclusive end instant. */
	end: Date
	days: number
}

export const MAX_PERIOD_DAYS = 731
export const DEFAULT_PERIOD = {
	last: { days: 30 }
} as const satisfies PeriodInput

const DAY_MS = 86_400_000

const formatterCache = new Map<string, Intl.DateTimeFormat>()

function formatter(timezone: string): Intl.DateTimeFormat {
	let cached = formatterCache.get(timezone)
	if (!cached) {
		cached = new Intl.DateTimeFormat('en-US', {
			timeZone: timezone,
			hourCycle: 'h23',
			year: 'numeric',
			month: '2-digit',
			day: '2-digit',
			hour: '2-digit',
			minute: '2-digit',
			second: '2-digit'
		})
		formatterCache.set(timezone, cached)
	}

	return cached
}

/** True for an IANA name the runtime knows. Names are also inlined in SQL, so be strict. */
export function isValidTimezone(timezone: string): boolean {
	if (!/^[A-Za-z][A-Za-z0-9_+\-/]*$/.test(timezone)) return false

	try {
		formatter(timezone)
		return true
	} catch {
		return false
	}
}

function localParts(instant: Date, timezone: string) {
	const parts: Record<string, number> = {}
	for (const part of formatter(timezone).formatToParts(instant)) {
		if (part.type !== 'literal') parts[part.type] = Number(part.value)
	}

	return {
		year: parts.year ?? 0,
		month: parts.month ?? 1,
		day: parts.day ?? 1,
		hour: parts.hour ?? 0,
		minute: parts.minute ?? 0,
		second: parts.second ?? 0
	}
}

/** Milliseconds the timezone is ahead of UTC at `instant`. */
function offsetAt(instant: Date, timezone: string): number {
	const p = localParts(instant, timezone)
	const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second)

	return asUtc - (instant.getTime() - instant.getUTCMilliseconds())
}

/** The local calendar date of `instant` in `timezone`, as `YYYY-MM-DD`. */
export function localDate(instant: Date, timezone: string): string {
	const p = localParts(instant, timezone)

	return formatDate(Date.UTC(p.year, p.month - 1, p.day))
}

/** The instant local midnight starts on `date` in `timezone` (handles DST changes). */
export function startOfLocalDay(date: string, timezone: string): Date {
	const wallClock = parseDate(date)
	const firstGuess = wallClock - offsetAt(new Date(wallClock), timezone)
	const corrected = wallClock - offsetAt(new Date(firstGuess), timezone)

	return new Date(corrected)
}

function parseDate(date: string): number {
	const [year, month, day] = date.split('-').map(Number)

	return Date.UTC(year ?? 0, (month ?? 1) - 1, day ?? 1)
}

function formatDate(utcMs: number): string {
	return new Date(utcMs).toISOString().slice(0, 10)
}

export function addDays(date: string, days: number): string {
	return formatDate(parseDate(date) + days * DAY_MS)
}

function daysBetween(from: string, to: string): number {
	return Math.round((parseDate(to) - parseDate(from)) / DAY_MS)
}

/** 1 = Monday ... 7 = Sunday. */
function isoWeekday(date: string): number {
	const day = new Date(parseDate(date)).getUTCDay()

	return day === 0 ? 7 : day
}

export class PeriodError extends Error {
	override readonly name = 'PeriodError'
}

/** Resolves a period input to local days and instants in `timezone`. */
export function resolvePeriod(
	input: PeriodRange,
	timezone: string,
	now: Date
): ResolvedPeriod {
	const today = localDate(now, timezone)
	const [from, to] = periodDays(input, today)

	if (daysBetween(from, to) < 0) {
		throw new PeriodError(`The period starts (${from}) after it ends (${to}).`)
	}

	return periodFromDays(from, to, timezone)
}

function periodDays(input: PeriodRange, today: string): [string, string] {
	if ('last' in input) return [addDays(today, -(input.last.days - 1)), today]
	if ('from' in input) return [input.from, input.to]

	const monthStart = `${today.slice(0, 8)}01`
	const weekStart = addDays(today, -(isoWeekday(today) - 1))

	switch (input.preset) {
		case 'today':
			return [today, today]
		case 'yesterday':
			return [addDays(today, -1), addDays(today, -1)]
		case 'thisWeek':
			return [weekStart, today]
		case 'lastWeek':
			return [addDays(weekStart, -7), addDays(weekStart, -1)]
		case 'thisMonth':
			return [monthStart, today]
		case 'lastMonth': {
			const lastMonthEnd = addDays(monthStart, -1)
			return [`${lastMonthEnd.slice(0, 8)}01`, lastMonthEnd]
		}
		case 'thisYear':
			return [`${today.slice(0, 4)}-01-01`, today]
	}
}

function periodFromDays(
	from: string,
	to: string,
	timezone: string
): ResolvedPeriod {
	const days = daysBetween(from, to) + 1
	if (days > MAX_PERIOD_DAYS) {
		throw new PeriodError(
			`A period may cover at most ${MAX_PERIOD_DAYS} days (two years); ${from} to ${to} is ${days} days.`
		)
	}

	return {
		from,
		to,
		timezone,
		start: startOfLocalDay(from, timezone),
		end: startOfLocalDay(addDays(to, 1), timezone),
		days
	}
}

/** The period of equal length that ends the day before `period` starts. */
export function previousPeriod(period: ResolvedPeriod): ResolvedPeriod {
	const to = addDays(period.from, -1)
	const from = addDays(to, -(period.days - 1))

	return periodFromDays(from, to, period.timezone)
}
