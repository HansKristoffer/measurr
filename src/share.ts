/**
 * Work shared between callers: one run for identical queries in flight, and one statement for
 * the queries of a batch that count the same rows.
 */

export type Shared<T> = {
	promise: Promise<T>
	controller: AbortController
	waiting: number
}

/**
 * Waits for `shared`. Aborting `signal` rejects only this wait; when every waiter has aborted,
 * `abandoned` is called and the run is aborted.
 */
function wait<T>(
	shared: Shared<T>,
	signal: AbortSignal | undefined,
	abandoned: () => void
): Promise<T> {
	shared.waiting++
	if (!signal) return shared.promise

	return new Promise<T>((resolve, reject) => {
		const onAbort = () => {
			if (--shared.waiting === 0) {
				abandoned()
				shared.controller.abort(signal.reason)
			}
			reject(signal.reason)
		}
		// Keeps a rejection of the run handled when this was its only waiter.
		const settled = shared.promise.then(resolve, reject)
		if (signal.aborted) return onAbort()

		signal.addEventListener('abort', onAbort, { once: true })
		settled.finally(() => signal.removeEventListener('abort', onAbort))
	})
}

/**
 * One run of `start` for every caller that asks for `key` while it is in flight. A caller's
 * abort rejects only its own wait; the run stops when every caller has aborted.
 */
export function share<T>(
	inFlight: Map<string, Shared<T>>,
	key: string,
	start: (signal: AbortSignal) => Promise<T>,
	signal: AbortSignal | undefined
): Promise<T> {
	let shared = inFlight.get(key)
	if (!shared) {
		const controller = new AbortController()
		const created: Shared<T> = {
			controller,
			waiting: 0,
			promise: start(controller.signal).finally(() => {
				if (inFlight.get(key) === created) inFlight.delete(key)
			})
		}
		inFlight.set(key, created)
		shared = created
	}
	const run = shared

	return wait(run, signal, () => {
		if (inFlight.get(key) === run) inFlight.delete(key)
	})
}

type Statement<T> = Shared<T> & {
	/** What every query waiting for the statement needs from it. */
	measures: Set<string>
	begin: () => void
}

/**
 * The statements of queries that run together. Queries whose statements have the same `key`
 * (they count the same rows) get one statement with the measures of all of them.
 *
 * Statements wait until every query that joined has added its own or has finished without
 * one, so the queries of a batch should be started in the same tick. A query that comes later
 * still runs; it shares only with the queries that are waiting then.
 */
export class StatementBatch<T> {
	/** Queries that joined and may still add a statement. */
	private preparing = 0
	private flushScheduled = false
	/** The statements that have not begun, by key. */
	private readonly pending = new Map<string, Statement<T>>()

	/**
	 * Joins a query. Call the returned function once the query has added its statement, or will
	 * add none soon (it failed, the cache answered, it has label lookups to run first).
	 */
	join(): () => void {
		this.preparing++
		let arrived = false

		return () => {
			if (arrived) return
			arrived = true
			if (--this.preparing === 0) this.flush()
		}
	}

	/**
	 * The result of the statement `key` for this query's `measures` and those of every other
	 * query that asks for the same key before it starts. Aborting `signal` rejects only this
	 * caller, and the statement stops (or never starts) when every caller has aborted.
	 *
	 * A statement that fails while it holds other queries' measures is run again for this query
	 * `alone`, so one measure the database refuses fails only the queries that asked for it.
	 */
	statement(
		key: string,
		request: {
			measures: readonly string[]
			/** Runs the statement for the measures collected; the first caller's is used. */
			together: (measures: string[], signal: AbortSignal) => Promise<T>
			/** Runs the statement for this query's measures only. */
			alone: () => Promise<T>
			signal: AbortSignal | undefined
		}
	): Promise<T> {
		const { measures, together, alone, signal } = request
		let statement = this.pending.get(key)
		if (!statement) {
			const controller = new AbortController()
			const collected = new Set<string>()
			let begin = () => {}
			const begun = new Promise<void>((resolve) => {
				begin = resolve
			})
			statement = {
				controller,
				waiting: 0,
				measures: collected,
				begin,
				promise: begun.then(() => together([...collected], controller.signal))
			}
			this.pending.set(key, statement)
		}
		for (const measure of measures) statement.measures.add(measure)
		const shared = statement

		// Nobody left to wait for: start with whatever else is added in this tick.
		if (this.preparing === 0 && !this.flushScheduled) {
			this.flushScheduled = true
			queueMicrotask(() => {
				this.flushScheduled = false
				if (this.preparing === 0) this.flush()
			})
		}

		const abandoned = () => {
			if (this.pending.get(key) === shared) this.pending.delete(key)
		}
		return wait(shared, signal, abandoned).catch((error: unknown) => {
			const others = shared.measures.size > new Set(measures).size
			if (signal?.aborted || !others) throw error
			return alone()
		})
	}

	private flush(): void {
		const statements = [...this.pending.values()]
		this.pending.clear()
		for (const statement of statements) statement.begin()
	}
}
