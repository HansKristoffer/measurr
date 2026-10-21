import { defineDataset, dimension, eq, measure, table } from '../index.js'

/** Device status reports in ClickHouse, joined to the units they came from. */
export type Status = {
	unitId: string
	createdAt: Date
	sprays: number
	batteryLevel: number
	liquidLow: number
}

export type Unit = {
	unitId: string
	organizationId: string | null
	placementType: 'OFFICE' | 'TOILET' | null
	name: string
}

const status = table<Status>('statuses')
const unit = status.leftJoin(table<Unit>('units'), (u) =>
	eq(u.col('unitId'), status.col('unitId'))
)

export const sprays = defineDataset({
	key: 'sprays',
	label: 'Sprays',
	description: 'One row per status report a unit sent.',
	from: status,
	tenantColumn: unit.col('organizationId'),
	time: { reported: { column: status.col('createdAt'), label: 'Reported' } },
	measures: {
		sprays: measure.sum(status.col('sprays'), { label: 'Sprays' }),
		reports: measure.count({ label: 'Reports' }),
		units: measure.countDistinct(status.col('unitId'), { label: 'Units' }),
		averageBattery: measure.avg(status.col('batteryLevel'), {
			label: 'Average battery'
		}),
		medianBattery: measure.median(status.col('batteryLevel'), {
			label: 'Median battery'
		}),
		lowLiquidShare: measure.share({
			label: 'Reports with low liquid',
			numerator: eq(status.col('liquidLow'), 1)
		}),
		spraysPerUnit: measure.ratio('sprays', 'units', {
			label: 'Sprays per unit'
		}),
		spraysPerDay: measure.resolved({
			label: 'Sprays per day',
			result: 'number',
			uses: ['sprays']
		})
	},
	dimensions: {
		placement: dimension.enum(
			unit.col('placementType'),
			{ OFFICE: 'OFFICE', TOILET: 'TOILET' },
			{
				label: 'Placement',
				labels: { OFFICE: 'Office', TOILET: 'Toilet' },
				empty: 'No placement'
			}
		),
		unit: dimension.relation({
			label: 'Unit',
			key: unit.col('unitId'),
			name: unit.col('name')
		}),
		battery: dimension.number(status.col('batteryLevel'), {
			label: 'Battery'
		}),
		day: dimension.timeBucket('reported', 'day'),
		week: dimension.timeBucket('reported', 'week'),
		month: dimension.timeBucket('reported', 'month'),
		weekday: dimension.timePart('reported', 'isodow'),
		hour: dimension.timePart('reported', 'hour')
	}
})
