/**
 * How a model should use an analytics query tool, as markdown bullets for its instructions.
 * It does not name the tool, so add a line that does.
 */
export const analyticsToolGuidance = `- Answer every "how many", "how much", "per week" or "split by" question with the analytics tool. Never count by hand from lists or pages.
- Pick the dataset whose description matches the question, the fewest measures that answer it and at most two groupings.
- Say which period and filters the numbers cover, using the dates in the result ("1-30 September").
- Compare with the previous period (compareToPrevious) when the change is the point, such as "is it going up".
- When the result has notes (overlapping rows, such as a record counted once per tag), say so in a few words.
- Ask one short question only when the period is genuinely ambiguous ("this season") and someone can answer; otherwise take the natural reading and state it.`
