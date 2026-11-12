/**
 * Serving queries from any server framework: several queries in one request (all at once or
 * as each finishes), and engine errors as HTTP errors. Framework-neutral; an oRPC or tRPC
 * procedure wraps these in a few lines.
 */
import {
	type Analytics,
	AnalyticsError,
	type AnalyticsErrorCode,
	type AnalyticsErrorDetails,
	type QueryOptions
} from './analytics.js'
import type { AnyDataset } from './dataset.js'
import type { DatasetQuery, ResultOf } from './query.js'

/** Why one query of a batch failed. Errors other than `AnalyticsError` are not described. */
export type BatchError = {
	code: AnalyticsErrorCode | 'internal'
	message: string
}

export type BatchResult<DS extends readonly AnyDataset[], Q> = {
	results: { [K in keyof Q]?: ResultOf<DS[number], Q[K]> }
	errors: { [K in keyof Q]?: BatchError }
}

export type BatchChunk<DS extends readonly AnyDataset[], Q> = {
	[K in keyof Q & string]:
		| { key: K; result: ResultOf<DS[number], Q[K]> }
		| { key: K; error: BatchError }
}[keyof Q & string]

type Queries<DS extends readonly AnyDataset[]> = Record<
	string,
	DatasetQuery<DS[number]>
>

/**
 * Runs named queries in parallel. One query failing does not fail the others: its error is
 * under its name. Each query is authorized, cached and reported like a single `query`; those
 * that count the same rows without grouping (the same dataset, filters, period and tenant
 * scope) share one statement.
 */
export async function queryBatch<
	DS extends readonly AnyDataset[],
	Ctx,
	const Q extends Queries<DS>
>(
	analytics: Analytics<DS, Ctx>,
	queries: Q,
	ctx: Ctx,
	options?: BatchOptions
): Promise<BatchResult<DS, Q>> {
	const results: Record<string, unknown> = {}
	const errors: Record<string, BatchError> = {}

	for await (const chunk of streamBatch(analytics, queries, ctx, options)) {
		if ('error' in chunk) errors[chunk.key] = chunk.error
		else results[chunk.key] = chunk.result
	}

	return { results, errors } as BatchResult<DS, Q>
}

/** Aborting `signal` stops the batch's statements and rejects with its reason. */
export type BatchOptions = Pick<QueryOptions, 'signal'>

/**
 * Runs named queries in parallel and yields each as it finishes, for a streaming endpoint. A
 * consumer that stops reading (a closed stream) stops the statements still running.
 */
export async function* streamBatch<
	DS extends readonly AnyDataset[],
	Ctx,
	const Q extends Queries<DS>
>(
	analytics: Analytics<DS, Ctx>,
	queries: Q,
	ctx: Ctx,
	options: BatchOptions = {}
): AsyncGenerator<BatchChunk<DS, Q>, void, undefined> {
	options.signal?.throwIfAborted()
	const controller = new AbortController()
	const signal = options.signal
		? AbortSignal.any([options.signal, controller.signal])
		: controller.signal

	try {
		const batch = analytics.batch()
		const pending = new Map(
			Object.entries(queries).map(([key, query]) => {
				// `never` skips the rules for a query written in place, which cannot be shown for a
				// generic `DS`; `query` checks every query when it runs.
				const settled = analytics
					.query(query as never, ctx, { signal, batch })
					.then(
						(result) => ({ key, result }),
						(error: unknown) => ({ key, error: batchError(error) })
					)
				return [key, settled] as const
			})
		)

		while (pending.size > 0) {
			const chunk = await Promise.race(pending.values())
			signal.throwIfAborted()
			pending.delete(chunk.key)
			yield chunk as BatchChunk<DS, Q>
		}
	} finally {
		controller.abort()
	}
}

function batchError(error: unknown): BatchError {
	return error instanceof AnalyticsError
		? { code: error.code, message: error.message }
		: { code: 'internal', message: 'The query failed' }
}

export type HttpError = {
	status: 400 | 401 | 403
	/** The status name oRPC and tRPC use for it. */
	code: 'BAD_REQUEST' | 'UNAUTHORIZED' | 'FORBIDDEN'
	message: string
	/** For a bad request: the engine's code and details, so a model can fix its query. */
	data?: {
		code: AnalyticsErrorCode
		details: AnalyticsErrorDetails[AnalyticsErrorCode]
	}
}

/**
 * An engine error as an HTTP error: `forbidden` is 403, `missing_tenant` 401, the rest are
 * 400 with the code and details. Messages are safe to show; for `unknown_value` they list the
 * valid values.
 */
export function toHttpError(error: AnalyticsError): HttpError {
	if (error.code === 'forbidden') {
		return { status: 403, code: 'FORBIDDEN', message: error.message }
	}
	if (error.code === 'missing_tenant') {
		return { status: 401, code: 'UNAUTHORIZED', message: error.message }
	}
	return {
		status: 400,
		code: 'BAD_REQUEST',
		message: error.message,
		data: { code: error.code, details: error.details }
	}
}
