# measurr

A small, typed semantic layer. You declare **datasets** (one fact table each) with
**measures** and **dimensions**; callers (people, charts, an LLM tool) send a small JSON
query; the engine compiles it to SQL for your database, runs it through your driver and
returns shaped, typed rows.

- No SQL text in definitions: datasets are built from typed expression builders, so a
  renamed column, `avg` over a string or `between` on an enum fails typecheck.
- Database-neutral definitions: dialects plug in through the `Dialect` interface, and Postgres
  ships today (`measurr/postgres`).
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
per grouped dimension and a number or null per measure, with totals, `previous?`, `notes` and
`truncated`. `analytics.resultSchema(key)` is the same envelope with the dataset's fields, so a
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
`{ dataset, durationMs, rows, outcome: 'success' | 'error', cache?, error? }`. `dataset` is null
when the input named no known dataset, so free text from a model never becomes a metric label.
`cache` is `'hit'` or `'miss'` when a cache is configured. What the hook throws or rejects with is
swallowed; it cannot fail a query.

Each measure in `listDatasets` has a `valueType`: `count` (a whole number, never null),
`ratio` (0-1, from `share` and `ratio`) or `number` (sums, averages, medians), so a UI knows
to format a share as a percentage.

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
rejects is a miss or a skipped write, never a failed query. A changed measure keeps its key, so
prefix keys with a build id (as above) if old numbers must not outlive a deploy. A dataset that
uses `minutesAgo` is as stale as the time to live.

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
  default, pass `null` for averages). An all-time result has only the buckets it found. The
  previous period's points are on its own buckets; compare them by position.
- A grouped query returns at most `limit` rows (20 by default, 100 at most), and the shape keeps
  `truncated`. Set `limit: 100` for a series; 30 days split into three series fit, 90 days into
  eleven do not.
- `toDistribution`'s `total` is the measure over every row, so many-to-many shares can add up to
  more than 1. `toPivot` sorts numeric keys (weekdays, hours).

### Presentation

`presentKpi`, `presentTimeseries`, `presentDistribution` and `presentLeaderboard` turn a result
into the wire outputs a dashboard draws (`KpiOutput`, `TimeSeriesOutput`, `DistributionOutput`,
`LeaderboardOutput`; `TableOutput` and `PivotOutput` for outputs you build yourself). A missing
value is 0, keys are strings, and the caller picks labels, units and chart types:

```ts
presentKpi(result, 'paidShare', { label: 'Paid', percent: true })
// { kind: 'kpi', value: 25, unit: 'PERCENTAGE', label: 'Paid' }

presentTimeseries(result, {
	bucket: 'day', measure: 'orders', series: 'status',
	keys: { PAID: 'paid' }, // wire keys, by String(key); 'null' names the empty group
	labels: { paid: 'Settled' }, // labels by wire key
	chartType: 'line'
})
// points are { ts: Date, value }: ts is the bucket's local start date as UTC midnight

presentDistribution(result, { by: 'tag', measure: 'orders', chartType: 'donut', order: ['t2'] })
// total is what the segments add up to, percent is 0-100; keys order omits go last

presentLeaderboard(result, { by: 'region', measure: 'orders', meta: (values) => ({ revenue: values.revenue }) })
```

`isKpi`, `isTimeSeries`, `isDistribution`, `isTable`, `isLeaderboard` and `isPivot` narrow a
`MetricOutput`. The module is pure, so a browser bundle can import the types and guards.

## Dashboard metrics

`measurr/metrics` names the numbers a dashboard shows: one query and the output it is drawn
in. The registry runs a batch for a caller and streams one chunk per metric.

```ts
import { createMetricRegistry, metricDefiner } from 'measurr/metrics'
import { presentKpi, presentTimeseries } from 'measurr/shapes'

// Types only, so metric modules need not import the analytics instance.
export const defineMetric = metricDefiner<(typeof datasets)[number], Role>()

const orderTrend = defineMetric({
	key: 'orders.trend',
	kind: 'timeseries',
	description: 'Orders over time',
	allowedRoles: ['owner', 'member'],
	supportsTimeRange: true, // false for a snapshot: all time, no previous period
	filterSchema: z.object({ status: z.enum(['OPEN', 'PAID']).optional() }),
	query: ({ bucket, filters }) => ({
		dataset: 'orders',
		measures: ['orders'],
		groupBy: [bucket],
		filters: filters.status ? [{ dimension: 'status', op: 'in', values: [filters.status] }] : [],
		limit: 100
	}),
	shape: (result, { bucket }) =>
		presentTimeseries(result, { bucket, measure: 'orders', chartType: 'bar' })
})

export const metrics = createMetricRegistry({
	analytics,
	metrics: [orderTrend, orderCount] as const,
	canRun: (metric, ctx) => ctx.isSuperAdmin || (metric.allowedRoles ?? []).includes(ctx.role),
	onShapeError: (error, metric) => logger.error('metric.shape_failed', { key: metric.key, error })
})

const input = metrics.requestSchema.extend({ refresh: z.boolean().default(false) }).parse(body)
for await (const chunk of metrics.run(input, ctx)) send(chunk)
// { key, requestKey, result: { current, previous?, supportsTimeRange }, done }
// or { key, requestKey, error, done }
```

- `query` returns the query without `period` or `compareToPrevious`. The registry counts the
  local days `from` and `to` (instants) fall on in `analytics.timezone(ctx)`, all time without
  them, and always all time for a snapshot. `compareToPrevious` adds the previous period, whose
  series points are put on the current buckets so a chart overlays them.
- `granularity` (hour to year, inferred from the range when omitted: day up to 31 days, week up
  to 90, else month) picks `run.bucket`: `day`, `week` or `month`. Name time-bucket dimensions
  after them so `groupBy: [bucket]` works.
- A metric that `canRun` refuses (`'Access denied'`), whose filters do not parse with its
  `filterSchema` (`'Invalid filters: ...'`), whose query fails (the engine's message) or whose
  `shape` throws (`'The metric could not be drawn'`) fails alone. `done` marks the last chunk.
- Keys and outputs stay literal: a chunk narrows to its metric by `key`, and
  `MetricOutputOf<typeof metrics, 'orders.trend'>`, `MetricFiltersOf`, `MetricKeysOfKind` and
  `registry.get(key)` are typed per metric. `registry.available(ctx)` lists what `canRun`
  allows, for a catalog.

## Serving queries

`measurr/handler` serves queries from any server framework:

- `queryBatch(analytics, { total: q1, byStatus: q2 }, ctx)` runs named queries in parallel and
  resolves to `{ results, errors }`, typed per name. One failing query does not fail the
  others; an error other than `AnalyticsError` is reported as `{ code: 'internal' }` without
  its message.
- `streamBatch(analytics, queries, ctx)` yields `{ key, result }` or `{ key, error }` as each
  query finishes, for a streaming endpoint.
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
| Measure | `count`, `countWhere`, `countDistinct`, `sum`, `avg`, `median`, `share` (one condition over another) or `ratio` (one measure over another, after aggregation). Optionally restricted with `access`. |
| Dimension | `enum`, `computed` (closed value sets), `relation` (to-one), `manyToMany`, `number`, `timeBucket` (day, ISO week, month), `timePart` (ISO weekday, hour). Optionally restricted with `access`. |
| Query | `dataset`, 1-4 `measures`, 0-2 `groupBy`, `filters`, `period`, `time`, `compareToPrevious`, `sort` (by an asked measure or grouped dimension), `limit` (1-100, default 20). |
| Result | `{ period, rows, totals, previous?, notes, truncated }`; `period` is `{ from, to, timezone }` or `{ all: true, timezone }`. |

**Operators per dimension kind.** Closed and open dimensions take `in`, `notIn`, `isEmpty`
and `isNotEmpty`; numeric and time dimensions take `between`, `isEmpty` and `isNotEmpty`. The
query types and the generated schema both enforce this. `notIn` keeps rows without a value,
unlike SQL's `NOT IN`.

**Open values are keys or labels.** Filters on `relation` and `manyToMany` dimensions accept
keys or names (case-insensitive); the engine resolves them before planning. An unknown value
fails with `AnalyticsError('unknown_value')` listing the valid values, so a model can retry
once.

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
to `EXISTS`, so they never multiply rows either.

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
`Dialect`, `SqlRenderer` and `AnalyticsSource` contracts; `postgresDialect`,
`checkDatasetContract` / `assertDatasetContract`; `measurr/shapes` (`toKpi`, `toTimeseries`,
`toDistribution`, `toPivot`, `toLeaderboard`) and `measurr/handler` (`queryBatch`,
`streamBatch`, `toHttpError`); and the types `AnalyticsQuery`, `AnalyticsResult`,
`ResultPeriod`, `PeriodInput`, `Tenant`, `TenantId`, `AccessKey`, `AnalyticsCache`, `FieldKey`,
`Ratio`, `AnalyticsError` codes and their details (`isAnalyticsError`). `ExprNode` and
`SelectStatement` are exported for dialect authors and may grow new node kinds. The
presenters and wire outputs in `measurr/shapes`, `measurr/metrics` and `analytics.timezone`
are new and may still change before they join this list.

## Install

```sh
npm install measurr zod
```

`zod` 4 is a peer dependency. The types need TypeScript 6 or newer.

## Development

```sh
bun install
bun run lint   # types and Biome
bun test
# With a throwaway Postgres (the integration test creates and drops its own tables):
ANALYTICS_TEST_DATABASE_URL=postgres://... bun test
bun run build && bun run verify:package
```

The integration test reads `ANALYTICS_TEST_DATABASE_URL`, not `DATABASE_URL`, because Bun
loads `.env` files and that name may point at a real database. CI runs it against Postgres 17.

Releases are automated with Release Please; see [docs/releasing.md](docs/releasing.md).

## License

MIT
