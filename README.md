# measurr

A small, typed semantic layer. You declare **datasets** (one fact table each) with
**measures** and **dimensions**; callers (people, charts, an LLM tool) send a small JSON
query; the engine compiles it to SQL for your database, runs it through your driver and
returns shaped, typed rows.

- No SQL text in definitions: datasets are built from typed expression builders, so a
  renamed column, `avg` over a string or `between` on an enum fails typecheck.
- Database-neutral definitions: dialects plug in through the `Dialect` interface. Postgres
  (`measurr/postgres`) and ClickHouse (`measurr/clickhouse`) ship today.
- Tenant-scoped by construction: the engine adds the tenant filter to every statement and
  refuses to run without a tenant. A caller can be scoped to one tenant or a list of them;
  platform admins can query every tenant only through an explicit `allTenants` value that no
  query input can carry. A dataset without tenants (staff work) is only for those admins.
- Access per dataset and per field: a staff-only measure lives on the same dataset as the
  measures everyone may use.
- The query schema is generated with Zod, so it doubles as an LLM tool schema
  (`z.toJSONSchema`) and as the request validator. It can be built per caller, offering only
  the datasets and fields they may use.
- No driver or ORM dependency. `zod` is a peer dependency.

## Quick start

```ts
import {
	caseWhen, createAnalytics, defineDataset, dimension, eq, exists, gte, measure, table
} from 'measurr'
import { postgresDialect } from 'measurr/postgres'

// Row types are plain TypeScript types (Prisma models work as they are).
const order = table<Order>('orders')

// A join declares its ON clause once. Any expression that reads `region` brings the join
// with it; the planner adds it only when a query uses such an expression.
const region = order.leftJoin(table<Region>('regions'), (r) =>
	eq(r.col('id'), order.col('regionId'))
)

// A many-to-many link is a standalone table plus its link condition.
const orderTag = table<OrderTag>('order_tags')
const tag = orderTag.leftJoin(table<Tag>('tags'), (t) => eq(t.col('id'), orderTag.col('tagId')))
const refund = table<Refund>('refunds')

export const orders = defineDataset({
	key: 'orders',
	label: 'Orders',
	description: 'One row per order. Test orders are excluded.',
	from: order,
	tenantColumn: order.col('tenantId'),
	scope: eq(order.col('isTest'), false),
	time: { created: { column: order.col('createdAt'), label: 'Created' } },
	measures: {
		orders: measure.count({ label: 'Orders' }),
		revenue: measure.sum(order.col('amount'), { label: 'Revenue' }),
		// Only callers `authorizeField` allows for 'staff' see or query it.
		margin: measure.sum(order.col('amount').sub(order.col('cost')), {
			label: 'Margin',
			access: 'staff'
		}),
		refunded: measure.countWhere(exists(refund, eq(refund.col('orderId'), order.col('id'))), {
			label: 'Refunded orders'
		}),
		paidShare: measure.share({ label: 'Paid', numerator: eq(order.col('status'), 'PAID') }),
		refundRate: measure.ratio('refunded', 'orders', { label: 'Refund rate' })
	},
	dimensions: {
		status: dimension.enum(order.col('status'), OrderStatus, {
			label: 'Status',
			labels: { OPEN: 'Open', PAID: 'Paid', REFUNDED: 'Refunded' }
		}),
		region: dimension.relation({
			label: 'Region', key: region.col('id'), name: region.col('name'), empty: 'No region'
		}),
		tag: dimension.manyToMany({
			label: 'Tag',
			through: {
				table: orderTag,
				on: eq(orderTag.col('orderId'), order.col('id')),
				key: tag.col('id'),
				name: tag.col('name')
			},
			note: 'An order with several tags counts once per tag.'
		}),
		size: dimension.computed({
			label: 'Size',
			expr: caseWhen([[gte(order.col('amount'), 1000), 'large']], 'small'),
			values: { large: 'Large', small: 'Small' }
		}),
		week: dimension.timeBucket('created', 'week'),
		hour: dimension.timePart('created', 'hour')
	}
})

export const analytics = createAnalytics({
	datasets: [orders],
	sources: {
		main: {
			dialect: postgresDialect({ timestamps: 'utc' }),
			// Run read-only, with a statement timeout, through any driver.
			execute: ({ text, values }) => db.unsafe(text, [...values])
		}
	},
	tenant: (ctx: Ctx) => ctx.organizationId,
	authorize: (dataset, ctx) => ctx.can(`analytics:${dataset.key}`),
	authorizeField: (dataset, key, access, ctx) => ctx.roles.includes(access),
	timezone: (ctx) => ctx.timezone,
	onQuery: (event, ctx) => metrics.record(event.dataset, event.durationMs, event.outcome)
})

const result = await analytics.query(
	{
		dataset: 'orders',
		measures: ['orders', 'paidShare'],
		groupBy: ['status'],
		filters: [{ dimension: 'tag', op: 'in', values: ['Complaint'] }],
		period: { last: { days: 30 } },
		compareToPrevious: true
	},
	ctx
)
result.rows[0]?.status.key // 'OPEN' | 'PAID' | 'REFUNDED'
result.rows[0]?.paidShare // Ratio | null
```

## Callers and tools

Three rules decide what a caller may use, and everything that offers datasets goes through
them:

- `authorize(dataset, ctx)` decides which datasets `ctx` may query (all when omitted).
- `authorizeField(dataset, key, access, ctx)` decides which marked measures and dimensions it
  may use. A field is marked with `access`, a string your app defines (`'staff'`); unmarked
  fields are open to everyone who may query the dataset. The hook is called only for marked
  fields, once per access key, and is required as soon as one field is marked
  (`createAnalytics` throws otherwise). A `ratio` also needs the access of the measures it
  divides, so a margin rate is as restricted as the margin. The hook's `access` is typed as the
  union of the keys the datasets use (`AccessKey`) and `key` as their field keys (`FieldKey`),
  so a new key such as `'finance'` fails an exhaustive `switch` in the hook until it is handled.
- A dataset without a tenant column is only for a `ctx` whose `tenant(ctx)` is `allTenants`
  (see below).

With them:

- `analytics.listDatasets(ctx)` resolves to the catalog entries (measures, dimensions, closed
  values) of the datasets `ctx` may query, without the fields it may not use. A dataset with
  no measure left for `ctx` is left out.
- `analytics.querySchema({ ctx })` resolves to the input schema for the same datasets and
  fields, for a tool built per caller, so a model is never offered what it may not use. It
  rejects with `AnalyticsError('forbidden')` when nothing is allowed.
  `analytics.querySchema({ datasets })` is the synchronous form for a list you already have
  (typed for those datasets only), and `querySchema()` covers every dataset and field. Schemas
  are built once per set of datasets and fields, so `querySchema({ ctx })` returns the same
  object as `querySchema({ datasets })` when `ctx` may use every field of the allowed set:
  cache a tool built from it by the keys of what it offers.
- `analytics.query` checks all three again on every call, so a schema offered too widely still
  cannot leak a dataset or a field. Naming a field `ctx` may not use (as a measure, in
  `groupBy` or `sort`, or in a filter) fails with `AnalyticsError('forbidden')`, which names
  the field.

`AnalyticsResultSchema` is any dataset's result without its keys: rows of `{ key, label }`
per grouped dimension and a number or null per measure, with totals, `previous?`, `notes`,
`truncated` and `fields`. `analytics.resultSchema(key)` is the same envelope with the dataset's fields, so a
result that passes one passes the other. Use it for a tool's output contract.

`analyticsToolGuidance` is a few markdown bullets for a model's instructions: use the tool for
every how-many, how-much, per-period or split-by question and never count from lists; state the
period and filters; compare with the previous period when the change is the point; say when
grouped rows overlap; ask only when the period is genuinely ambiguous. It does not name the
tool, so add a line that does:

```ts
const instructions = `# Numbers
The analytics tool is analytics_query.
${analyticsToolGuidance}`
```

`onQuery(event, ctx)` hears every `query` once it succeeds or fails:
`{ dataset, metric?, durationMs, rows, outcome: 'success' | 'error', cache?, error? }`. `dataset`
is null when the input named no known dataset, so free text from a model never becomes a metric
label. `metric` is the metric the registry ran the query for.
`cache` is `'hit'` or `'miss'` when a cache is configured. What the hook throws or rejects with is
swallowed; it cannot fail a query.

Each measure in `listDatasets` has a `valueType`: `count` (a whole number, never null),
`ratio` (0-1, from `share` and `ratio`) or `number` (sums, averages, medians), so a UI knows
to format a share as a percentage. A resolved measure has the `result` it declares.

## Query options

```ts
const result = await analytics.query(
	{ dataset: 'orders', measures: ['orders'], groupBy: ['day', 'status'], limit: 400, totals: false },
	ctx,
	{ signal: request.signal }
)
result.fields
// { groupBy: [{ key: 'day', label: 'Day', kind: 'timeBucket', unit: 'day' },
//             { key: 'status', label: 'Status', kind: 'enum', values: [{ key: 'OPEN', label: 'Open' }, ...] }],
//   measures: [{ key: 'orders', label: 'Orders', valueType: 'count' }] }
```

- `fields` describes every result: its grouped dimensions (kind, a time bucket's `unit`, a
  closed dimension's `values`) and its measures (label, `valueType`), so a chart drawn from a
  model's tool output needs no guessing.
- `totals: false` skips a grouped query's totals statement, and the result has no `totals`
  (its type says so). The presenters do not need them. It is for app code: `querySchema` does
  not offer it to a model, which would then add up overlapping rows.
- `createAnalytics({ maxLimit })` raises the highest `limit` `query` accepts, for app code such
  as a long time series. The schema `querySchema` builds keeps 100.
- `createAnalytics({ concurrency })` caps how many statements run at once on each source, so a
  large dashboard cannot take every pooled connection.
- `signal` aborts a query: it rejects with the signal's reason, statements waiting for a slot
  never start, and `execute` gets `{ signal }` as its second argument to cancel a running one.
- `analytics.period(input, ctx)` resolves a period the way `query` does (its local days, start
  and end instants and length, or null for all time), and `analytics.scope(ctx)` returns the
  tenant scope `query` would use, refusing a missing one. Use them when code reads the same rows
  another way (Prisma, another database).


## Caching

`cache: { get, set }` keeps finished results in a store of your choice, such as Redis. A query
is parsed and authorized first, so a cached result never reaches a caller who may not run the
query. The key is `measurr:<dataset>:<sha256>`, hashed from the query with its defaults, the
tenant scope, the timezone and the resolved days (so `last 30 days` moves on at local midnight).
Results are plain JSON.

```ts
const TTL_SECONDS: Record<AnalyticsDatasetKey, number> = { orders: 300, units: 60 }

createAnalytics({
	// ...
	cache: {
		// A miss bypasses the cache; the fresh result is still stored.
		get: async (key, { ctx }) =>
			ctx.refresh ? null : JSON.parse((await redis.get(`${BUILD_ID}:${key}`)) ?? 'null'),
		set: (key, result, { dataset }) =>
			redis.setex(`${BUILD_ID}:${key}`, TTL_SECONDS[dataset], JSON.stringify(result))
	}
})
```

A stored value that is not a result of its dataset counts as a miss, and a cache that throws or
rejects is a miss or a skipped write, never a failed query. The key also hashes the dataset's
definition (its compiled SQL, labels and values), so a deploy that changes a measure misses the
cache. Resolver code is not part of it: prefix keys with a build id (as above) if a changed
resolver's old numbers must not outlive a deploy. A dataset that uses `minutesAgo` is as stale as
the time to live.

With a cache, identical queries that run at the same time (two metrics of one dashboard, two
people opening it) share one run. The entry names the `metric` a registry ran the query for, so
`set` can pick a time to live per metric. The key holds the tenant scope and nothing else from
`ctx`, so a cached or shared result must not depend on anything else in it: a resolver that
reads the user from `ctx` belongs in an uncached instance.

## Chart shapes

`measurr/shapes` turns a result into what a chart or a KPI card draws. The functions are pure
and add no numbers the result does not hold; with `compareToPrevious` they carry the previous
period too.

```ts
import { toDistribution, toKpi, toPivot, toTimeseries, toLeaderboard } from 'measurr/shapes'

toKpi(result, 'orders')
// { kind: 'kpi', value: 12, previous: 8, change: 0.5 }

toTimeseries(result, { bucket: 'day', unit: 'day', measure: 'orders', series: 'status' })
// { kind: 'timeseries', unit, series: [{ key, label, points: [{ bucket: '2026-10-01', value }], previous? }] }

toDistribution(result, { by: 'status', measure: 'orders' }) // segments with share of the total
toPivot(result, { rows: 'weekday', columns: 'hour', measure: 'orders' }) // values[row][column]
toLeaderboard(result, { by: 'region', measure: 'revenue' }) // ranked rows with every measure
```

- `toTimeseries` gives every bucket of the period a point; buckets without rows get `fill` (0 by
  default, pass `null` for averages). An ungrouped series exists even for a period without rows.
  An all-time result has only the buckets it found. The previous period's points are on its own
  buckets; compare them by position.
- `seriesKeys` (and `segmentKeys` for distributions) lists keys to draw even when no row has
  them, a zero lane per channel, first and in that order. `'all'` takes a closed dimension's
  values from the result's `fields`.
- A grouped query returns at most `limit` rows (20 by default, 100 at most, or `maxLimit`), and
  the shape keeps `truncated`. Set a `limit` that covers every bucket and series: 30 days split
  into three series fit in 100, 90 days into eleven do not.
- `toDistribution`'s `total` is the measure over every row, so many-to-many shares can add up to
  more than 1; it is null for a result without totals. `toPivot` sorts numeric keys (weekdays,
  hours).

### Presentation

`presentKpi`, `presentTimeseries`, `presentDistribution`, `presentLeaderboard`, `presentPivot`
and `presentTable` turn a result into the wire outputs a dashboard draws (`KpiOutput`,
`TimeSeriesOutput`, `DistributionOutput`, `LeaderboardOutput`, `PivotOutput`, `TableOutput`). A
missing value is 0, keys are strings, and the caller picks labels, units and chart types. An
output whose query was cut at its `limit` has `truncated: true`:

```ts
presentKpi(result, 'paidShare', { label: 'Paid', percent: true })
// { kind: 'kpi', value: 25, unit: 'PERCENTAGE', label: 'Paid' }

presentTimeseries(result, {
	bucket: 'day', measure: 'orders', series: 'status',
	seriesKeys: 'all', // a lane for every status, rows or not
	keys: { PAID: 'paid' }, // wire keys, by String(key); 'null' names the empty group
	labels: { paid: 'Settled' }, // labels by wire key
	chartType: 'line'
})
// points are { ts: Date, bucket: '2026-10-01', value }: ts is the bucket's local start date as
// UTC midnight, so format `bucket`, not `ts` in the viewer's timezone

presentDistribution(result, { by: 'tag', measure: 'orders', chartType: 'donut', order: ['t2'] })
// total is what the segments add up to, percent is 0-100; keys order omits go last

presentLeaderboard(result, { by: 'region', measure: 'orders', meta: (values) => ({ revenue: values.revenue }) })

presentPivot(result, { rows: 'weekday', columns: 'hour', measure: 'orders', totals: true })
// rows and columns by label; totals are sums of the cells, so leave them off for an average

presentTable(result, { columns: ['region', 'orders'], labels: { orders: 'Count' } })
// a column per grouped dimension (its label; a bucket's date) and per measure, from `fields`
```

`isKpi`, `isTimeSeries`, `isDistribution`, `isTable`, `isLeaderboard` and `isPivot` narrow a
`MetricOutput`. `OUTPUT_KINDS` lists every kind, and `pickRenderer(map, output, fallback)` picks
a renderer from a map that must name every kind (a new kind fails typecheck) and falls back for a
kind the client does not know yet. The module is pure, so a browser bundle can import the types
and guards.

## Dashboard metrics

`measurr/metrics` names the numbers a dashboard shows: one query and the output it is drawn
in, or a `resolve` function for a number a dataset cannot give. The registry runs a batch for a
caller and streams one chunk per metric.

```ts
import { createMetricRegistry, metricDefiner } from 'measurr/metrics'
import { presentKpi, presentTimeseries } from 'measurr/shapes'

// Types only, so metric modules need not import the analytics instance.
export const defineMetric = metricDefiner<(typeof datasets)[number], Role, {}, Ctx>()

const orderTrend = defineMetric({
	key: 'orders.trend',
	kind: 'timeseries',
	description: 'Orders over time',
	allowedRoles: ['owner', 'member'],
	supportsTimeRange: true, // false for a snapshot: all time, no previous period
	filterSchema: z.object({ status: z.enum(['OPEN', 'PAID']).optional() }), // optional
	query: ({ bucket, filters }) => ({
		dataset: 'orders',
		measures: ['orders'],
		groupBy: [bucket],
		filters: filters.status ? [{ dimension: 'status', op: 'in', values: [filters.status] }] : [],
		limit: 100,
		totals: false // no presenter reads them; saves a statement per period
	}),
	shape: (result, { bucket }) =>
		presentTimeseries(result, { bucket, measure: 'orders', chartType: 'bar' })
})

const myOpenItems = defineMetric({
	key: 'workItems.mine',
	kind: 'kpi',
	description: 'Open items assigned to me',
	supportsTimeRange: false,
	// `ctx` is the caller; the tenant scope applies anyway.
	query: ({ ctx }) => ({
		dataset: 'workItems',
		measures: ['items'],
		filters: [{ dimension: 'assignee', op: 'in', values: [ctx.userId] }]
	}),
	shape: (result) => presentKpi(result, 'items')
})

// Prisma, another database: the registry still decides the period, the previous period and
// the tenant scope. Filter every read by `tenant`.
const seatsUsed = defineMetric({
	key: 'billing.seats',
	kind: 'kpi',
	description: 'Seats in use',
	supportsTimeRange: true,
	resolve: async ({ period, tenant, signal }) => ({
		kind: 'kpi',
		value: await countSeats({ organizationIds: tenant, from: period?.start, to: period?.end, signal })
	})
})

export const metrics = createMetricRegistry({
	analytics,
	metrics: [orderTrend, myOpenItems, seatsUsed] as const,
	canRun: (metric, ctx) => (metric.allowedRoles ?? ALL_ROLES).includes(ctx.role),
	onError: (error, { key, code }) => logger.error('metric.failed', { key, code, error })
})

const input = metrics.requestSchema.extend({ refresh: z.boolean().default(false) }).parse(body)
for await (const chunk of metrics.run(input, ctx, { signal: request.signal })) send(chunk)
// { key, requestKey, result: { current, previous?, supportsTimeRange, period }, done }
// or { key, requestKey, error, code, done }

const { results, errors } = await metrics.collect(input, ctx) // by request key, typed per key
const seats = await metrics.one('billing.seats', { period: { last: { days: 7 } } }, ctx)
```

- A request names its period like a query, `period: { last: { days: 7 } }` or any other
  `PeriodInput`, counted in `analytics.timezone(ctx)`, so a client that does not know the
  tenant's timezone can still ask for "the last 7 days". Or it sends `from` and `to` as
  instants, counted as the local days they fall on; `from` alone counts up to today. `to`
  without `from`, or `period` with either, rejects with `invalid_period`. Without any, a metric
  counts all time; a snapshot always does.
- Every result carries the `period` it counted: `{ from, to, timezone }` or `{ all: true,
  timezone }`, so a chart can mark today without a second request.
- `query` returns the query without `period` or `compareToPrevious`. `compareToPrevious` adds
  the previous period, whose series points are put on the current buckets so a chart overlays
  them. With week or month buckets the two periods can differ by a bucket: points pair from the
  end, and a previous point before the current period's first bucket is dropped.
- `granularity` (hour to year, inferred from the period's days when omitted: day up to 31
  days, week up to 90, else month) picks `run.bucket`: `day`, `week` or `month`; `hour` draws
  days and `quarter` and `year` draw months, and the output's `granularity` says which. Name
  time-bucket dimensions after them so `groupBy: [bucket]` works.
- `query` and `shape` get `run.ctx`, and `metricDefiner`'s fourth parameter types it. A filter
  on the caller's own id is part of the query, so the cache key already separates users.
- A `resolve` metric gets the filters, bucket and granularity, the `period` (local days with
  `start` and `end` instants, or null for all time), the `tenant` from `analytics.scope(ctx)`
  (`allTenants` included), `ctx` and a `signal`. It is called once for the period and, with
  `compareToPrevious`, once for the previous one. Nothing scopes its reads but the code: filter
  every read by `tenant`.
- A metric fails alone, with a `code` next to its message: `unknown_metric`, `forbidden`
  (`canRun` refused it), `invalid_filters`, `truncated`, `shape_failed`, `internal` (a driver
  error or a throwing `resolve`; the message does not say what), or the engine's codes such as
  `missing_tenant`. `onError(error, { key, requestKey, code, metric }, ctx)` hears every
  failure with what was thrown; `onShapeError` still works and is deprecated.
- A time series whose query was cut at its `limit` fails with `truncated` instead of drawing
  zeros for the newest buckets. Raise its `limit` (and `maxLimit`) or ask for a shorter period.
- `filterSchema` is optional; without it a metric takes no filters.
- `metricDefiner<Datasets, Role, Extra, Ctx>()` takes the app's own definition fields as
  `Extra` (catalog metadata, UI hints for filters); the registry carries them to `canRun` and
  `available` without reading them.
- Keys and outputs stay literal: a chunk narrows to its metric by `key`, `collect`'s results and
  `one` are typed per key, and `MetricOutputOf<typeof metrics, 'orders.trend'>`,
  `MetricFiltersOf`, `MetricKeysOfKind` and `registry.get(key)` are typed per metric.
  `registry.available(ctx)` lists what `canRun` allows, for a catalog.
- A consumer that stops reading `run` (a closed stream) aborts the statements still running;
  `signal` does the same from outside.
- `metricOutputSchemas` (one per kind), `MetricOutputSchema` and `MetricResultSchema` are Zod
  schemas for an endpoint's output contract or a cached output; `ts` is coerced, so JSON parses
  back.

**Access belongs to `ctx`.** `canRun` decides which metrics a caller may run, and `tenant(ctx)`
decides what any of them can count. Keep both in one discriminated context and never add a
bypass flag:

```ts
type Ctx =
	| { kind: 'member'; organizationId: OrganizationId; role: Role }
	| { kind: 'staff'; organizationIds: readonly OrganizationId[] | typeof allTenants; role: 'staff' }

canRun: (metric, ctx) => (metric.allowedRoles ?? ALL_ROLES).includes(ctx.role),
tenant: (ctx) => (ctx.kind === 'member' ? ctx.organizationId : ctx.organizationIds)
```

A job that reports for one organization (a monthly PDF, an email) is a caller too: build a
`ctx` scoped to that organization, the same one a member of it would get, rather than a staff
context with every tenant. A metric that forgets a scope then counts too little, never another
customer's rows.

## Serving queries

`measurr/handler` serves queries from any server framework:

- `queryBatch(analytics, { total: q1, byStatus: q2 }, ctx)` runs named queries in parallel and
  resolves to `{ results, errors }`, typed per name. One failing query does not fail the
  others; an error other than `AnalyticsError` is reported as `{ code: 'internal' }` without
  its message.
- `streamBatch(analytics, queries, ctx)` yields `{ key, result }` or `{ key, error }` as each
  query finishes, for a streaming endpoint. A consumer that stops reading aborts the statements
  still running.
- Both take `{ signal }` as a fourth argument; aborting it rejects with the signal's reason.
- `toHttpError(error)` maps an `AnalyticsError` to `{ status, code, message, data? }`:
  `forbidden` is 403 `FORBIDDEN`, `missing_tenant` 401 `UNAUTHORIZED`, the rest 400
  `BAD_REQUEST` with the code and details. The codes are the names oRPC and tRPC use:

```ts
try {
	return await analytics.query(input, ctx)
} catch (error) {
	if (!(error instanceof AnalyticsError)) throw error
	const { code, message, data } = toHttpError(error)
	throw new ORPCError(code, { message, data })
}
```

## Resolved measures

Some numbers one statement cannot give: sprays per employee when the employees live in another
database, an average per day of the period, a forecast. Declare such a measure with
`measure.resolved` and give the code to `createAnalytics`. It stays a measure like any other:
it is in the catalog and the schema, checked for access, scoped to the tenant and cached.

```ts
const sprays = defineDataset({
	// ...
	measures: {
		sprays: measure.sum(status.col('sprays'), { label: 'Sprays' }),
		spraysPerDay: measure.resolved({ label: 'Sprays per day', result: 'number', uses: ['sprays'] })
	}
})

createAnalytics({
	// ...
	resolvers: {
		sprays: {
			spraysPerDay: ({ rows, totals, period }) => {
				const days = 'all' in period ? null : daysBetween(period.from, period.to)
				const perDay = (value: number | null) =>
					value === null || days === null ? null : value / days
				return { rows: rows.map(({ values }) => perDay(values.sprays)), totals: perDay(totals.sprays) }
			}
		}
	}
})
```

- `uses` names the measures of the same dataset the resolver reads. The database computes them
  for every row and for the totals, even when the query does not ask for them, and the result
  holds only what it asked for. A measure with no `uses` still gets one value per group.
- The resolver gets the rows in order (`dimensions` for the grouped keys, `values` for the used
  measures), the `totals`, `groupBy`, the `filters` (open-dimension labels resolved to keys),
  the `period`, the `tenant` scope and `ctx`. It returns one value per row and one for the
  totals. With `compareToPrevious` it is called once per period.
- `createAnalytics` throws when a resolved measure has no resolver, and when `resolvers` names
  anything else. A wrong number of values fails the query; a value that is not a finite number
  is null, and a `count` result is 0 instead.
- A resolved measure needs the access of the measures it uses, like a ratio. It cannot be sorted
  by (the database limits the rows before the value exists), and `ratio` and `uses` cannot name
  one.
- The contract kit leaves resolved measures out: they are app code, so test them with it.

## Tenants and platform admins

`tenant(ctx)` decides the scope of every statement, including the lookups that resolve filter
labels. It returns a tenant id (`TenantId`, a non-empty string or a finite number), a readonly
list of them, or `allTenants` to drop the tenant filter for a caller allowed to see every
tenant. Anything else is refused with `AnalyticsError('missing_tenant')`: null, undefined,
`''`, a list containing one of those or `allTenants`, or any other value. A missing
organization never widens a query.

A list compiles to `tenantColumn IN (...)` with one parameter per id; a one-element list is
the same statement as its id. An empty list is a scope that matches no rows: a reseller with
no connected organizations sees zeros, never everything. Lists are for callers scoped to a set
of organizations, such as an organization-group admin, a reseller, or either narrowed to a
region:

```ts
tenant: (ctx: Ctx) => ctx.visibleOrganizationIds // readonly OrganizationId[]
```

The scope comes only from `ctx`, which your server builds from the session. `allTenants` is a
symbol, so a query (JSON, a model's tool call) cannot carry it. A discriminated context keeps
the rule in one typed place:

```ts
import { allTenants } from 'measurr'

type Ctx =
	// A super admin may narrow to one organization, or see all of them.
	| { role: 'superAdmin'; organizationId?: OrganizationId }
	// Everyone else is always scoped to the organization they are signed in to.
	| { role: 'member'; organizationId: OrganizationId }

const analytics = createAnalytics({
	// ...
	tenant: (ctx: Ctx) =>
		ctx.role === 'superAdmin' ? (ctx.organizationId ?? allTenants) : ctx.organizationId
})
```

Resolve a super admin's optional organization id on the server (from the request, after
checking the session) before building `ctx`; never read it from the query input. Unscoped
lookups resolve labels across tenants, so `"Complaint"` matches every tenant's tag of that
name.

**Datasets without tenants.** Some tables belong to no organization, such as maintenance
cases staff work on. Declare them with `tenantColumn: null`. The key stays required, so a
forgotten tenant column still fails typecheck.

```ts
export const maintenance = defineDataset({
	key: 'maintenance',
	label: 'Maintenance',
	description: 'One row per maintenance case.',
	from: maintenanceCase,
	tenantColumn: null,
	// ...
})
```

Only a `ctx` whose `tenant(ctx)` is `allTenants` may query such a dataset, label lookups
included. An id or a list of ids, even an empty one, fails with `AnalyticsError('forbidden')`
before any statement runs; a narrower scope is never ignored. `listDatasets(ctx)` and
`querySchema({ ctx })` leave the dataset out for those callers.

## The model

| Concept | What it is |
| --- | --- |
| Dataset | One fact table: tenant column (or `null`), optional scope, time fields, default period, measures, dimensions, source. |
| Measure | `count`, `countWhere`, `countDistinct`, `sum`, `avg`, `median`, `share` (one condition over another), `ratio` (one measure over another, after aggregation) or `resolved` (computed by the app after the query runs). Optionally restricted with `access`. |
| Dimension | `enum`, `computed` (closed value sets), `relation` (to-one), `manyToMany`, `number`, `timeBucket` (day, ISO week, month), `timePart` (ISO weekday, hour). Optionally restricted with `access`. |
| Query | `dataset`, 1-4 `measures`, 0-2 `groupBy`, `filters`, `period`, `time`, `compareToPrevious`, `sort` (by an asked measure or grouped dimension), `limit` (1-100 or `maxLimit`, default 20), and for app code `totals`. |
| Result | `{ period, rows, totals, previous?, notes, truncated, fields }`; `period` is `{ from, to, timezone }` or `{ all: true, timezone }`. `previous` is typed as present when the query says `compareToPrevious: true`. |

**Operators per dimension kind.** Closed and open dimensions take `in`, `notIn`, `isEmpty`
and `isNotEmpty`; numeric and time dimensions take `between`, `isEmpty` and `isNotEmpty`. The
query types and the generated schema both enforce this. `notIn` keeps rows without a value,
unlike SQL's `NOT IN`.

**Open values are keys or labels.** Filters on `relation` and `manyToMany` dimensions accept
keys or names (case-insensitive); the engine resolves them before planning. An unknown value
fails with `AnalyticsError('unknown_value')` listing the valid values, so a model can retry
once.

The lookup reads the fact table of the tenant by default, every row it ever had. Give the
dimension a `lookup` to read the names from their own table instead; the key and the name must
be columns of it, and `tenantColumn` scopes it (null for a table every tenant shares). The
valid values are then every entry of that table, not only those with rows.

```ts
team: dimension.relation({
	label: 'Team', key: team.col('id'), name: team.col('name'),
	lookup: { tenantColumn: team.col('organizationId') }
})
```

**Errors carry typed details.** `isAnalyticsError(error, code?)` narrows by code:
`unknown_value` details are `{ dimension, unknown, valid }` and `invalid_query` details are the
schema's issues; the other codes have none.

```ts
try {
	return await analytics.query(input, ctx)
} catch (error) {
	if (isAnalyticsError(error, 'unknown_value')) return { retryWith: error.details.valid }
	throw error
}
```

**Periods** are whole local days in the tenant's timezone (`timezone` hook, UTC by default):
`{ last: { days } }`, `{ from, to }` (inclusive ISO dates) or `{ preset }` (`today`,
`yesterday`, `thisWeek`, `lastWeek`, `thisMonth`, `lastMonth`, `thisYear`). At most two years.
The previous period has the same length and ends the day before. Time buckets use the same
timezone. `time` picks the time field the period applies to; a time dimension names its own.

`{ all: true }` drops the time filter: every row counts, and time buckets and parts still group
by the time field. It has no previous period, so `compareToPrevious` with it is an
`invalid_query`. The result's `period` is then `{ all: true, timezone }` instead of
`{ from, to, timezone }`; `previous.period` is always a range. The type follows the query. A
query that names a range, or names no period on a dataset whose default is a range, gets
`{ from, to, timezone }`, so `result.period.from` needs no narrowing. A query typed only as
`AnalyticsQuery` (parsed from the schema) gets the `ResultPeriod` union; narrow it with
`'all' in result.period`.

A query that names no period (or sends null) gets the dataset's `defaultPeriod`, the last 30
days unless the dataset says otherwise. A dataset that describes current state (units,
organizations) sets `defaultPeriod: { all: true }`, so "how many units per status" counts
every unit. The generated schema states each dataset's default, so a model knows what leaving
`period` out means.

**Totals are a separate, ungrouped statement**, so a many-to-many grouping (an order with
two tags appears in two rows) never inflates them. Filters on many-to-many dimensions compile
to `EXISTS`, so they never multiply rows either. A grouped query is therefore two statements
per period, four with `compareToPrevious`, plus one per open-dimension label lookup; `totals:
false` drops the totals statements.

**Daily rollups cannot see part of a day.** A dataset over a table with one row per day (usage
per unit per day) counts whole local days. It cannot start a unit at the hour it joined or end a
period mid-day, so a total read from raw events with exact instants can differ on a unit's first
day and at the edges of the period. Filter such rows by day (`day >= joinedDay`) and say so in
the dataset's description, or compute the exact number in a `resolve` metric.

**Result types are honest.** `count` measures are `number`; `sum`, `avg` and `median` are
`number | null`; `share` and `ratio` are a branded `Ratio | null` (0-1). A row has a field only
for the dimensions it was grouped by. Relation, many-to-many, number and time keys may be
null (no related row, no value). Enum and computed keys are null only when their expression
can be: a nullable enum column, or a `caseWhen` without `otherwise`. Name that group with
`empty` (default "None"), or `coalesce` the column to a value.

## Types that do the work

- `table<Row>(name).col(key)` only accepts keys of `Row` whose type maps to SQL
  (`number`/`bigint`/Decimal → number, `string` → string, `boolean`, `Date` → timestamp). JSON
  and relation fields are excluded.
- Operands must match: `eq(numberColumn, 'x')` fails. A column keeps its value type, so
  `eq(order.col('status'), 'PAD')` and `inList(order.col('status'), ['CLOSED'])` fail on an
  enum column (`toText` compares with anything). `.add/.sub/.mul/.div` exist only on number
  expressions; `div` is always floating-point and null when dividing by zero.
- `measure.avg/sum/median` take numbers, `measure.share` takes booleans, time fields take
  timestamps.
- Expressions know whether they can be null. A nullable or optional field gives a nullable
  column; `caseWhen` without `otherwise` is nullable; `coalesce` with a plain fallback is not.
  Plain operands are never null, so `eq(column, null)` fails: use `isNull`.
- `dimension.enum` needs a label for every enum value, and fails when the column can hold a
  value the enum does not list.
- `dimension.computed` fails when `values` misses a value its `caseWhen` can produce.
- `dimension.relation` takes its key type from the key column, so a branded id column types
  the key in filters and rows; `relation<number>` over a string column fails.
- `groupOnly` dimensions cannot be named in `filters`, and `filterOnly` ones cannot be named
  in `groupBy` or `sort`.
- `measure.ratio('a', 'b')` must name measures of the same dataset; time dimensions must name
  declared time fields.
- `AnalyticsQuery<typeof analytics>` is the query union; `analytics.query` returns rows typed
  by the query's `measures` and `groupBy`.

What the types cannot see, `defineDataset` checks when the module loads: every column is
reachable from the dataset's table (joins, `exists` subqueries, the many-to-many link), ratio
measures have no cycles, and a computed dimension's `values` cover every value its expression
can produce (repeating the type check for expressions typed only as `string`). `createAnalytics` then checks every dataset's source exists and compiles every
measure, grouping and filter once, so a definition the dialect cannot render fails at startup.

## Sources and dialects

A source is `{ dialect, execute }`. `execute` receives `{ text, values }` (positional values
for the `$n` placeholders) and returns rows as plain objects. Read-only transactions, statement timeouts and row
caps belong in `execute`. A dataset names its source with `source`; with one source it is the
default.

Rows can come back as the driver returns them. The dialect's `decodeNumber` accepts numbers,
numeric strings, bigints and decimal objects with a `toNumber()` method (Prisma's `Decimal`,
decimal.js); anything else is null. Relation keys that are numbers decode the same way.

For example, Prisma in a read-only transaction that Postgres stops after five seconds:

```ts
const STATEMENT_TIMEOUT_MS = 5_000

const main: AnalyticsSource = {
	dialect: postgresDialect({ timestamps: 'utc' }),
	execute: ({ text, values }) =>
		prisma.$transaction(
			async (tx) => {
				await tx.$executeRawUnsafe('SET TRANSACTION READ ONLY')
				await tx.$executeRawUnsafe(`SET LOCAL statement_timeout = ${STATEMENT_TIMEOUT_MS}`)
				return tx.$queryRawUnsafe<Record<string, unknown>[]>(text, ...values)
			},
			{ timeout: STATEMENT_TIMEOUT_MS + 1_000 }
		)
}
```

Each statement there is an interactive transaction: five round trips (begin, two `SET`s, the
query, commit). One round trip does the same when the connection itself is read-only with a
timeout, for example a role made for analytics:

```sql
CREATE ROLE analytics_reader LOGIN PASSWORD '...';
GRANT SELECT ON ALL TABLES IN SCHEMA public TO analytics_reader;
ALTER ROLE analytics_reader SET default_transaction_read_only = on;
ALTER ROLE analytics_reader SET statement_timeout = '5s';
```

```ts
const analyticsDb = new PrismaClient({ datasourceUrl: process.env.ANALYTICS_DATABASE_URL })
const main: AnalyticsSource = {
	dialect: postgresDialect({ timestamps: 'utc' }),
	execute: ({ text, values }) => analyticsDb.$queryRawUnsafe(text, ...values)
}
```

`concurrency` on `createAnalytics` keeps a dashboard from taking every connection of the pool.

**`measurr/clickhouse`** `clickhouseDialect()`: typed `{pN:Type}` parameters, backquoted
identifiers, `-If` and `-OrNull` aggregates (an empty group is null, as in Postgres), an exact
interpolated median, `uniqExact` for distinct counts, and buckets with `toTimeZone`. Every
statement ends with `SETTINGS join_use_nulls = 1, enable_positional_arguments = 1`, so a left
join without a match gives null (an empty group) instead of an empty string. Pass the values
with `toQueryParams`:

```ts
import { clickhouseDialect, toQueryParams } from 'measurr/clickhouse'

const events: AnalyticsSource = {
	dialect: clickhouseDialect(),
	execute: async (statement) => {
		const result = await clickhouse.query({
			query: statement.text,
			query_params: toQueryParams(statement),
			format: 'JSONEachRow'
		})
		return result.json()
	}
}
```

ClickHouse cannot run correlated subqueries, so a dataset on it cannot use `exists` or filter
by a many-to-many dimension (mark it `groupOnly`); `createAnalytics` fails at startup if it
does. Time columns are `DateTime` or `DateTime64`, which hold instants. Tested against
ClickHouse 24.

**`measurr/postgres`** `postgresDialect({ timestamps })`: `$n` parameters (untyped,
so Postgres infers them from the column, which keeps enum columns working), double-quoted
identifiers, `FILTER (WHERE ...)`, `count(DISTINCT ...)`, `percentile_cont`, correlated
`EXISTS`, buckets with `AT TIME ZONE`, GROUP BY by position. Set `timestamps: 'utc'` for
`timestamp without time zone` columns that hold UTC (Prisma's `DateTime`); the default
`'timestamptz'` is for `timestamp with time zone`.

## Testing your datasets

`measurr/testing` runs the same checks for every dataset against a seeded database:

```ts
import { assertDatasetContract } from 'measurr/testing'

await assertDatasetContract({ dataset: orders, source, tenant: seededTenantId })
```

It checks that every measure runs and returns a number or null, every grouping runs and its
groups add up to the total (except many-to-many), `isEmpty` plus `isNotEmpty` equals the total,
open dimensions filter by label to their group's count, closed dimensions filter by value, an
empty tenant and an empty tenant list see nothing (tenant isolation), and day buckets in a
far-from-UTC timezone (default `Pacific/Auckland`) agree with single-day periods. Fields marked
with `access` are checked like any other.

A dataset without a tenant column has no tenant rows to isolate. Pass `tenant: allTenants`,
and the kit replaces the isolation checks with one that an empty tenant and an empty tenant
list are refused with `forbidden`. Every other check runs as usual.

```ts
await assertDatasetContract({ dataset: maintenance, source, tenant: allTenants })
```

`assertMetricContract({ registry, ctx })` runs every metric of a registry once over the last 30
days (or `period`), comparing with the previous period, and fails when one errors, draws
another kind than it declares, or a metric over a time range has no previous period. Give it a
`ctx` that `canRun` allows everything for, scoped to a seeded tenant.

```ts
import { assertMetricContract } from 'measurr/testing'

await assertMetricContract({ registry: metrics, ctx: seededOwner })
```

## Extending

- **A measure or dimension** is one entry in a dataset. Dimensions are groupable and
  filterable unless `groupOnly` or `filterOnly` says otherwise, and every field is open to
  everyone who may query the dataset unless `access` restricts it. The contract kit covers it
  without a new test.
- **A dataset** is one `defineDataset` call added to `createAnalytics({ datasets })`.
- **A computed value** is written with the expression builders (`caseWhen`, `exists`,
  `coalesce`, `toText`, `minutesAgo`, comparisons, `and`/`or`/`not`), never SQL. When a
  definition needs something they cannot say, add a builder and render it in every dialect.
- **A dialect** implements `Dialect` (`name`, `compile`, `decodeNumber`). Most dialects only
  provide a `SqlRenderer` (quoting, parameters, aggregates, division, time buckets and parts)
  and call `renderStatement`. It is done when the snapshot tests and the
  contract kit pass on it.

## Stable API

Kept stable for publishing: `createAnalytics` and its options (with `authorize`,
`authorizeField` and `cache`), `allTenants`, `analytics.query`, `explain`, `querySchema`,
`resultSchema`, `listDatasets`; `AnalyticsResultSchema`, `analyticsToolGuidance`,
`AnalyticsQueryEvent`; `defineDataset` (with `defaultPeriod` and `tenantColumn: null`),
`measure.*` and `dimension.*` (with `access`), `table` / `Table`, the expression builders; the
`Dialect`, `SqlRenderer` and `AnalyticsSource` contracts; `measure.resolved` with the
`resolvers` option (`MeasureResolver`, `ResolverInput`, `ResolverOutput`); `postgresDialect`,
`clickhouseDialect` and `toQueryParams`,
`checkDatasetContract` / `assertDatasetContract`, `analytics.period` and `analytics.scope`,
the query options (`totals`, `signal`) and the `maxLimit` and `concurrency` options, result
`fields`, dimension `lookup`; `measurr/shapes` (`toKpi`, `toTimeseries`,
`toDistribution`, `toPivot`, `toLeaderboard`) and `measurr/handler` (`queryBatch`,
`streamBatch`, `toHttpError`); and the types `AnalyticsQuery`, `AnalyticsResult`,
`ResultPeriod`, `PeriodInput`, `Tenant`, `TenantId`, `AccessKey`, `AnalyticsCache`, `FieldKey`,
`Ratio`, `AnalyticsError` codes and their details (`isAnalyticsError`). `ExprNode` and
`SelectStatement` are exported for dialect authors and may grow new node kinds. The
presenters and wire outputs in `measurr/shapes`, `measurr/metrics` (with `resolve` metrics and
the output schemas), `checkMetricContract` / `assertMetricContract` and `analytics.timezone`
are new and may still change before they join this list.

## Install

```sh
npm install measurr zod
```

`zod` 4 is a peer dependency. The types need TypeScript 5.9 or newer.

## Development

```sh
bun install
bun run lint   # types and Biome
bun test
# With a throwaway Postgres and ClickHouse (the integration tests create and drop their own tables):
ANALYTICS_TEST_DATABASE_URL=postgres://... ANALYTICS_TEST_CLICKHOUSE_URL=http://user:password@localhost:8123 bun test
bun run build && bun run verify:package
```

The integration test reads `ANALYTICS_TEST_DATABASE_URL`, not `DATABASE_URL`, because Bun
loads `.env` files and that name may point at a real database. CI runs them against Postgres 17
and ClickHouse 24.

Releases are automated with Release Please; see [docs/releasing.md](docs/releasing.md).

## License

MIT
